// Bản soạn trước của sản phẩm mới trên đề nghị nhập (Documents/21 mục 16.3 "Bản soạn trước", 29 bước 1): purchasing giữ
// bảng, catalog giữ luật. Ba việc: kiểm nội dung lúc PUT (cùng luật `PUT /catalog/products/:id`), tính phần còn thiếu
// trên bản soạn (như độ hoàn thiện 17.1), chép sang sản phẩm khi ghi sổ phiếu nhận tạo cha và khi mỗi SKU sinh ra.
// Mọi hàm chạy trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { fileProblem, recordAudit } from '../../../core/index.ts';
import { MISSING_FIELDS, type MissingField, readinessOf } from '../domain/labels.ts';
import { replaceProductImages } from '../repository/product-images.ts';
import { findProduct, lockProduct, setSizeChart, touchProduct, updateProductIfVersion } from '../repository/products.ts';
import { findTemplateFields } from '../repository/specs.ts';
import { upsertVariantImage } from '../repository/variant-images.ts';
import { findVariants, updateVariantIfVersion } from '../repository/variants.ts';
import { applySpecs, checkSpecs, type SpecValueInput } from './product-specs.ts';
import { MAX_PRODUCT_IMAGES } from './product-images.ts';

/** Phần sản phẩm của bản soạn (21 mục 16.3 `ProductDraft`); khoá vắng mặt là không đổi. */
export interface DraftContent {
  description: string | null;
  brand: string | null;
  originCountry: string | null;
  imageFileIds: readonly string[];
  sizeChartFileId: string | null;
  specs: readonly SpecValueInput[];
  imageAxis: string | null;
  optionImages: readonly { axis: string; value: string; fileId: string }[];
}

/** Số của biến thể (21 `VariantFacts`): tiền là chuỗi thập phân, số đo là số nguyên dương. */
export interface DraftFacts {
  standardPrice?: string | null;
  targetNetPrice?: string | null;
  weightG?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  minQty?: number | null;
}

/** Hình của cha mới theo các dòng đề nghị: danh mục, tên trục theo thứ tự, mọi tổ hợp. */
export interface DraftShape {
  groupId: string | null;
  axes: readonly string[];
  combos: readonly Record<string, string>[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Giá trị của một trục trong các tổ hợp (giữ chữ của lần đầu). */
function valuesOf(shape: DraftShape, axis: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const combo of shape.combos) {
    for (const [a, v] of Object.entries(combo)) if (norm(a) === norm(axis) && !result.has(norm(v))) result.set(norm(v), v);
  }
  return result;
}

/**
 * Kiểm phần sản phẩm lúc `PUT /purchasing/product-drafts/:id` (21 mục 16.3): ảnh `product_image` của công ty đã tải
 * xong, tối đa 9 (`errors.imageFileIds`); bảng kích cỡ (`errors.sizeChartFileId`); thông số như `PUT /products`
 * (`errors["specs.<i>"]`); `imageAxis` là tên một trục của cha (`errors.imageAxis`); `optionImages` cùng trục với
 * `imageAxis`, giá trị có trên dòng, tệp hợp lệ (`errors["optionImages.<i>"]`). Chỉ kiểm khoá có gửi. Không ghi gì.
 */
export async function checkPurchaseDraft(shape: DraftShape, content: Partial<DraftContent>): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (content.imageFileIds?.length) {
    const problem = await fileProblem(content.imageFileIds, 'product_image', MAX_PRODUCT_IMAGES);
    if (problem) errors.imageFileIds = problem;
  }
  if (content.sizeChartFileId) {
    const problem = await fileProblem([content.sizeChartFileId], 'product_image', 1);
    if (problem) errors.sizeChartFileId = problem;
  }
  if (content.specs?.length) Object.assign(errors, (await checkSpecs(content.specs)).errors);
  const axis = content.imageAxis === undefined ? undefined : content.imageAxis;
  if (axis && !shape.axes.some((a) => norm(a) === norm(axis))) {
    errors.imageAxis = shape.axes.length ? `Biến thể chỉ theo: ${shape.axes.join(', ')}` : 'Sản phẩm không có thuộc tính biến thể';
  }
  if (content.optionImages?.length) {
    const values = axis ? valuesOf(shape, axis) : new Map<string, string>();
    const seen = new Set<string>();
    for (const [i, img] of content.optionImages.entries()) {
      if (!axis || norm(img.axis) !== norm(axis)) errors[`optionImages.${i}`] = 'Ảnh theo giá trị phải cùng thuộc tính đã chọn gắn ảnh';
      else if (!values.has(norm(img.value))) errors[`optionImages.${i}`] = `Không có biến thể nào có giá trị «${img.value}»`;
      else if (seen.has(norm(img.value))) errors[`optionImages.${i}`] = `Giá trị «${img.value}» gửi hai lần`;
      else {
        seen.add(norm(img.value));
        const problem = await fileProblem([img.fileId], 'product_image', 1);
        if (problem) errors[`optionImages.${i}`] = problem;
      }
    }
  }
  return errors;
}

