// Ghi lựa chọn liên kết SKU sàn vào nháp thiết lập của gian hàng `connecting` (Documents/21 §18.12 "Gian hàng connecting",
// §18.7.5 `setup_draft`). Thân hàm thuộc commerio-backend#569 (bảng nháp, luật xoá mốc, `draftVersion`); #565 chỉ giữ chỗ
// rẽ nhánh để route `POST sku-links` không đổi khi #569 merge.
import { AppError } from "../../../../shared/errors/app-error.ts";
import type { Actor } from "./shops.ts";

export interface SkuLinksInput {
  items?:
    | {
        externalSkuId: string;
        action: "link" | "create" | "skip" | "unmanaged";
        variantId?: string | null | undefined;
      }[]
    | undefined;
  groups?: { externalProductId: string; groupId: string }[] | undefined;
  draftVersion?: number | undefined;
}

/**
 * Gian hàng `connecting`: chưa làm (501). #569 thay thân: kiểm thêm quyền `channel.shop.connect` (và
 * `catalog.product.manage` khi có dòng `create`), ghi `decisions`/`createGroups`, trả `{ draft, version, results }`.
 */
export async function writeSetupDraft(
  actor: Actor,
  shopId: string,
  input: SkuLinksInput,
): Promise<never> {
  void actor;
  void shopId;
  void input;
  throw new AppError(
    501,
    "not_implemented",
    "Liên kết SKU trong lúc thiết lập gian hàng chưa làm xong",
    {
      issue: "commerio-backend#569",
      owner: "Thành",
    },
  );
}
