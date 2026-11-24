/**
 * Luật thuần của category, attribute sàn và spec sản phẩm (#400, Documents/21 §18.5, Documents/19 mục 3.3). Không I/O.
 */
import { type AxisGroup, axisGroups, CUSTOM_AXIS, joinValues, targetCombinable } from './axis-combine.ts';

export type AttributeKind = 'sales' | 'property';
export type AttributeInput = 'select' | 'multiselect' | 'text' | 'number' | 'date' | 'image' | 'cascade';
/** Tab của form: `category` lưu trong spec; `product` là cột của catalog (xuất xứ, thương hiệu); `company` lấy từ hồ sơ công ty. */
export type AttributeTier = 'category' | 'product' | 'company';
export type CategoryPermission = 'available' | 'invite_only' | 'non_main_category' | 'prohibited';
export type SpecCategoryStatus = 'ok' | 'changed' | 'removed';
/** Giá trị attribute trong spec: chuỗi (text, mã lựa chọn của select) hoặc mảng mã (multiselect). */
export type SpecAttributeValue = string | string[];

/** Nguồn của một attribute trong spec (#497, Documents/21 §18.5): đẩy (bản chép, lưu trước #497), đọc từ sàn khi ghép, người dùng sửa. */
export type FieldSource = 'push' | 'match' | 'user';

/**
 * Bản sàn đang ghi ở lần đọc gần nhất khi ghép SKU (#497, cột `product_specs.remote_facts`): giá trị đã chuẩn hoá theo catalog
 * (xuất xứ là mã ISO, mô tả chữ trơn, cân nặng g, kích thước mm theo SKU Commerio đã ghép). `shopName` là tên gian hàng lúc
 * đọc, dùng khi gian hàng đã xoá.
 */
export interface RemoteSpecFacts {
  shopName: string | null;
  originCountry: string | null;
  brand: string | null;
  description: string | null;
  sizeChartUrl: string | null;
  imageUrls: string[];
  variants: { variantId: string; weightG: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null }[];
}

/** Hai giá trị attribute bằng nhau; chọn nhiều so như tập (đổi thứ tự không phải sửa). */
const canonical = (v: SpecAttributeValue | undefined) => JSON.stringify(Array.isArray(v) ? [...v].sort() : (v ?? null));
const sameValue = (a: SpecAttributeValue | undefined, b: SpecAttributeValue | undefined) => canonical(a) === canonical(b);

/**
 * Nguồn từng attribute sau khi người dùng lưu spec (#497): attribute giữ nguyên giá trị thì giữ nguồn cũ (thiếu thì nguồn cũ
 * của cả spec), đổi hoặc mới thì `user`; attribute đã bỏ thì bỏ khỏi bảng nguồn.
 */
export function nextFieldSources(
  before: { attributes: Record<string, SpecAttributeValue>; fieldSources: Record<string, FieldSource>; source: 'push' | 'match' } | undefined,
  attributes: Record<string, SpecAttributeValue>,
): Record<string, FieldSource> {
  const out: Record<string, FieldSource> = {};
  for (const code of Object.keys(attributes)) {
    out[code] = before && sameValue(before.attributes[code], attributes[code]) ? (before.fieldSources[code] ?? before.source) : 'user';
  }
  return out;
}

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

/** Trục phân loại tự đặt, không ánh xạ sang sales attribute nào của sàn (khai ở `axis-combine.ts` để hai file không import vòng). */
export { CUSTOM_AXIS } from './axis-combine.ts';

/**
 * Loại thuộc tính phân loại của catalog (`attributes.platform_kind`) dùng để ghép trục với sales attribute của sàn (#448).
 * Trùng `PLATFORM_KINDS` của catalog (#531, 23 kind); `service/product-port.ts` kiểm hai union bằng nhau lúc typecheck.
 */
// prettier-ignore
export const PLATFORM_KINDS = [
  'color', 'size', 'shoe_size', 'bra_size', 'age', 'ring_size',
  'storage', 'version', 'screen_size', 'connector', 'length', 'battery_capacity',
  'voltage', 'power', 'volume', 'weight', 'flavor', 'scent',
  'pack', 'diaper_size', 'bed_size', 'style', 'compatible_model',
] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

/**
 * Khả năng khai biến thể của một category (#448, Documents/21 §18.8.3): số trục tối đa, sàn có nhận tên trục tự đặt không,
 * sales attribute bắt buộc phải có trong `axisMap`.
 */