/** Số của một tổ hợp: ghi đè theo tổ hợp, trống thì theo số chung (21 mục 16.3). */
export function factsFor(defaults: DraftFacts, own: DraftFacts | undefined): DraftFacts {
  const pick = <K extends keyof DraftFacts>(k: K) => (own?.[k] ?? defaults[k] ?? null) as DraftFacts[K];
  return {
    standardPrice: pick('standardPrice'),
    targetNetPrice: pick('targetNetPrice'),
    weightG: pick('weightG'),
    lengthMm: pick('lengthMm'),
    widthMm: pick('widthMm'),
    heightMm: pick('heightMm'),
    minQty: pick('minQty'),
  };
}

/**
 * Phần còn thiếu của bản soạn (21 mục 16.3 `readiness.missing`), tính như độ hoàn thiện 17.1 trên mọi tổ hợp rồi gộp,
 * theo thứ tự `MISSING_FIELDS`. `factsOf` trả số đã gộp của một tổ hợp.
 */
export async function draftReadiness(
  shape: DraftShape,
  parentName: string,
  content: DraftContent,
  factsOf: (combo: Record<string, string>) => DraftFacts,
): Promise<MissingField[]> {
  const filled = new Set(content.specs.filter((s) => s.optionIds?.length || s.newValues?.length || s.value?.trim()).map((s) => s.fieldId));
  const template = shape.groupId ? await findTemplateFields([shape.groupId]) : [];
  const specsMissing = template.some((f) => f.required && !filled.has(f.fieldId));
  const imageValues = content.imageAxis ? valuesOf(shape, content.imageAxis).size : 0;
  const withImage = new Set(content.optionImages.map((o) => norm(o.value))).size;
  const parent = {
    name: parentName,
    imageCount: content.imageFileIds.length,
    variantImagesPartial: withImage > 0 && withImage < imageValues,
    specsMissing,
  };
  const missing = new Set<MissingField>();
  for (const combo of shape.combos.length ? shape.combos : [{}]) {
    const f = factsOf(combo);
    for (const m of readinessOf(parent, {
      targetNetPrice: f.targetNetPrice ?? null,
      minQty: f.minQty ?? null,
      weightG: f.weightG ?? null,
      lengthMm: f.lengthMm ?? null,
      widthMm: f.widthMm ?? null,
      heightMm: f.heightMm ?? null,
    }).missing) {
      missing.add(m);
    }
  }
  return MISSING_FIELDS.filter((m) => missing.has(m));
}

export interface DraftSource {
  draftId: string;
  requestNumber: string;
  /** Người soạn gần nhất (`updated_by`): nhật ký lúc chép ghi người này (21 mục 16.3). */
  authorId: string | null;
}

/**
 * Ảnh theo giá trị: gắn cho giá trị đã có SKU mang, chưa có ảnh; giá trị chưa có SKU (dòng chưa về hàng) thì để lần SKU
 * đó sinh ra. Gọi lại an toàn. Trả số ảnh đã gắn.
 */
async function applyOptionImages(companyId: string, productId: string, content: DraftContent): Promise<number> {
  if (!content.imageAxis || !content.optionImages.length) return 0;
  const product = await findProduct(productId);
  if (!product?.imageAttributeId) return 0;
  const variants = await findVariants({ productId });
  const byValue = new Map<string, { valueId: string; hasImage: boolean }>();
  for (const v of variants) {
    const a = v.attributes.find((x) => x.attributeId === product.imageAttributeId);
    if (a) byValue.set(norm(a.value), { valueId: a.valueId, hasImage: v.image?.attributeValueId === a.valueId });
  }
  let added = 0;
  for (const img of content.optionImages) {
    const target = byValue.get(norm(img.value));
    if (!target || target.hasImage) continue;
    if (await fileProblem([img.fileId], 'product_image', 1)) continue;
    await upsertVariantImage({ companyId, productId, attributeId: product.imageAttributeId, attributeValueId: target.valueId, fileId: img.fileId });
    target.hasImage = true;
    added += 1;
  }
  return added;
}

/**
 * Chép phần sản phẩm của bản soạn sang cha vừa tạo khi ghi sổ phiếu nhận (21 mục 16.3), cùng giao dịch. Phần hỏng (tệp
 * mất, thông số không hợp mẫu nhóm lúc này, trục gắn ảnh không còn) thì bỏ và ghi trong nhật ký, không ném. Không cần
 * quyền của người ghi sổ: hệ thống làm, nhật ký ghi người soạn. Trả tên các phần bị bỏ.
 */
