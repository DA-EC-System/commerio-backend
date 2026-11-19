/**
 * Luật thuần của category, attribute sàn và spec sản phẩm (#400, Documents/21 §18.5, Documents/19 mục 3.3). Không I/O.
 */

export type AttributeKind = 'sales' | 'property';
export type AttributeInput = 'select' | 'multiselect' | 'text' | 'number' | 'date' | 'image' | 'cascade';
/** Tab của form: `category` lưu trong spec; `product` là cột của catalog (xuất xứ, thương hiệu); `company` lấy từ hồ sơ công ty. */
export type AttributeTier = 'category' | 'product' | 'company';
export type CategoryPermission = 'available' | 'invite_only' | 'non_main_category' | 'prohibited';
export type SpecCategoryStatus = 'ok' | 'changed' | 'removed';
/** Giá trị attribute trong spec: chuỗi (text, mã lựa chọn của select) hoặc mảng mã (multiselect). */
export type SpecAttributeValue = string | string[];

export interface AttributeOption {
  id: string;
  label: string;
}

/** Điều kiện bắt buộc theo attribute khác (TikTok `requirement_conditions`): bắt buộc khi `code` mang một trong `optionIds`
 * (id lựa chọn; Documents/21 §18.5, Documents/19 §3.3 cột `required_when`). */
export interface RequiredWhen {
  code: string;
  optionIds: string[];
}

/** Attribute của một leaf category sau khi adapter chuẩn hoá (một dòng `channel.platform_category_attributes`). */
export interface PlatformAttribute {
  code: string;
  label: string;
  kind: AttributeKind;
  input: AttributeInput;
  options: AttributeOption[];
  allowCustom: boolean;
  required: boolean;
  requiredWhen: RequiredWhen[] | null;
  isKey: boolean;
  tier: AttributeTier;
  /** Bản gốc của sàn (Lazada giữ `options[].en_name` ở đây). */
  raw: Record<string, unknown>;
}

/** Trục phân loại tự đặt, không ánh xạ sang sales attribute nào của sàn. */
export const CUSTOM_AXIS = '__custom';

/**
 * Chuẩn hoá đường dẫn để tìm không dấu: bỏ dấu (NFD), đổi `đ`/`Đ` → `d` (NFD không tách `đ`, G2.14), chữ thường, gộp khoảng
 * trắng. Dùng cho cột `path_search` và chuỗi tìm của người dùng.
 */
