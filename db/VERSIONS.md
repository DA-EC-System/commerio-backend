# Phiên bản CSDL

<!-- Sinh tự động bởi `npm run db:docs` từ db/migrations. Không sửa tay. -->

`V<n>` là migration thứ n trong `db/migrations/meta/_journal.json`. Số không đổi sau khi merge vào `main`; migration của nhánh chưa merge mang số tạm, `npm run db:regen` có thể đẩy số lên.
Mới nhất: **V155**. Schema hiện tại: [SCHEMA.md](SCHEMA.md).

## V155 · 24/11/2026 · can-nang-kich-thuoc-tran

`db/migrations/20261124131349_can-nang-kich-thuoc-tran.sql` · sinh từ schema

- `product.product_variants`: đổi check `product_variants_dimensions`

## V154 · 24/11/2026 · can-nang-kich-thuoc-du-lieu

`db/migrations/20261124131347_can-nang-kich-thuoc-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #434 (viết tay, chỉ dữ liệu, chạy lại được): cân nặng trên 50.000 g, cạnh trên 2.000 mm (Documents/21 §17.5) chỉ có trong dữ liệu thử trên staging (PATCH SKU trước #434 không chặn).

## V153 · 24/11/2026 · dong-bo-category-du-lieu

`db/migrations/20261124125551_dong-bo-category-du-lieu.sql` · viết tay

- viết tay: quyền, khoá ngoại, dữ liệu
- #569 (Documents/21 §18.5): bảng ánh xạ category sàn → danh mục chuẩn là dữ liệu của nền tảng.

## V152 · 24/11/2026 · dong-bo-category

`db/migrations/20261124125548_dong-bo-category.sql` · sinh từ schema

- + bảng `channel.platform_category_group_maps`
- `channel.marketplaces`: + cột `category_sync_state`, `category_sync_error`, `category_sync_at`; + check `marketplaces_category_sync_state`
- `channel.shops`: + cột `category_permissions_state`, `category_permissions_error`, `category_permissions_checked_at`; + check `shops_category_permissions_state`

## V151 · 24/11/2026 · phi-moi-mon

`db/migrations/20261124115024_phi-moi-mon.sql` · sinh từ schema

- enum `finance.ledger_kind`: + `fee_per_item`

## V150 · 24/11/2026 · lien-ket-sku-565

`db/migrations/20261124110616_lien-ket-sku-565.sql` · sinh từ schema

- `channel.remote_skus`: + cột `variant_label`, `image_url`, `external_category_id`
- `channel.shops`: + cột `display_name`; + check `shops_display_name`

## V149 · 24/11/2026 · onboarding-trang-thai

`db/migrations/20261124103058_onboarding-trang-thai.sql` · sinh từ schema

- `channel.shops`: + cột `setup_draft`, `setup_draft_version`
- `core.companies`: + cột `onboarding_completed_at`

## V148 · 21/11/2026 · luot-dong-bo-rls

`db/migrations/20261121132759_luot-dong-bo-rls.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `channel.listing_sync_runs` (kết quả lượt đồng bộ do người bấm, Documents/21 §18; vòng lặp của 0002 chỉ chạy một lần).

## V147 · 21/11/2026 · luot-dong-bo

`db/migrations/20261121132737_luot-dong-bo.sql` · sinh từ schema

- + bảng `channel.listing_sync_runs`

## V146 · 21/11/2026 · bang-san-fk

`db/migrations/20261121115038_bang-san-fk.sql` · viết tay

- viết tay: quyền, khoá ngoại, dữ liệu
- Danh mục sàn channel.marketplaces (Documents/19 mục 3.3, 21/11/2026): chèn các sàn, commerio_app chỉ đọc, khoá ngoại từ mọi cột platform của channel; gắn lại hai khoá ngoại ghép đã gỡ khi đổi kiểu.

## V145 · 21/11/2026 · bang-san

`db/migrations/20261121115033_bang-san.sql` · sinh từ schema

- + bảng `channel.marketplaces`
- `channel.api_usage`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.axis_mappings`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.platform_categories`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.platform_category_attributes`: đổi cột `platform` (kiểu channel.marketplace → text); − khoá ngoại `platform_category_attributes_category_fk`
- `channel.product_specs`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.shops`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.spec_field_mappings`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.spec_option_mappings`: đổi cột `platform` (kiểu channel.marketplace → text)
- `channel.webhook_events`: đổi cột `platform` (kiểu channel.marketplace → text)
- `order.customer_identities`: + cột `source`, `platform`; − cột `channel_kind`; + unique `customer_identities_uq`; − unique `customer_identities_company_id_channel_kind_external_user_id_unique`; + check `customer_identities_platform`
- + enum `order.contact_channel`
- − enum `channel.marketplace`
- − enum `order.channel_kind`

## V144 · 21/11/2026 · bang-san-go-khoa

`db/migrations/20261121115023_bang-san-go-khoa.sql` · viết tay

- viết tay
- Gỡ khoá ngoại ghép spec_option_mappings_field_fk (viết tay ở *_anh-xa-hai-tang-du-lieu) trước khi đổi cột platform từ enum sang text (Documents/19 mục 3.3, 21/11/2026): Postgres không đổi kiểu từng bảng được khi khoá ngoại ghép còn.

## V143 · 21/11/2026 · ban-soan-truoc-rls