export async function applyPurchaseDraft(companyId: string, productId: string, content: DraftContent, source: DraftSource): Promise<string[]> {
  const dropped: string[] = [];
  const version = await lockProduct(productId);
  const product = await findProduct(productId);
  if (version === undefined || !product) return ['product'];

  let imageAttributeId: string | null = null;
  if (content.imageAxis) {
    const [first] = await findVariants({ productId });
    imageAttributeId = first?.attributes.find((a) => norm(a.attributeName) === norm(content.imageAxis!))?.attributeId ?? null;
    if (!imageAttributeId) dropped.push('imageAxis');
  }
  await updateProductIfVersion(productId, version, product.name, content.description ?? product.description ?? '', {
    brand: content.brand ?? null,
    originCountry: content.originCountry ?? null,
    imageAttributeId,
  });

  const images: string[] = [];
  for (const id of content.imageFileIds.slice(0, MAX_PRODUCT_IMAGES)) {
    if (await fileProblem([id], 'product_image', 1)) dropped.push(`image:${id}`);
    else images.push(id);
  }
  if (images.length) await replaceProductImages(companyId, productId, images);
  if (content.sizeChartFileId) {
    if (await fileProblem([content.sizeChartFileId], 'product_image', 1)) dropped.push('sizeChart');
    else await setSizeChart(productId, content.sizeChartFileId);
  }

  let specs = { before: {} as Record<string, string | null>, after: {} as Record<string, string | null> };
  if (content.specs.length) {
    const checked = await checkSpecs(content.specs);
    for (const key of Object.keys(checked.errors)) dropped.push(key);
    specs = await applySpecs(companyId, productId, checked.plans);
  }
  const optionImages = await applyOptionImages(companyId, productId, content);

  await recordAudit({
    companyId,
    actorId: source.authorId,
    action: 'update',
    entityType: 'product.products',
    entityId: productId,
    label: product.name,
    before: null,
    after: {
      fromDraft: { draftId: source.draftId, requestNumber: source.requestNumber },
      description: content.description ?? undefined,
      brand: content.brand ?? undefined,
      originCountry: content.originCountry ?? undefined,
      imageFileIds: images,
      sizeChartFileId: dropped.includes('sizeChart') ? undefined : (content.sizeChartFileId ?? undefined),
      imageAxis: imageAttributeId ? content.imageAxis : undefined,
      optionImages,
      specs: specs.after,
      dropped,
    },
  });
  return dropped;
}

/**
 * SKU vừa sinh khi ghi sổ (phiếu đầu hoặc phiếu sau) nhận số của tổ hợp trong bản soạn: giá chuẩn, giá muốn thực nhận,
 * cân nặng, kích thước gói (21 mục 16.3); chỉ ghi ô đang trống. Gắn ảnh theo giá trị của SKU nếu còn thiếu. Ngưỡng tồn do
 * bên gọi ghi qua inventory. Trả tên các ô đã ghi.
 */
export async function applyDraftVariantFacts(
  companyId: string,
  variantId: string,
  facts: DraftFacts,
  content: DraftContent | null,
  source: DraftSource,
): Promise<string[]> {
  const [v] = await findVariants({ ids: [variantId] });
  if (!v) return [];
  const patch: Parameters<typeof updateVariantIfVersion>[2] = {};
  const money = (s: string | null | undefined) => (s === null || s === undefined ? null : new Decimal(s).toFixed(2));
  if (v.standardPrice === null && facts.standardPrice != null) patch.standardPrice = money(facts.standardPrice);
  if (v.targetNetPrice === null && facts.targetNetPrice != null) patch.targetNetPrice = money(facts.targetNetPrice);
  if (v.weightG === null && facts.weightG != null) patch.weightG = facts.weightG;
  if (v.lengthMm === null && facts.lengthMm != null) patch.lengthMm = facts.lengthMm;
  if (v.widthMm === null && facts.widthMm != null) patch.widthMm = facts.widthMm;
  if (v.heightMm === null && facts.heightMm != null) patch.heightMm = facts.heightMm;
  const fields = Object.keys(patch);
  if (fields.length) {
    await updateVariantIfVersion(variantId, v.version, patch);
    await touchProduct(v.productId);
    await recordAudit({
      companyId,
      actorId: source.authorId,
      action: 'update',
      entityType: 'product.product_variants',
      entityId: variantId,
      label: `${v.productName} · ${v.sku}`,
      before: null,
      after: { ...patch, fromDraft: { draftId: source.draftId, requestNumber: source.requestNumber } },
    });
  }
  if (content) await applyOptionImages(companyId, v.productId, content);
  return fields;
}