export function normalizePath(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const fold = (s: string) => s.trim().toLowerCase();

/** Tên tiếng Anh của lựa chọn trong bản gốc của sàn (Lazada `options[].en_name`), theo mã lựa chọn. */
function englishLabels(attr: Pick<PlatformAttribute, 'raw'>): Map<string, string> {
  const raw = attr.raw['options'];
  const out = new Map<string, string>();
  if (!Array.isArray(raw)) return out;
  for (const o of raw as unknown[]) {
    if (o && typeof o === 'object') {
      const { id, en_name: en } = o as { id?: unknown; en_name?: unknown };
      if ((typeof id === 'string' || typeof id === 'number') && typeof en === 'string') out.set(String(id), en);
    }
  }
  return out;
}

/**
 * Mã lựa chọn của sàn ứng với một giá trị (A9): so `id`, rồi nhãn, rồi tên tiếng Anh trong bản gốc (`en_name`), không phân
 * biệt hoa thường. Giá trị chép từ ghép danh mục là nhãn tiếng Việt; Lazada `/product/item/get` trả nhãn tiếng Anh.
 * Không khớp thì null.
 */
export function resolveOption(attr: Pick<PlatformAttribute, 'options' | 'raw'>, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  const byId = attr.options.find((o) => o.id === v);
  if (byId) return byId.id;
  const byLabel = attr.options.find((o) => fold(o.label) === fold(v));
  if (byLabel) return byLabel.id;
  for (const [id, en] of englishLabels(attr)) {
    if (fold(en) === fold(v) && attr.options.some((o) => o.id === id)) return id;
  }
  return null;
}

export type MissingReason = 'required' | 'required_when' | 'axis_unmapped' | 'category_changed' | 'category_removed';
export interface MissingItem {
  code: string;
  label: string;
  reason: MissingReason;
}

export interface SpecMissingInput {
  spec: {
    attributes: Record<string, SpecAttributeValue>;
    axisMap: Record<string, string>;
    categoryStatus: SpecCategoryStatus;
  };
  /** Attribute hiện có của leaf; null khi chưa lấy về (request đẩy cho qua, việc nền lấy rồi kiểm lại, A16). */
  attributes: readonly PlatformAttribute[] | null;
  /** Trục phân loại của sản phẩm (attributeId, tên trục). */
  axes: readonly { attributeId: string; name: string }[];
  /**
   * Giá trị lúc đẩy sẽ tự điền khi spec không có: hồ sơ công ty (`tier = 'company'`), xuất xứ, thương hiệu của catalog
   * (`tier = 'product'`; Lazada `brand` trống thì "No Brand"). Có giá trị dự phòng thì attribute không tính là thiếu.
   */
  fallbacks?: Readonly<Record<string, string | null | undefined>>;
}

const hasValue = (v: SpecAttributeValue | string | null | undefined): boolean =>
  Array.isArray(v) ? v.some((x) => x.trim() !== '') : typeof v === 'string' && v.trim() !== '';

const CATEGORY_CODE = 'externalCategoryId';

/**
 * Phần còn thiếu của spec (`missing` của `21` §18.5), tính theo attribute hiện tại của leaf: category đổi hay bị bỏ; attribute
 * bắt buộc, bắt buộc theo điều kiện chưa có giá trị (sales attribute không tính `required`, chỉ kiểm qua trục); trục phân loại
 * chưa ánh xạ hoặc trỏ tới sales attribute leaf không còn.
 */
export function specMissing(input: SpecMissingInput): MissingItem[] {
  const { spec, attributes, axes, fallbacks = {} } = input;
  const out: MissingItem[] = [];
  if (spec.categoryStatus === 'changed') {
    out.push({ code: CATEGORY_CODE, label: 'Category trên sàn đã đổi, chọn lại category', reason: 'category_changed' });
  } else if (spec.categoryStatus === 'removed') {
    out.push({ code: CATEGORY_CODE, label: 'Category đã bị sàn bỏ, chọn category khác', reason: 'category_removed' });
  }
  if (attributes) {
    for (const a of attributes) {
      if (a.kind === 'sales') continue;
      if (hasValue(spec.attributes[a.code]) || hasValue(fallbacks[a.code])) continue;
      if (a.required) {
        out.push({ code: a.code, label: a.label, reason: 'required' });
      } else if (a.requiredWhen?.some((c) => conditionMet(c, spec.attributes[c.code]))) {
        out.push({ code: a.code, label: a.label, reason: 'required_when' });
      }
    }
  }
  const salesCodes = attributes ? new Set(attributes.filter((a) => a.kind === 'sales').map((a) => a.code)) : null;
  for (const axis of axes) {
    const target = spec.axisMap[axis.attributeId];
    const mapped = target != null && (target === CUSTOM_AXIS || salesCodes === null || salesCodes.has(target));
    if (!mapped) out.push({ code: axis.attributeId, label: axis.name, reason: 'axis_unmapped' });
  }
  return out;
}

function conditionMet(c: RequiredWhen, value: SpecAttributeValue | undefined): boolean {
  if (value == null) return false;
  const values = Array.isArray(value) ? value : [value];
  return values.some((v) => c.optionIds.includes(v));
}

const PERMISSION_PRIORITY: readonly [string, CategoryPermission][] = [
  ['PROHIBITED', 'prohibited'],
  ['INVITE_ONLY', 'invite_only'],
  ['NON_MAIN_CATEGORY', 'non_main_category'],
];

/**
 * Gộp `permission_statuses` của TikTok về một quyền (A17): có `AVAILABLE` thì `available`; không thì theo ưu tiên
 * `PROHIBITED` > `INVITE_ONLY` > `NON_MAIN_CATEGORY`. Mảng rỗng hoặc toàn mã lạ: null (không ghi dòng, không chặn).
 */
export function permissionOf(statuses: readonly string[]): CategoryPermission | null {
  const set = new Set(statuses.map((s) => s.toUpperCase()));
  if (set.has('AVAILABLE')) return 'available';
  for (const [code, permission] of PERMISSION_PRIORITY) if (set.has(code)) return permission;
  return null;
}

/**
 * Tên nước sàn viết khác `Intl.DisplayNames` (vi, en) → mã ISO alpha-2 (A19). Khoá đã qua `normalizePath`. Đo trên
 * TikTok `100149` (203 giá trị) và Lazada `country_origin_hb` (247–249 lựa chọn) ngày 18/11/2026; sàn thêm giá trị mới
 * thì test fixture đỏ khi cập nhật fixture.
 */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  'trinidad and tobago': 'TT',
  y: 'IT',
  'the bahamas': 'BS',
  'east timor (timor-leste)': 'TL',
  'the gambia': 'GM',
  'korea, south': 'KR',
  'korea, north': 'KP',
  'the democratic republic of the congo': 'CD',
  'congo, democratic republic of': 'CD',
  'congo, cong hoa dan chu': 'CD',
  'the republic of the congo': 'CG',
  congo: 'CG',
  'saint lucia': 'LC',
  // TikTok dịch máy "Turkey" thành "Gà tây".
  'ga tay': 'TR',
  'trung quoc dai luc': 'CN',
  'czech republic': 'CZ',
  'cong hoa sec': 'CZ',
  'antigua and barbuda': 'AG',
  'bosnia and herzegovina': 'BA',
  'saint vincent and the grenadines': 'VC',
  'saint vincent va grenadines': 'VC',
  'saint kitts and nevis': 'KN',
  'saint kitts va nevis': 'KN',
  'cabo verde': 'CV',
  'sao tome and principe': 'ST',
  'micronesia, federated states of': 'FM',
  "cote d'ivoire": 'CI',
  'bo bien nga': 'CI',
  swaziland: 'SZ',
  'brunei darussalam': 'BN',
  "lao people's democratic republic": 'LA',
  pitcairn: 'PN',
  'saint barthelemy': 'BL',
  'united states minor outlying islands': 'UM',
  'cac dao nho xa xoi cua hoa ky': 'UM',
  myanmar: 'MM',
  'hong kong': 'HK',
  'ma cao': 'MO',
  macau: 'MO',
  // Lazada tách Anh, Scotland khỏi Vương quốc Anh; gửi lên sàn thì `GB` chọn "Vương quốc Anh" (khớp Intl trước bí danh).
  anh: 'GB',
  england: 'GB',
  scotland: 'GB',
  'virgin islands (u.s.)': 'VI',
  'quan dao virgin (hoa ky)': 'VI',
  'virgin islands (british)': 'VG',
  'quan dao virgin (anh)': 'VG',
  'st. pierre and miquelon': 'PM',
  'st. pierre va miquelon': 'PM',
  'heard and mcdonald islands': 'HM',
  'svalbard and jan mayen islands': 'SJ',
  'quan dao svalbard va jan mayen': 'SJ',
  'saint-martin (france)': 'MF',
  'saint-martin (phap)': 'MF',
  'saint-martin (pays-bas)': 'SX',
  's. georgia & the s. sandwich isl.': 'GS',
  's. georgia va dao s. sandwich': 'GS',
  'wallis and futuna islands': 'WF',
  'quan dao wallis va futuna': 'WF',
  'saint helena': 'SH',
  vatican: 'VA',
  'slovakia (slovak republic)': 'SK',
  'slovakia (cong hoa slovakia)': 'SK',
  'palestine state': 'PS',
  'nha nuoc palestine': 'PS',
};