export interface VariantCapabilities {
  maxAxes: number;
  customAxisName: boolean;
  salesRequired: string[];
  /** Thêm phân loại vào sản phẩm sàn đã có (`addVariants`, Documents/21 §18.8.4) */
  addVariant: boolean;
  /** Số ký tự tối đa của một giá trị phân loại; null khi sàn không công bố. Chỉ kiểm trên thuộc tính biến thể ghép (#568) */
  maxValueLength: number | null;
  /** Số giá trị tối đa của một thuộc tính biến thể; null khi sàn không công bố. Chỉ kiểm trên thuộc tính biến thể ghép (#568) */
  maxAxisValues: number | null;
  /** Số ký tự (code point) tối đa của tên thuộc tính biến thể tự đặt; null khi sàn không công bố. Chỉ kiểm trục `__custom` (#572) */
  maxAxisNameLength: number | null;
}

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

/**
 * Attribute của spec dựng từ sản phẩm trên sàn (#400 lát 12, ghép SKU): chỉ attribute `tier = 'category'`, `kind = 'property'`
 * của leaf (xuất xứ, thương hiệu ở catalog; trục ở `axis_map`). Lựa chọn đổi sang mã của leaf theo mã giá trị sàn trả rồi theo
 * nhãn (`resolveOption`; multiselect dạng chuỗi nối dấu phẩy thì tách); không khớp mà attribute cho tự nhập thì giữ nhãn, không thì bỏ. Ô nhập chữ, số, ngày lấy giá trị đầu.
 * Cascade, ảnh bỏ (người dùng chọn lại). Leaf chưa có attribute: rỗng.
 */
export function remoteSpecAttributes(
  leaf: readonly PlatformAttribute[] | null,
  remote: readonly { code: string; values: readonly { id: string | null; name: string }[] }[],
): Record<string, SpecAttributeValue> {
  const out: Record<string, SpecAttributeValue> = {};
  if (!leaf) return out;
  const byCode = new Map(remote.map((r) => [r.code, r.values]));
  for (const a of leaf) {
    if (a.tier !== 'category' || a.kind !== 'property') continue;
    const values = byCode.get(a.code);
    if (!values?.length) continue;
    const known = (v: { id: string | null; name: string }) => (v.id !== null ? resolveOption(a, v.id) : null) ?? resolveOption(a, v.name);
    const pick = (v: { id: string | null; name: string }) => known(v) ?? (a.allowCustom && v.name.trim() ? v.name.trim() : null);
    if (a.input === 'select') {
      const id = pick(values[0]!);
      if (id) out[a.code] = id;
    } else if (a.input === 'multiselect') {
      // Lazada có thể trả nhiều lựa chọn trong một chuỗi nối dấu phẩy (cách app gửi lên, review BE2 P2-8): không khớp nguyên
      // chuỗi thì tách từng phần.
      const parts = values.flatMap((v) =>
        known(v) === null && v.name.includes(',') ? v.name.split(',').map((name) => ({ id: null, name: name.trim() })).filter((p) => p.name) : [v],
      );
      const ids = [...new Set(parts.map(pick).filter((x): x is string => x !== null))];
      if (ids.length) out[a.code] = ids;
    } else if (a.input === 'text' || a.input === 'number' || a.input === 'date') {
      const text = values[0]!.name.trim();
      if (text) out[a.code] = text;
    }
  }
  return out;
}

export const MISSING_REASONS = [
  'required',
  'required_when',
  'axis_unmapped',
  'category_changed',
  'category_removed',
  'sales_required',
  'axis_shape',
  'axis_value_too_long',
  'axis_too_many_values',
  'axis_name_too_long',
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];
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
  /** Giá trị đã tính từ mọi nguồn (`resolved`, #509): có giá trị thì attribute không tính là thiếu. */
  fallbacks?: Readonly<Record<string, SpecAttributeValue | null | undefined>>;
  /** Khả năng khai biến thể của category (#448); không có (null) thì không xét `sales_required`, `axis_shape`, `__custom` luôn hợp lệ. */
  caps?: VariantCapabilities | null;
  /** Giá trị trục của từng SKU (attributeId → nhãn), để kiểm giá trị của thuộc tính biến thể ghép (#568). */
  variants?: readonly Readonly<Record<string, string>>[];
  /** Tên sàn trong câu báo (`adapter.name`). */
  platformName?: string;
}

const hasValue = (v: SpecAttributeValue | string | null | undefined): boolean =>
  Array.isArray(v) ? v.some((x) => x.trim() !== '') : typeof v === 'string' && v.trim() !== '';

const CATEGORY_CODE = 'externalCategoryId';

/** Nhãn của ô trong `missing`: attribute `tier = 'product'` (xuất xứ, thương hiệu) điền ở trang sản phẩm (AC-15, review BE2 P2-7). */
const missingLabel = (a: Pick<PlatformAttribute, 'label' | 'tier'>) => (a.tier === 'product' ? `${a.label} (điền ở trang sản phẩm)` : a.label);