`db/migrations/20261121101636_ban-soan-truoc-rls.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `product.purchase_product_drafts` (bản soạn trước sản phẩm mới, Documents/19, 21 mục 16.3; vòng lặp của 0002 chỉ chạy một lần).

## V142 · 21/11/2026 · ban-soan-truoc

`db/migrations/20261121101614_ban-soan-truoc.sql` · sinh từ schema

- + bảng `product.purchase_product_drafts`

## V141 · 21/11/2026 · danh-muc-chuan-du-lieu

`db/migrations/20261121060918_danh-muc-chuan-du-lieu.sql` · viết tay

- viết tay: RLS, dữ liệu
- Danh mục chuẩn 27 (#531, Documents/21 mục 5.7, 19 §3.2; `.claude/issues/luong-san-pham/du-lieu-chuan.md`).

## V140 · 21/11/2026 · danh-muc-chuan

`db/migrations/20261121060914_danh-muc-chuan.sql` · sinh từ schema

- + bảng `product.group_allowed_attributes`
- `product.attributes`: đổi check `attributes_platform_kind`
- `product.product_groups`: + cột `renamed_from`, `split_into`; + check `product_groups_merge_platform`

## V139 · 21/11/2026 · dong-phieu-nhan-chua-co-sku

`db/migrations/20261121055718_dong-phieu-nhan-chua-co-sku.sql` · sinh từ schema

- `product.goods_receipt_lines`: đổi cột `variant_id` (thành null)

## V138 · 21/11/2026 · quyen-sao-ke-san-chung

`db/migrations/20261121051107_quyen-sao-ke-san-chung.sql` · viết tay

- viết tay: dữ liệu
- Bỏ tên sàn khỏi nhãn quyền người dùng thấy ở màn vai trò ("Thiết kế cho nhiều sàn").

## V137 · 21/11/2026 · anh-xa-hai-tang-du-lieu

`db/migrations/20261121042909_anh-xa-hai-tang-du-lieu.sql` · viết tay

- viết tay: RLS, khoá ngoại, dữ liệu
- Ánh xạ sang sàn hai tầng (dữ liệu chung, Documents/19 §3.3, 21 §18.8.1, §5.6, be#522).

## V136 · 21/11/2026 · anh-xa-hai-tang

`db/migrations/20261121042905_anh-xa-hai-tang.sql` · sinh từ schema

- `channel.axis_mappings`: đổi cột `company_id` (thành null); + index `axis_mappings_platform_code_uq`, `axis_mappings_platform_priority_uq`
- `channel.spec_field_mappings`: đổi cột `company_id` (thành null); + unique `spec_field_mappings_field_code_uq`; + index `spec_field_mappings_platform_priority_uq`, `spec_field_mappings_platform_attribute_uq`
- `channel.spec_option_mappings`: đổi cột `company_id` (thành null); − khoá ngoại `spec_option_mappings_field_fk`; + unique `spec_option_mappings_option_uq`; − unique `spec_option_mappings_uq`

## V135 · 21/11/2026 · du-lieu-chung-chuyen

`db/migrations/20261121032708_du-lieu-chung-chuyen.sql` · viết tay

- viết tay: quyền, khoá ngoại, dữ liệu
- Dữ liệu chuẩn hai tầng (#521, Documents/21 mục 5.6 "Migration", 19 mục 2): ghi dòng nền tảng (12 nhóm, 76 thông số, mẫu, trục, 4 thuộc tính chuẩn), gộp bản sao của từng công ty vào dòng nền tảng, chuyển mọi tham chiếu, xoá bản sao.

## V134 · 21/11/2026 · du-lieu-chung-rls

`db/migrations/20261121032412_du-lieu-chung-rls.sql` · viết tay

- viết tay: RLS
- Dữ liệu chuẩn hai tầng (#521, Documents/19 mục 2 "Dữ liệu chuẩn hai tầng", 21 mục 5.6).

## V133 · 21/11/2026 · du-lieu-chung

`db/migrations/20261121032353_du-lieu-chung.sql` · sinh từ schema

- + bảng `product.company_group_settings`
- `product.attribute_values`: đổi cột `company_id` (thành null); − unique `attribute_values_attribute_id_code_unique`; + index `attribute_values_platform_lower_value_uq`, `attribute_values_platform_code_uq`, `attribute_values_company_lower_value_uq`, `attribute_values_company_code_uq`; − index `attribute_values_attribute_lower_value_uq`
- `product.attributes`: đổi cột `company_id` (thành null); + index `attributes_platform_lower_name_uq`, `attributes_platform_kind_uq`; − index `attributes_company_platform_kind_uq`; đổi index `attributes_company_lower_name_uq`
- `product.group_spec_fields`: + cột `id`; đổi cột `company_id` (thành null); − khoá chính `group_spec_fields_group_id_field_id_pk`; + unique `group_spec_fields_group_field_company_uq`
- `product.product_groups`: đổi cột `company_id` (thành null); + index `product_groups_platform_lower_name_uq`; đổi index `product_groups_company_lower_name_uq`
- `product.spec_field_options`: đổi cột `company_id` (thành null); + index `spec_field_options_platform_lower_value_uq`, `spec_field_options_company_lower_value_uq`; − index `spec_field_options_field_lower_value_uq`
- `product.spec_fields`: đổi cột `company_id` (thành null); − unique `spec_fields_company_code_uq`; + index `spec_fields_platform_code_uq`, `spec_fields_platform_lower_name_uq`, `spec_fields_company_code_uq`; đổi index `spec_fields_company_lower_name_uq`

## V132 · 21/11/2026 · san-pham-san-du-lieu

`db/migrations/20261120221509_san-pham-san-du-lieu.sql` · viết tay

- viết tay: RLS, hàm, trigger, dữ liệu
- Sản phẩm sàn theo gian hàng (#295, Documents/19 câu chốt Q1).

## V131 · 21/11/2026 · san-pham-san-theo-gian-hang

`db/migrations/20261120221503_san-pham-san-theo-gian-hang.sql` · sinh từ schema

- + bảng `channel.shop_products`
- `channel.listings`: + cột `shop_product_id`; + khoá ngoại `listings_shop_product_id_shop_products_id_fk`, `listings_shop_product_external_fk`; + index `listings_shop_product_id_index`
- + 2 enum `channel`: shop_product_origin, shop_product_status

## V130 · 21/11/2026 · ghep-truc-du-lieu

`db/migrations/20261120215928_ghep-truc-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- Ghép trục theo platform_kind cho spec có sẵn (#448, chỉ dữ liệu, chạy lại được): trục `__custom` của channel.product_specs đổi sang mã sales attribute chuẩn đầu tiên (theo attributes.platform_kind) mà leaf của spec có (kind = 'sales'), mỗi…

## V129 · 21/11/2026 · anh-xa-truc-rls

`db/migrations/20261120215924_anh-xa-truc-rls.sql` · viết tay

- viết tay: RLS
- Ánh xạ trục phân loại sang sales attribute của sàn (#448, Documents/19 §3.3): RLS company_isolation cho channel.axis_mappings (vòng lặp của 0002 chỉ chạy một lần).

## V128 · 21/11/2026 · anh-xa-truc

`db/migrations/20261120215920_anh-xa-truc.sql` · sinh từ schema

- + bảng `channel.axis_mappings`

## V127 · 21/11/2026 · anh-xa-thong-so-rls

`db/migrations/20261120214154_anh-xa-thong-so-rls.sql` · viết tay

- viết tay: RLS, dữ liệu
- Ánh xạ thông số sang sàn (#509, Documents/19 §3.3).

## V126 · 21/11/2026 · anh-xa-thong-so-san

`db/migrations/20261120214152_anh-xa-thong-so-san.sql` · sinh từ schema

- + 2 bảng `channel`: spec_field_mappings, spec_option_mappings

## V125 · 21/11/2026 · thong-so-du-lieu

`db/migrations/20261120210538_thong-so-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- Thông số sản phẩm (#510, Documents/21 mục 5.5 "Seed"): công ty có trước nhận thứ công ty mới có từ `seedCompanyDefaults` ("Dung tích", "Hương vị", thư viện thông số, trục chuẩn và mẫu của 12 nhóm), không chép đè thứ đã có.

## V124 · 21/11/2026 · thong-so-rls

`db/migrations/20261120210458_thong-so-rls.sql` · viết tay

- viết tay: RLS, khoá ngoại
- Thông số sản phẩm (#510, Documents/19 §3.2).

## V123 · 21/11/2026 · thong-so-san-pham

`db/migrations/20261120210435_thong-so-san-pham.sql` · sinh từ schema

- + 4 bảng `product`: group_spec_fields, product_spec_values, spec_field_options, spec_fields
- `product.attributes`: đổi check `attributes_platform_kind`
- `product.product_groups`: + cột `axis1_attribute_id`, `axis2_attribute_id`; + khoá ngoại `product_groups_axis1_attribute_id_attributes_id_fk`, `product_groups_axis2_attribute_id_attributes_id_fk`; + check `product_groups_axis_order`, `product_groups_axis_distinct`

## V122 · 20/11/2026 · bo-daily-channel-summary

`db/migrations/20261120165800_bo-daily-channel-summary.sql` · sinh từ schema

- − bảng `insight.daily_channel_summary`
- − enum `insight.order_source`

## V121 · 20/11/2026 · ghep-tu-dien-spec-du-lieu

`db/migrations/20261120154853_ghep-tu-dien-spec-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #497: nguồn từng attribute của spec đã có.

## V120 · 20/11/2026 · ghep-tu-dien-spec

`db/migrations/20261120154829_ghep-tu-dien-spec.sql` · sinh từ schema

- `channel.product_specs`: + cột `field_sources`, `remote_facts`, `remote_read_at`, `remote_shop_id`; + khoá ngoại `product_specs_remote_shop_id_shops_id_fk`; + check `product_specs_remote`

## V119 · 20/11/2026 · tran-hoan-tien-du-lieu

`db/migrations/20261120105607_tran-hoan-tien-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #355: hoàn tiền khách chỉ ghi tới mức doanh thu đã ghi của các dòng trả (Documents/25 mục 10.1, E174).

## V118 · 20/11/2026 · tra-tiktok-dong-y-hoan-tien-gia-ban-sao-sku-san-moc-day-gia-listing-gia-von-de-x

`db/migrations/20261120105603_tra-tiktok-dong-y-hoan-tien-gia-ban-sao-sku-san-moc-day-gia-listing-gia-von-de-x.sql` · sinh từ schema

- `channel.listings`: + cột `last_price_pushed_at`
- `channel.price_calculations`: đổi check `price_calculations_trigger`
- `channel.remote_skus`: + cột `price`; + check `remote_skus_price`
- `order.return_requests`: + cột `respond_by`, `refund_approval`; + index `return_requests_refund_approval_pending_idx`; + check `return_requests_refund_approval`

## V117 · 20/11/2026 · doi-category-san

`db/migrations/20261120102414_doi-category-san.sql` · sinh từ schema

- `channel.listings`: + cột `category_change`; + check `listings_category_change`

## V116 · 20/11/2026 · dang-ky-cho-ma-quyen

`db/migrations/20261120100235_dang-ky-cho-ma-quyen.sql` · viết tay

- viết tay: quyền
- #459: lần đăng ký chờ mã chỉ luồng đăng ký (role chủ bảng, ngoài withCompany) đụng tới; commerio_app không có quyền nào.

## V115 · 20/11/2026 · dang-ky-cho-ma

`db/migrations/20261120100216_dang-ky-cho-ma.sql` · sinh từ schema

- + bảng `core.registrations`

## V114 · 20/11/2026 · bo-cot-dang-huy-cu

`db/migrations/20261120094957_bo-cot-dang-huy-cu.sql` · sinh từ schema

- `order.orders`: − cột `cancelling`; + check `orders_cancel_pending_open`, `orders_cancel_requested_open`

## V113 · 20/11/2026 · bo-co-dang-huy-cu

`db/migrations/20261120094954_bo-co-dang-huy-cu.sql` · viết tay

- viết tay: dữ liệu
- Bỏ trigger, hàm giữ cột cờ cũ `cancelling` bằng `cancel_pending` (#417 bước một); dọn hai cờ chờ sàn của đơn đã dừng trước CHECK (#427), viết tay, chạy lại được.

## V112 · 20/11/2026 · mst-unique

`db/migrations/20261120085710_mst-unique.sql` · sinh từ schema

- `core.companies`: đổi cột `tax_code` (thành null); + unique `companies_tax_code_unique`

## V111 · 20/11/2026 · mst-chuan-hoa-kenh-ban-loi

`db/migrations/20261120085707_mst-chuan-hoa-kenh-ban-loi.sql` · viết tay

- viết tay: dữ liệu
- #459: chuẩn hoá mã số thuế công ty, đặt NULL mã sai định dạng hoặc trùng (giữ công ty cũ nhất), bật Kênh bán (phân hệ lõi) cho mọi công ty.

## V110 · 20/11/2026 · dong-san-pham-moi

`db/migrations/20261120070207_dong-san-pham-moi.sql` · sinh từ schema

- `product.purchase_request_lines`: + cột `new_parent_product_id`, `new_parent_name`, `new_option_values`; − cột `new_product_name`, `new_variant_attrs`; + check `purchase_request_lines_one_parent`, `purchase_request_lines_new_parent_group`; đổi check `purchase_request_lines_item`

## V109 · 20/11/2026 · nhom-hang-du-lieu

`db/migrations/20261119171451_nhom-hang-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- Nhóm hàng (#447, plan A2): công ty có trước bản này nhận thứ công ty mới có từ `seedCompanyDefaults`, không chép đè.

## V108 · 20/11/2026 · nhom-hang-rls-quyen

`db/migrations/20261119171435_nhom-hang-rls-quyen.sql` · viết tay

- viết tay: RLS, dữ liệu
- Nhóm hàng (#447): RLS cho bảng mới `product.company_product_settings` (vòng lặp của 0002 chỉ chạy một lần; bảng `product_groups` đổi tên giữ nguyên policy cũ).

## V107 · 20/11/2026 · nhom-hang

`db/migrations/20261119171430_nhom-hang.sql` · sinh từ schema

- + 2 bảng `product`: company_product_settings, product_groups
- − bảng `product.categories`
- `product.attribute_values`: + check `attribute_values_value_length`
- `product.attributes`: + cột `platform_kind`; + index `attributes_company_platform_kind_uq`; + check `attributes_platform_kind`, `attributes_name_length`
- `product.product_variants`: + check `product_variants_sku_length`
- `product.products`: + cột `group_id`; − cột `category_id`; + khoá ngoại `products_group_id_product_groups_id_fk`; − khoá ngoại `products_category_id_categories_id_fk`; + index `products_group_id_index`; − index `products_category_id_index`
- `product.purchase_request_lines`: + cột `new_group_id`; − cột `new_category_id`

## V106 · 20/11/2026 · nhom-hang-cat-ten

`db/migrations/20261119171400_nhom-hang-cat-ten.sql` · viết tay

- viết tay: dữ liệu
- Nhóm hàng (#447), chạy trước migration thêm CHECK tên thuộc tính <= 15, giá trị <= 20 ký tự (luật Lazada `VARIATION_*`, Documents/21 mục 5.2): cắt tên dài hơn, bỏ khoảng trắng cuối; trùng tên trong công ty (thuộc tính) hay trong thuộc tính…

## V105 · 19/11/2026 · don-nhap-loi-moi-qua-han

`db/migrations/20261119155251_don-nhap-loi-moi-qua-han.sql` · sinh từ schema

- `core.invitations`: + cột `purged_at`; + check `invitations_purged_shape`; đổi check `invitations_identity_present`

## V104 · 19/11/2026 · thuat-ngu-quyen

`db/migrations/20261119115521_thuat-ngu-quyen.sql` · viết tay

- viết tay: dữ liệu
- Thuật ngữ UI theo bảng chốt 19/11/2026 (FE#332): đổi nhãn quyền người dùng thấy ở màn vai trò.

## V103 · 19/11/2026 · bo-ghep-danh-muc

`db/migrations/20261119083421_bo-ghep-danh-muc.sql` · sinh từ schema

- − bảng `channel.category_maps`
- − bảng `product.product_channel_specs`

## V102 · 19/11/2026 · chep-spec-lan-cuoi

`db/migrations/20261119083359_chep-spec-lan-cuoi.sql` · viết tay

- viết tay: dữ liệu
- #400 BE3 (plan AC-S7, A18): chép ghép danh mục cũ (`channel.category_maps`) sang spec lần cuối, ngay trước migration `*_bo-ghep-danh-muc` xoá bảng.

## V101 · 19/11/2026 · chep-spec-tu-ghep-danh-muc

`db/migrations/20261119080452_chep-spec-tu-ghep-danh-muc.sql` · viết tay

- viết tay: dữ liệu
- #400 BE2 (Documents/19 mục 3.3, plan AC-S7, A18): chép ghép danh mục Commerio cũ (`channel.category_maps`) sang spec theo sản phẩm, để sản phẩm hôm nay đẩy được vẫn đẩy được khi đẩy đọc `product_specs`.

## V100 · 19/11/2026 · han-ban-giao-kien

`db/migrations/20261119074938_han-ban-giao-kien.sql` · viết tay

- viết tay: hàm, trigger, dữ liệu
- Hạn bàn giao của kiện theo đơn (KH-B01, ca test đêm 18/11/2026).

## V99 · 19/11/2026 · dang-huy-chuyen-co

`db/migrations/20261119071502_dang-huy-chuyen-co.sql` · viết tay

- viết tay: hàm, trigger, dữ liệu
- Đổi cột cờ `cancelling` thành `cancel_pending` theo hai bước (#417), viết tay.

## V98 · 19/11/2026 · dang-huy-cot

`db/migrations/20261119071455_dang-huy-cot.sql` · sinh từ schema

- `order.order_lines`: + cột `cancelled_at`; + check `order_lines_cancelled_at`
- `order.orders`: + cột `cancel_pending`

## V97 · 19/11/2026 · dang-huy-du-lieu

`db/migrations/20261119071449_dang-huy-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- Dọn cờ Đang huỷ kẹt (test đêm 18/11/2026: DH-B03, KH-B09), viết tay, chỉ dữ liệu, chạy lại được.

## V96 · 19/11/2026 · tiktok-han-tra

`db/migrations/20261119061047_tiktok-han-tra.sql` · viết tay

- viết tay: dữ liệu
- #236 PR 2 (spec 5.3, D13): đơn TikTok đã COMPLETED/CANCELLED trên sàn trước PR 2 không được kéo lại (order-pull bỏ đơn có update_time không mới hơn raw_orders), nên ghi mốc hết quyền trả từ lần kéo đã lưu.

## V95 · 19/11/2026 · category-san-quyen

`db/migrations/20261119053555_category-san-quyen.sql` · viết tay

- viết tay: RLS, quyền, khoá ngoại
- Category và attribute của sàn (#400, Documents/19 mục 2, 3.3).

## V94 · 19/11/2026 · category-san

`db/migrations/20261119053552_category-san.sql` · sinh từ schema

- + 4 bảng `channel`: platform_categories, platform_category_attributes, product_specs, shop_category_permissions
- `channel.listings`: + cột `external_category_id`
- `channel.shops`: + unique `shops_id_company_uq`

## V93 · 19/11/2026 · xoa-gian-hang-thu-bao

`db/migrations/20261118204844_xoa-gian-hang-thu-bao.sql` · sinh từ schema

- `channel.shop_reauth_mails`: đổi khoá ngoại `shop_reauth_mails_shop_id_shops_id_fk`

## V92 · 19/11/2026 · anh-phan-loai-rls

`db/migrations/20261118183221_anh-phan-loai-rls.sql` · viết tay

- viết tay: RLS, khoá ngoại
- Ảnh phân loại (#340, Documents/19 §3.2).

## V91 · 19/11/2026 · anh-phan-loai

`db/migrations/20261118183217_anh-phan-loai.sql` · sinh từ schema

- + bảng `product.product_attribute_value_images`
- `product.attribute_values`: + unique `attribute_values_id_attribute_uq`
- `product.products`: + cột `image_attribute_id`, `origin_country`, `brand`; + khoá ngoại `products_image_attribute_id_attributes_id_fk`; + unique `products_id_image_attribute_uq`; + check `products_origin_country`, `products_brand_length`

## V90 · 19/11/2026 · nguon-noi-dung-listing-du-lieu

`db/migrations/20261118173938_nguon-noi-dung-listing-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #399: điền chủ nội dung cho listing có trước cột `content_source` (cột thêm với mặc định `platform`).

## V89 · 19/11/2026 · nguon-noi-dung-listing-listing-create-attempted-at

`db/migrations/20261118173927_nguon-noi-dung-listing-listing-create-attempted-at.sql` · sinh từ schema

- `channel.listings`: + cột `create_attempted_at`, `content_source`
- + enum `channel.listing_content_source`

## V88 · 19/11/2026 · ten-tren-san-du-lieu

`db/migrations/20261118172653_ten-tren-san-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #396: listing chưa gỡ đang ghép (có mã SKU sàn) lấy tên trong bản sao SKU sàn làm mốc "tên trên sàn lúc ghép".

## V87 · 19/11/2026 · ten-tren-san

`db/migrations/20261118172649_ten-tren-san.sql` · sinh từ schema

- `channel.listings`: + cột `remote_title_at_match`, `remote_title_en_at_match`, `remote_title_matched_at`, `remote_title_changed_at`; + check `listings_remote_title`
- `channel.remote_skus`: + cột `title_en`

## V86 · 18/11/2026 · nhat-ky-nhan-thao-tac

`db/migrations/20261118162156_nhat-ky-nhan-thao-tac.sql` · sinh từ schema

- `core.audit_logs`: + cột `entity_label`, `operation`

## V85 · 18/11/2026 · xoa-email-link-huy-chua-xac-minh

`db/migrations/20261118160326_xoa-email-link-huy-chua-xac-minh.sql` · viết tay

- viết tay: dữ liệu
- Link huỷ từ `open` trước #403 còn giữ email, họ tên người cầm link tự gõ ở `/join/otp` mà chưa qua OTP (API trả ra cho Admin).

## V84 · 18/11/2026 · bo-quyen-giao-vai-sale

`db/migrations/20261118144522_bo-quyen-giao-vai-sale.sql` · viết tay

- viết tay: dữ liệu
- Tự giao, báo kết quả tự giao chỉ còn Nhân viên kho (Documents/25 mục 11, đổi 17/11/2026; #351): bỏ quyền giao khỏi vai trò có sẵn Sale.

## V83 · 18/11/2026 · chia-lai-kien

`db/migrations/20261118104214_chia-lai-kien.sql` · sinh từ schema

- `order.packages`: + cột `replaces_package_id`, `waybill_kept`; + khoá ngoại `packages_replaces_package_id_packages_id_fk`; + index `packages_replaces_package_id_index`; + check `packages_waybill_kept`

## V82 · 17/11/2026 · ghep-sku-dong-don

`db/migrations/20261117121410_ghep-sku-dong-don.sql` · sinh từ schema

- `order.package_lines`: + cột `stock_untracked`; + check `package_lines_untracked`
- `order.order_lines`: + cột `stock_untracked`; + check `order_lines_untracked`

## V81 · 17/11/2026 · keo-lai-don-trang-thai-moi

`db/migrations/20261117112914_keo-lai-don-trang-thai-moi.sql` · viết tay

- viết tay: dữ liệu
- Kéo lại đơn có món mang trạng thái app chưa biết lúc kéo (#358; vd Lazada `confirmed` trước khi có ánh xạ).

## V80 · 17/11/2026 · gia-theo-gian-hang

`db/migrations/20261117111721_gia-theo-gian-hang.sql` · sinh từ schema

- `channel.listings`: + khoá ngoại `listings_price_calc_id_price_calculations_id_fk`
- `channel.price_calculations`: + cột `tax_regime_version_id`, `min_margin_version_id`, `per_item_fee`, `fee_pct`, `tax_pct`, `min_margin_pct`, `trigger`; đổi cột `cost` (thành null); đổi cột `margin_pct` (thành null); đổi cột `below_floor` (thành null); + index `price_calculations_one_pending`; + check `price_calculations_cost_floor`, `price_calculations_trigger`

## V79 · 17/11/2026 · remote-skus-refresh

`db/migrations/20261117110608_remote-skus-refresh.sql` · sinh từ schema

- `channel.shops`: + cột `remote_skus_full_error`, `remote_skus_refresh_requested_at`; + check `shops_remote_skus_full_error`

## V78 · 17/11/2026 · listing-doi-ngoai-app

`db/migrations/20261117104245_listing-doi-ngoai-app.sql` · sinh từ schema

- `channel.listings`: + cột `outside_change_kind`, `outside_change_price`, `outside_change_at`; + check `listings_outside_change`
- + enum `channel.outside_change_kind`

## V77 · 17/11/2026 · ghi-bu-tra-ncc

`db/migrations/20261117101905_ghi-bu-tra-ncc.sql` · viết tay

- viết tay: dữ liệu
- Ghi bù khoản trả NCC cho phiếu nhận đã ghi sổ trước #357 (chỉ dữ liệu, chạy lại được).

## V76 · 17/11/2026 · ban-sua-noi-dung

`db/migrations/20261117094453_ban-sua-noi-dung.sql` · sinh từ schema

- `channel.listings`: + cột `revision_status`, `revision_reject_reason`, `revision_at`; + check `listings_revision`
- + enum `channel.listing_revision_status`

## V75 · 17/11/2026 · quyen-ho-so-cong-ty

`db/migrations/20261117094142_quyen-ho-so-cong-ty.sql` · viết tay

- viết tay: dữ liệu
- Quyền xem, sửa hồ sơ công ty (#292), chỉ vai trò có sẵn CEO và Admin mang.

## V74 · 17/11/2026 · ho-so-cong-ty

`db/migrations/20261117094137_ho-so-cong-ty.sql` · sinh từ schema

- `core.companies`: + cột `address`, `responsible_name`, `responsible_address`

## V73 · 17/11/2026 · mo-kien-kiem-ke

`db/migrations/20261117090805_mo-kien-kiem-ke.sql` · sinh từ schema

- enum `order.open_purpose`: + `stocktake`

## V72 · 17/11/2026 · bo-luu-tru-san-pham-cha

`db/migrations/20261117051349_bo-luu-tru-san-pham-cha.sql` · sinh từ schema

- `product.products`: − cột `archived_at`

## V71 · 17/11/2026 · ma-cha-san-pham

`db/migrations/20261117051316_ma-cha-san-pham.sql` · sinh từ schema

- `product.products`: + cột `code`; + index `products_company_code_uq`; đổi index `products_company_lower_name_uq`
- kèm câu sửa dữ liệu viết tay
- #204 PR 3 (spec 2026-11-16-204 mục 5.3, D4, D5, D11): bỏ lưu trữ sản phẩm cha, thêm mã cha `code`.

## V70 · 17/11/2026 · listing-cho-ghep-sku-san

`db/migrations/20261117023058_listing-cho-ghep-sku-san.sql` · sinh từ schema

- `channel.listings`: + cột `pending_external_sku_id`, `pending_external_product_id`, `pending_seller_sku`; + index `listings_shop_pending_external_sku_uq`; + check `listings_pending_external`

## V69 · 17/11/2026 · bang-kich-co

`db/migrations/20261117011933_bang-kich-co.sql` · sinh từ schema

- `channel.category_maps`: + cột `size_chart_rule`; + check `category_maps_size_chart_rule`
- `product.products`: + cột `size_chart_file_id`

## V68 · 17/11/2026 · goi-y-theo-danh-muc

`db/migrations/20261116170507_goi-y-theo-danh-muc.sql` · sinh từ schema

- `product.categories`: + cột `margin_coefficient`, `price_rounding`, `reorder_lead_days`, `reorder_safety_qty`, `reorder_default_qty`; + check `categories_margin_coefficient`, `categories_price_rounding`, `categories_reorder_config`

## V67 · 15/11/2026 · huy-link-moi

`db/migrations/20261115082412_huy-link-moi.sql` · sinh từ schema

- `core.invitations`: + check `invitations_revoked_shape`; đổi check `invitations_identity_present`
- enum `core.invitation_status`: + `revoked`

## V66 · 15/11/2026 · that-lac-du-lieu

`db/migrations/20261115075746_that-lac-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- #238 (spec §5.1): trước #238 chưa có đường nào để người dùng đưa kiện sang `lost`, nên mọi kiện `lost` chưa có người xác nhận là do sàn báo.

## V65 · 15/11/2026 · that-lac-cot-that-lac-rang-buoc

`db/migrations/20261115075743_that-lac-cot-that-lac-rang-buoc.sql` · sinh từ schema

- `order.packages`: + cột `lost_self_approved`, `lost_source`; + check `packages_lost_source`, `packages_lost_confirmed`; đổi check `packages_lost_second_person`
- kèm câu sửa dữ liệu viết tay

## V64 · 15/11/2026 · rls-han-muc-cong-ty

`db/migrations/20261115075100_rls-han-muc-cong-ty.sql` · viết tay

- viết tay: RLS
- RLS cho `channel.api_usage` vừa có `company_id` (#215; vòng lặp của 0002 chỉ chạy một lần).

## V63 · 15/11/2026 · han-muc-theo-cong-ty

`db/migrations/20261115075057_han-muc-theo-cong-ty.sql` · sinh từ schema

- `channel.api_usage`: + cột `company_id`; − khoá chính `api_usage_platform_day_pk`; + unique `api_usage_platform_day_company_uq`

## V62 · 15/11/2026 · rls-lai-theo-sku-bang-noi

`db/migrations/20261115074227_rls-lai-theo-sku-bang-noi.sql` · viết tay

- viết tay: RLS, quyền, khoá ngoại, dữ liệu
- RLS và quyền cho hai bảng mới của finance (#231; vòng lặp của 0002 chỉ chạy một lần).

## V61 · 15/11/2026 · lai-theo-sku-bang-noi

`db/migrations/20261115074225_lai-theo-sku-bang-noi.sql` · sinh từ schema

- + 2 bảng `finance`: ledger_package_lines, ledger_replacements
- `finance.ledger_entries`: + unique `ledger_entries_id_estimate_uq`; + index `ledger_entries_source_type_source_id_index`

## V60 · 15/11/2026 · go-quyen-tien-cu

`db/migrations/20261115073345_go-quyen-tien-cu.sql` · viết tay

- viết tay: dữ liệu
- Gỡ quyền của phần tiền cũ (#235, Thành duyệt 13/11/2026): cổng thanh toán ngoài MVP, chứng từ đảo không làm; không còn route nào dùng.

## V59 · 15/11/2026 · bank-matches-chi-them

`db/migrations/20261115073343_bank-matches-chi-them.sql` · viết tay

- viết tay: quyền
- Khớp sao kê chỉ thêm như sổ tiền (#235; Documents/21 mục 21.1: `bankMatch` lưu ở bảng riêng, sổ chỉ thêm): role ứng dụng ghi được một lần, không sửa, không xoá.

## V58 · 15/11/2026 · thue-gtgt-dau-ra

`db/migrations/20261115070126_thue-gtgt-dau-ra.sql` · viết tay

- viết tay: dữ liệu
- #230: `tax_rules` thêm `outputVatPct` (thuế suất GTGT đầu ra của doanh nghiệp, Documents/21 §21.4).

## V57 · 15/11/2026 · het-hieu-luc-superseded

`db/migrations/20261115070124_het-hieu-luc-superseded.sql` · sinh từ schema

- `finance.config_versions`: đổi check `config_versions_effective`, `config_versions_approved`
- enum `finance.config_status`: + `superseded`; − `expired`
- #230: đổi trạng thái phiên bản cấu hình `expired` → `superseded` (Documents/25 §10.4, 21 §21.4, chốt 02/11/2026).

## V56 · 14/11/2026 · huy-dong-du-lieu

`db/migrations/20261114122508_huy-dong-du-lieu.sql` · viết tay

- viết tay: dữ liệu
- Dữ liệu cũ cho huỷ dòng (spec 205 §5.10, D22).

## V55 · 14/11/2026 · huy-dong-kiem-bang

`db/migrations/20261114122001_huy-dong-kiem-bang.sql` · viết tay

- viết tay: hàm, trigger
- Bất biến dòng kiện, kiểm bằng (spec 205 §5.10, D19; Documents/25 §8): với một dòng đơn, tổng (quantity - pending_drop_qty) trên các kiện chưa huỷ = quantity - cancelled_qty.

## V54 · 14/11/2026 · huy-dong

`db/migrations/20261114120126_huy-dong.sql` · sinh từ schema

- `order.package_lines`: + cột `pending_drop_qty`; + check `package_lines_pending_drop`
- `order.order_lines`: + cột `cancelled_qty`; + check `order_lines_cancelled_qty`

## V53 · 14/11/2026 · tach-kien-bat-bien

`db/migrations/20261114111333_tach-kien-bat-bien.sql` · viết tay

- viết tay: hàm, trigger
- Bất biến dòng kiện (spec 205 D1, D11; Documents/25 §8): tổng số lượng một dòng đơn trên các kiện chưa huỷ không vượt số lượng dòng đơn.

## V52 · 14/11/2026 · tach-kien

`db/migrations/20261114111324_tach-kien.sql` · sinh từ schema

- `order.package_lines`: + index `package_lines_order_line_id_index`

## V51 · 14/11/2026 · anh-san-pham

`db/migrations/20261114084930_anh-san-pham.sql` · sinh từ schema

- `product.product_images`: + index `product_images_product_position_uq`; + check `product_images_position_nonneg`

## V50 · 14/11/2026 · giao-hoan

`db/migrations/20261114040934_giao-hoan.sql` · sinh từ schema

- `order.packages`: + cột `delivery_posted_at`
- kèm câu sửa dữ liệu viết tay

## V49 · 13/11/2026 · dong-goi-rts

`db/migrations/20261113015939_dong-goi-rts.sql` · sinh từ schema

- `order.packages`: + cột `carrier_code`, `carrier_name`, `label_error`; + check `packages_carrier`

## V48 · 12/11/2026 · rls-thu-bao-mat-uy-quyen

`db/migrations/20261112132934_rls-thu-bao-mat-uy-quyen.sql` · viết tay

- viết tay: RLS, quyền, hàm, EXCLUDE
- RLS, quyền và chống trùng theo ngưỡng lệch hạn cho bảng mới `channel.shop_reauth_mails` (#312; vòng lặp của 0002 chỉ chạy một lần).

## V47 · 12/11/2026 · thu-bao-mat-uy-quyen

`db/migrations/20261112132932_thu-bao-mat-uy-quyen.sql` · sinh từ schema

- + bảng `channel.shop_reauth_mails`

## V46 · 12/11/2026 · moc-lay-don-xong

`db/migrations/20261112125504_moc-lay-don-xong.sql` · sinh từ schema

- `channel.shops`: + cột `orders_pulled_ok_at`; + check `shops_orders_pulled_ok_at`, `shops_reauth_orders_pulled`

## V45 · 12/11/2026 · rls-ban-sao-sku-san

`db/migrations/20261112115213_rls-ban-sao-sku-san.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `channel.remote_skus` (vòng lặp của 0002 chỉ chạy một lần; #220 đợt 2).

## V44 · 12/11/2026 · quyen-ghep-sku

`db/migrations/20261112115206_quyen-ghep-sku.sql` · viết tay

- viết tay: dữ liệu
- Quyền riêng để ghép SKU sàn với biến thể (#220, Documents/21 §18.6.5, Thành chốt 05/11/2026): CEO, Admin, Sale.

## V43 · 12/11/2026 · bo-dem-sku-chua-ghep

`db/migrations/20261112115151_bo-dem-sku-chua-ghep.sql` · sinh từ schema

- `channel.shops`: − cột `unmatched_sku_count`

## V42 · 12/11/2026 · ghep-sku-tay

`db/migrations/20261112115137_ghep-sku-tay.sql` · sinh từ schema

- + bảng `channel.remote_skus`
- `channel.listings`: + cột `pending_variant_id`, `pending_mode`, `pending_requested_by`, `pending_requested_at`, `mapping_self_approved`, `mapping_requested_by`; + check `listings_pending_mapping`, `listings_delisted_no_pending`, `listings_self_approved_has_approver`, `listings_mapping_second_person`; đổi check `listings_unmanaged_approved`
- `channel.raw_orders`: + index `raw_orders_lines_gin`
- `channel.shops`: + cột `remote_skus_synced_at`, `remote_skus_changed_since`, `remote_skus_full_failures`, `remote_skus_full_retry_at`, `remote_skus_full_failed_at`; + check `shops_remote_skus_retry`, `shops_remote_skus_failed_at`; đổi check `shops_setup_mode`

## V41 · 12/11/2026 · ledger-shop-theo-loai

`db/migrations/20261112103346_ledger-shop-theo-loai.sql` · sinh từ schema

- `finance.ledger_entries`: + check `ledger_entries_shop_by_kind`

## V40 · 12/11/2026 · cost-missing

`db/migrations/20261112103332_cost-missing.sql` · sinh từ schema

- `finance.order_settlements`: + cột `cost_missing`

## V39 · 12/11/2026 · rls-dong-kien-tra-la

`db/migrations/20261112090848_rls-dong-kien-tra-la.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `order.unmatched_return_parcel_lines` (#202; vòng lặp của 0002 chỉ chạy một lần).

## V38 · 12/11/2026 · yeu-cau-tra

`db/migrations/20261112090837_yeu-cau-tra.sql` · sinh từ schema

- + bảng `order.unmatched_return_parcel_lines`
- `channel.shops`: + cột `last_return_sync_at`
- `order.unmatched_return_parcels`: + cột `inspection_id`, `inspection_number`, `resolved_by`, `resolved_at`; + check `unmatched_return_parcels_resolved`
- `order.return_request_lines`: + cột `external_line_id`, `package_returned`; + unique `return_request_lines_request_id_order_line_id_unique`
- `order.return_requests`: + cột `kind`, `inspection_number`, `attention_note`, `raw_marketplace_status`, `ofc_status`, `dispute_in_progress`, `return_to`, `external_updated_at`, `reject_reason_id`, `reject_reason_label`, `received_at`, `received_by`, `refunded_at`; + check `return_requests_return_to`, `return_requests_received`, `return_requests_refunded`
- + enum `order.return_kind`

## V37 · 12/11/2026 · chuoi-phieu-kho-quyet-toan

`db/migrations/20261112015253_chuoi-phieu-kho-quyet-toan.sql` · sinh từ schema

- `finance.ledger_entries`: + cột `external_order_id`; đổi index `ledger_entries_external_txn_uq`
- `product.stock_documents`: + cột `source_number`, `order_id`, `shop_id`; + index `stock_documents_opening_uq`
- `product.goods_receipts`: + cột `follows_up_receipt_id`
- `product.purchase_request_lines`: + cột `excluded_reason`; + check `purchase_request_lines_excluded_reason`
- `product.purchase_requests`: + cột `supplier_order_code`
- `product.supplier_returns`: + cột `result_self_approved`; đổi check `supplier_returns_result_by`
- kèm câu sửa dữ liệu viết tay

## V36 · 11/11/2026 · chia-hang

`db/migrations/20261111152411_chia-hang.sql` · sinh từ schema

- `order.packages`: + cột `reserved_at`
- kèm câu sửa dữ liệu viết tay

## V35 · 11/11/2026 · listing-day-lai

`db/migrations/20261111145251_listing-day-lai.sql` · sinh từ schema

- `channel.listings`: + cột `replaces_listing_id`; đổi cột `push_error` (kiểu text → jsonb); + khoá ngoại `listings_replaces_listing_id_listings_id_fk`; đổi index `listings_shop_variant_uq`, `listings_shop_external_sku_uq`

## V34 · 11/11/2026 · push-error-chuyen-du-lieu

`db/migrations/20261111145247_push-error-chuyen-du-lieu.sql` · viết tay

- viết tay
- #219: `listings.push_error` từ chuỗi sang `{ code, message, at }` (Documents/21 §18.6.4).

## V33 · 11/11/2026 · cho-phan-hang-theo-phieu

`db/migrations/20261111071034_cho-phan-hang-theo-phieu.sql` · sinh từ schema

- `channel.shops`: + cột `allocation_stocktake_id`; + check `shops_allocation_pending`

## V32 · 11/11/2026 · tep-da-tai-len

`db/migrations/20261111062513_tep-da-tai-len.sql` · sinh từ schema

- `core.files`: + cột `uploaded_at`

## V31 · 11/11/2026 · chot-lech-tu-duyet

`db/migrations/20261111054536_chot-lech-tu-duyet.sql` · sinh từ schema

- `finance.order_settlements`: + cột `self_approved`

## V30 · 11/11/2026 · nhan-tu-duyet

`db/migrations/20261111052845_nhan-tu-duyet.sql` · sinh từ schema

- `core.state_transitions`: + cột `self_approved`

## V29 · 11/11/2026 · muc-dich-tep

`db/migrations/0028_muc-dich-tep.sql` · sinh từ schema

- `core.files`: + cột `purpose`; + check `files_size_positive`
- + enum `core.file_purpose`

## V28 · 09/11/2026 · ban-giao-tru-ton

`db/migrations/0027_ban-giao-tru-ton.sql` · sinh từ schema

- `order.packages`: + cột `handover_source`, `handover_reverted_by`, `pickup_confirmed_at`; + check `packages_handover_source`
- + enum `order.handover_source`
- kèm câu sửa dữ liệu viết tay

## V27 · 09/11/2026 · mot-phieu-kiem-hang-hoan-moi-nguon

`db/migrations/0026_mot-phieu-kiem-hang-hoan-moi-nguon.sql` · sinh từ schema

- `product.stock_documents`: + index `stock_documents_return_inspection_source_uq`

## V26 · 07/11/2026 · han-uy-quyen-gian-hang

`db/migrations/0025_han-uy-quyen-gian-hang.sql` · sinh từ schema

- `channel.shops`: + cột `auth_expires_at`

## V25 · 06/11/2026 · dong-kien-phieu-xuat

`db/migrations/0024_dong-kien-phieu-xuat.sql` · sinh từ schema

- `product.stock_document_lines`: + cột `source_line_id`

## V24 · 06/11/2026 · refresh-ho-token

`db/migrations/0023_refresh-ho-token.sql` · sinh từ schema

- `core.refresh_tokens`: + cột `family_id`, `rotated_at`; + index `refresh_tokens_family_id_index`

## V23 · 06/11/2026 · keo-lai-don-truoc-0017

`db/migrations/0022_keo-lai-don-truoc-0017.sql` · viết tay

- viết tay: dữ liệu
- Kéo lại một lần các đơn sàn lưu trước #260 (review PR #261 điểm 1, 5).

## V22 · 06/11/2026 · tran-don-mo

`db/migrations/0021_tran-don-mo.sql` · sinh từ schema

- `channel.shops`: + cột `open_orders_skipped`; + check `shops_open_orders_skipped`

## V21 · 06/11/2026 · pg-trgm-backfill-thiet-lap

`db/migrations/0020_pg-trgm-backfill-thiet-lap.sql` · viết tay

- viết tay: extension, dữ liệu
- #198.

## V20 · 06/11/2026 · phieu-dau-ky-gian-hang

`db/migrations/0019_phieu-dau-ky-gian-hang.sql` · sinh từ schema

- `channel.shops`: + cột `opening_stocktake_id`, `opening_stocktake_number`, `opening_stock_mode`, `unmatched_sku_count`, `open_orders_pulled_at`, `stock_pushed_at`; + index `shops_one_opening_stocktake_uq`; + check `shops_opening_stocktake`, `shops_setup_mode`
- `order.packages`: + cột `notices`

## V19 · 06/11/2026 · shop-return-window

`db/migrations/0018_shop-return-window.sql` · sinh từ schema

- `channel.shops`: + cột `return_window_days`; + check `shops_return_window_days`

## V18 · 05/11/2026 · thong-tin-don-san

`db/migrations/0017_thong-tin-don-san.sql` · sinh từ schema

- `order.packages`: + cột `shipment_provider`, `shipping_provider_type`, `shipping_type`, `promised_shipping_at`
- `order.order_lines`: + cột `thumbnail_url`, `attributes_label`, `external_sku_id`, `external_shop_sku`, `external_product_id`, `paid_price`, `tax_amount`, `shipping_amount`, `wallet_credits`, `cancel_reason`, `cancel_reason_detail`, `cancel_initiator`, `cancel_kind`, `reverse_order_id`, `return_status`
- `order.orders`: + cột `platform_payment_method`, `buyer_note`, `shipping_fee_original`, `shipping_fee_discount_seller`, `shipping_fee_discount_platform`
- + 2 enum `order`: line_cancel_initiator, line_cancel_kind

## V17 · 05/11/2026 · canh-bao-nguong

`db/migrations/0016_canh-bao-nguong.sql` · sinh từ schema

- `product.stock_levels`: + cột `alert_active`

## V16 · 03/11/2026 · bo-vai-tro-nhap-hang

`db/migrations/0015_bo-vai-tro-nhap-hang.sql` · viết tay

- viết tay: dữ liệu
- Bỏ vai trò có sẵn nhập hàng riêng (id ...0005, #188, chốt 02/11/2026): Nhân viên kho mang hai quyền của nó, thành viên, lời mời, tài liệu trợ lý đang gắn vai trò này chuyển sang Nhân viên kho.

## V15 · 02/11/2026 · phieu-nhan

`db/migrations/0014_phieu-nhan.sql` · sinh từ schema

- `product.goods_receipts`: + cột `self_approved`

## V14 · 02/11/2026 · han-muc-goi-san

`db/migrations/0013_han-muc-goi-san.sql` · sinh từ schema

- + bảng `channel.api_usage`

## V13 · 02/11/2026 · quyen-viec-loi

`db/migrations/0012_quyen-viec-loi.sql` · viết tay

- viết tay: dữ liệu
- Quyền xem và chạy lại việc nền lỗi (#102 A6), chỉ vai trò có sẵn CEO và Admin mang.

## V12 · 02/11/2026 · viec-nen-pgboss

`db/migrations/0011_viec-nen-pgboss.sql` · viết tay

- viết tay: schema, quyền, hàm, khoá ngoại, index, dữ liệu
- Schema pgboss của hàng việc nền (#102), sinh bằng getConstructionPlans('pgboss') của pg-boss 12.38.0 (schema bản 46).

## V11 · 29/10/2026 · don-so-hoa-don

`db/migrations/0010_don-so-hoa-don.sql` · sinh từ schema

- `order.orders`: + cột `invoice_number`

## V10 · 29/10/2026 · rls-bank-matches

`db/migrations/0009_rls-bank-matches.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `finance.bank_matches` (#117; vòng lặp của 0002 chỉ chạy một lần).

## V9 · 29/10/2026 · doi-soat-lazada

`db/migrations/0008_doi-soat-lazada.sql` · sinh từ schema

- + bảng `finance.bank_matches`
- `finance.ledger_entries`: + cột `external_transaction_id`; + index `ledger_entries_external_txn_uq`
- `finance.settlement_batches`: + cột `duplicates`, `wallet_diff`
- enum `finance.ledger_kind`: + `withdrawal`

## V8 · 29/10/2026 · de-nghi-nhap

`db/migrations/0007_de-nghi-nhap.sql` · sinh từ schema

- `product.purchase_request_lines`: + unique `purchase_request_lines_request_variant_uq`; − index `purchase_request_lines_request_id_index`
- `product.suppliers`: + cột `note`; + index `suppliers_company_lower_name_uq`

## V7 · 28/10/2026 · rls-category-maps

`db/migrations/0006_rls-category-maps.sql` · viết tay

- viết tay: RLS
- RLS cho bảng mới `channel.category_maps` (vòng lặp của 0002 chỉ chạy một lần).

## V6 · 28/10/2026 · listing-lazada

`db/migrations/0005_listing-lazada.sql` · sinh từ schema

- + bảng `channel.category_maps`
- `channel.listings`: + cột `stock_sync_error`, `price_sync_error`, `last_pushed_at`, `external_image_urls`

## V5 · 28/10/2026 · gian-hang-lazada

`db/migrations/0004_gian-hang-lazada.sql` · sinh từ schema

- `channel.shops`: + cột `refresh_expires_at`; + index `shops_platform_external_live_uq`

## V4 · 28/10/2026 · seed-quyen

`db/migrations/0003_seed-quyen.sql` · viết tay

- viết tay: dữ liệu
- Danh mục quyền và năm vai trò có sẵn, sinh từ src/modules/core/access/domain/catalog.ts (Documents/21 mục 8, bổ sung mục 15–20 và tiền theo Documents/19).

## V3 · 28/10/2026 · rls-quyen

`db/migrations/0002_rls-quyen.sql` · viết tay

- viết tay: RLS, quyền, hàm, trigger, EXCLUDE, index
- Cô lập dữ liệu giữa các công ty bằng Row-Level Security, quyền của role ứng dụng, và các ràng buộc Drizzle không sinh được.

## V2 · 28/10/2026 · tao-bang

`db/migrations/0001_tao-bang.sql` · sinh từ schema

- + 11 bảng `channel`: listings, price_calculations, raw_orders, shops, webhook_events, conversation_notes, conversation_tags, conversations, message_channels, messages, tags
- + 16 bảng `core`: member_roles, permissions, role_permissions, roles, audit_logs, attachments, files, refresh_tokens, companies, company_modules, outbox_messages, processed_events, state_transitions, accounts, invitations, memberships
- + 18 bảng `finance`: config_versions, doc_counters, ledger_entries, order_settlements, payment_vouchers, receipts, sales_invoice_lines, sales_invoices, settlement_batches, settlement_lines, settlement_statements, supplier_invoices, unmatched_receipts, gateway_configs, order_payments, payment_links, payment_transactions, webhook_events
- + 4 bảng `insight`: document_chunks, document_roles, documents, daily_channel_summary
- + 10 bảng `order`: package_lines, packages, unmatched_return_parcels, customer_identities, customers, doc_counters, order_lines, orders, return_request_lines, return_requests
- + 20 bảng `product`: attribute_values, attributes, categories, product_channel_specs, product_images, product_variants, products, variant_attribute_values, doc_counters, stock_document_lines, stock_documents, stock_levels, stock_moves, goods_receipt_lines, goods_receipts, purchase_request_lines, purchase_requests, supplier_return_lines, supplier_returns, suppliers
- + 10 enum `channel`: hidden_by, listing_mode, listing_status, marketplace, price_calc_status, shop_status, sync_state, message_kind, msg_direction, send_status
- + 7 enum `core`: role_kind, audit_action, company_status, module_code, transition_source, invitation_status, membership_status
- + 21 enum `finance`: settlement_batch_status, config_kind, config_status, discrepancy_reason, invoice_status, ledger_kind, match_status, receipt_source, settlement_line_kind, settlement_source, settlement_state, unmatched_reason, unmatched_status, voucher_purpose, voucher_status, gateway, link_status, payment_status, refund_status, txn_source, txn_status
- + 2 enum `insight`: doc_processing, order_source
- + 10 enum `order`: open_purpose, package_status, unmatched_parcel_status, channel_kind, order_outcome, order_source, order_status, payment_method, return_close_result, return_status
- + 14 enum `product`: business_status, reject_decision, stock_bucket, stock_document_kind, stock_document_status, stock_source_type, cancel_decision, delivery_mode, goods_receipt_status, purchase_request_source, purchase_request_status, short_resolution, supplier_return_source, supplier_return_status

## V1 · 28/10/2026 · mo-rong

`db/migrations/0000_mo-rong.sql` · viết tay

- viết tay: extension
- Extension cần có trước khi tạo bảng.