/** Giá trị xuất xứ của sàn không ứng với nước nào: không bao giờ chọn khi đổi từ ISO. */
export const NOT_COUNTRY_LABELS: ReadonlySet<string> = new Set(['khac', 'other', 'chau au', 'asia']);

/** Mã vùng có trong Intl mà không phải nước (khối, mã giả). */
const NON_COUNTRY_CODES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'XA', 'XB']);

interface CountryNames {
  /** Tên tiếng Việt chuẩn hoá → ISO. */
  vi: Map<string, string>;
  /** Tên Intl (vi, en) chuẩn hoá → ISO. */
  intl: Map<string, string>;
}

let countryNames: CountryNames | null = null;

function names(): CountryNames {
  if (countryNames) return countryNames;
  const vi = new Intl.DisplayNames(['vi'], { type: 'region', fallback: 'none' });
  const en = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const viMap = new Map<string, string>();
  const intl = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NON_COUNTRY_CODES.has(code)) continue;
      // Mã cũ (DD, UK, YU…) trùng tên mã hiện hành: chỉ giữ mã chuẩn.
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      const v = vi.of(code);
      const e = en.of(code);
      if (v && v !== code) {
        viMap.set(normalizePath(v), code);
        intl.set(normalizePath(v), code);
      }
      if (e && e !== code) intl.set(normalizePath(e), code);
    }
  }
  countryNames = { vi: viMap, intl };
  return countryNames;
}