/**
 * Phần còn thiếu của spec (`missing` của `21` §18.5), tính theo attribute hiện tại của leaf: category đổi hay bị bỏ; attribute
 * bắt buộc, bắt buộc theo điều kiện chưa có giá trị (sales attribute không tính `required`, chỉ kiểm qua trục); trục phân loại
 * chưa ánh xạ hoặc trỏ tới sales attribute leaf không còn.
 */
export function specMissing(input: SpecMissingInput): MissingItem[] {
  const { spec, attributes, axes, fallbacks = {}, caps = null } = input;
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
        out.push({ code: a.code, label: missingLabel(a), reason: 'required' });
      } else if (a.requiredWhen?.some((c) => conditionMet(c, spec.attributes[c.code]))) {
        out.push({ code: a.code, label: missingLabel(a), reason: 'required_when' });
      }
    }
  }
  const salesCodes = attributes ? new Set(attributes.filter((a) => a.kind === 'sales').map((a) => a.code)) : null;
  const groups = axisGroups(spec.axisMap, axes.map((a) => a.attributeId));
  const combined = groups.filter((g) => g.attributeIds.length > 1);
  for (const axis of axes) {
    const target = spec.axisMap[axis.attributeId];
    const customOk = target === CUSTOM_AXIS && (caps === null || caps.customAxisName);
    const mapped = target != null && (customOk || (target !== CUSTOM_AXIS && (salesCodes === null || salesCodes.has(target))));
    if (!mapped) {
      out.push({ code: axis.attributeId, label: axis.name, reason: 'axis_unmapped' });
    } else if (combined.some((g) => g.attributeIds.includes(axis.attributeId)) && !targetCombinable(target, attributes)) {
      // Spec lưu trước khi leaf đổi: đích không còn nhận chữ ghép thì chọn lại trục (#568)
      out.push({ code: axis.attributeId, label: `${axis.name} (thuộc tính biến thể đích không nhận chữ ghép)`, reason: 'axis_unmapped' });
    }
  }
  if (caps) {
    const used = new Set(Object.values(spec.axisMap));
    for (const code of caps.salesRequired) {
      if (used.has(code)) continue;
      const label = attributes?.find((a) => a.code === code)?.label ?? code;
      out.push({ code, label, reason: 'sales_required' });
    }
    // Đếm thuộc tính biến thể sẽ gửi sàn: mỗi đích một cái; trục chưa ánh xạ tính riêng (#568)
    const count = groups.length + axes.filter((a) => !spec.axisMap[a.attributeId]).length;
    if (count > caps.maxAxes) {
      out.push({ code: 'axes', label: `Sản phẩm có ${count} trục, category này nhận tối đa ${caps.maxAxes}`, reason: 'axis_shape' });
    }
    out.push(...combinedLimits(combined, input.variants ?? [], caps, input.platformName ?? 'sàn'));
    if (caps.maxAxisNameLength !== null) {
      const max = caps.maxAxisNameLength;
      for (const axis of axes) {
        const n = [...axis.name].length;
        if (spec.axisMap[axis.attributeId] === CUSTOM_AXIS && n > max) {
          const label = `Tên thuộc tính biến thể “${axis.name}” dài ${n} ký tự, ${input.platformName ?? 'sàn'} nhận tối đa ${max}`;
          out.push({ code: axis.attributeId, label, reason: 'axis_name_too_long' });
        }
      }
    }
  }
  return out;
}

/** Giá trị ghép quá dài, quá nhiều giá trị trên thuộc tính biến thể ghép: chặn, không tự rút gọn (#568, Thành chốt 24/11/2026). */
function combinedLimits(
  combined: readonly AxisGroup[],
  variants: readonly Readonly<Record<string, string>>[],
  caps: VariantCapabilities,
  platformName: string,
): MissingItem[] {
  const out: MissingItem[] = [];
  for (const g of combined) {
    const values = new Set<string>();
    for (const v of variants) {
      const labels = g.attributeIds.map((id) => v[id]);
      if (labels.every((x): x is string => x !== undefined)) values.add(joinValues(labels));
    }
    if (caps.maxValueLength !== null) {
      for (const value of values) {
        const n = [...value].length;
        if (n > caps.maxValueLength) {
          out.push({ code: g.target, label: `Giá trị “${value}” dài ${n} ký tự, ${platformName} nhận tối đa ${caps.maxValueLength}`, reason: 'axis_value_too_long' });
        }
      }
    }
    if (caps.maxAxisValues !== null && values.size > caps.maxAxisValues) {
      out.push({
        code: g.target,
        label: `Thuộc tính biến thể ghép có ${values.size} giá trị, ${platformName} nhận tối đa ${caps.maxAxisValues}`,
        reason: 'axis_too_many_values',
      });
    }
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