/** Mã ISO của một nhãn nước của sàn (nhãn, tên tiếng Anh nếu có); không nhận ra hoặc "không phải nước" thì null. */
export function isoOfCountryLabel(label: string, enLabel?: string | null): string | null {
  const keys = [label, enLabel].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(normalizePath);
  if (keys.some((k) => NOT_COUNTRY_LABELS.has(k))) return null;
  const { intl } = names();
  for (const k of keys) {
    const code = intl.get(k) ?? COUNTRY_ALIASES[k];
    if (code) return code;
  }
  return null;
}

/**
 * Lựa chọn xuất xứ của sàn ứng với mã ISO của catalog (A19). Nhiều lựa chọn cùng một nước thì ưu tiên nhãn trùng tên tiếng
 * Việt của Intl, rồi tên Intl khác, rồi bí danh. Không khớp thì null (không đoán).
 */
export function countryOption(
  iso: string,
  options: readonly { id: string; label: string; enLabel?: string | null }[],
): string | null {
  const code = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const { vi, intl } = names();
  let best: { id: string; rank: number } | null = null;
  for (const o of options) {
    if (isoOfCountryLabel(o.label, o.enLabel) !== code) continue;
    const label = normalizePath(o.label);
    const en = o.enLabel ? normalizePath(o.enLabel) : null;
    const rank = vi.get(label) === code ? 0 : intl.get(label) === code || (en !== null && intl.get(en) === code) ? 1 : 2;
    if (!best || rank < best.rank) best = { id: o.id, rank };
  }
  return best?.id ?? null;
}

/**
 * Chốt chặn cây thiếu bất thường (review BE1 P2-3): lượt đồng bộ sắp đánh `removed` hơn 5% số node `active` đã đồng bộ thì
 * từ chối ghi. Lý do chọn: sàn thêm, bỏ category theo đợt nhỏ (vài chục node mỗi lần đổi), 5% của cây Lazada thật (3524
 * node, đo 19/11/2026) là 176 node, cao hơn hẳn mức đổi thường; còn cây TikTok mượn gian hàng chỉ được phép vài nhóm
 * category, hay phản hồi cụt, sẽ mất hàng chục phần trăm. Cây dưới 100 node (sàn mới, lần đầu) không xét: lệch vài node
 * đã quá 5%. Sàn tái cấu trúc thật (vd đổi phiên bản cây) thì người vận hành chạy lại với `allowShrink`.
 */
export const TREE_SHRINK_MAX_RATIO = 0.05;
export const TREE_SHRINK_MIN_ACTIVE = 100;

export function treeShrinkBlocked(activeBefore: number, removing: number): boolean {
  return activeBefore >= TREE_SHRINK_MIN_ACTIVE && removing > activeBefore * TREE_SHRINK_MAX_RATIO;
}
