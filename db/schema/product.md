# Schema `product` · Sản phẩm · lớp 2

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V155**, 28 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## `product.attribute_values`

Giá trị thuộc tính; `code` là phần ghép vào {VAL} của SKU (19-D27, D36). Hai tầng: công ty thêm giá trị riêng vào thuộc tính nền tảng (dòng có `company_id`); giá trị và mã không trùng giá trị nền tảng cùng thuộc tính (service).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `attribute_id` uuid · not null → `product.attributes.id` (khoá ngoại)
- `value` text · not null
- `code` text · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`id`, `attribute_id`) `attribute_values_id_attribute_uq`
- unique index (`attribute_id`, `lower("value")`) `attribute_values_platform_lower_value_uq` where `company_id is null`
- unique index (`attribute_id`, `code`) `attribute_values_platform_code_uq` where `company_id is null`
- unique index (`company_id`, `attribute_id`, `lower("value")`) `attribute_values_company_lower_value_uq` where `company_id is not null`
- unique index (`company_id`, `attribute_id`, `code`) `attribute_values_company_code_uq` where `company_id is not null`
- check `attribute_values_code_format`: `code ~ '^[A-Z0-9]{1,6}$'`
- check `attribute_values_value_length`: `char_length(value) <= 20`

Trỏ vào bảng này:

- `product.variant_attribute_values.attribute_value_id` (khoá ngoại)
- `product.product_attribute_value_images.attribute_value_id, attribute_id` (khoá ngoại viết tay)

## `product.attributes`

Thuộc tính (trục phân loại), hai tầng: 23 thuộc tính biến thể chuẩn (`platform_kind`) là dòng nền tảng (#531).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `name` text · not null
- `platform_kind` text · null
  Thuộc tính chuẩn sàn: chỉ dòng nền tảng mang (CHECK), mỗi loại một dòng; API chỉ đọc.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique index (`lower("name")`) `attributes_platform_lower_name_uq` where `company_id is null`
- unique index (`company_id`, `lower("name")`) `attributes_company_lower_name_uq` where `company_id is not null`
- unique index (`platform_kind`) `attributes_platform_kind_uq` where `company_id is null and platform_kind is not null`
- check `attributes_platform_kind`: `platform_kind in ('color', 'size', 'shoe_size', 'bra_size', 'age', 'ring_size', 'storage', 'version', 'screen_size', 'connector', 'length', 'battery_capacity', 'voltage', 'power', 'volume', 'weight', 'flavor', 'scent', 'pack', 'diaper_size', 'bed_size', 'style', 'compatible_model')`
- check `attributes_name_length`: `char_length(name) <= 15`

Trỏ vào bảng này:

- `product.attribute_values.attribute_id` (khoá ngoại)
- `product.group_allowed_attributes.attribute_id` (khoá ngoại)
- `product.product_groups.axis1_attribute_id` (khoá ngoại)
- `product.product_groups.axis2_attribute_id` (khoá ngoại)
- `product.products.image_attribute_id` (khoá ngoại)
- `channel.axis_mappings.attribute_id` (tham chiếu, không có khoá ngoại)

## `product.company_group_settings`

Cài đặt của một công ty trên nhóm nền tảng (dữ liệu chung, Documents/19 D12): ẩn nhóm không bán, gợi ý giá và ngưỡng tồn riêng. Chỉ cho nhóm nền tảng (service kiểm); nhóm của công ty giữ gợi ý ở `product_groups`. Chưa có dòng là không ẩn, gợi ý trống, `version` 0 (API). RLS `company_isolation` ở `*_du-lieu-chung-rls`.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `group_id` uuid · khoá chính → `product.product_groups.id` (khoá ngoại, ON DELETE cascade)
- `hidden` boolean · not null · mặc định `false`
- `margin_coefficient` numeric(18,2) · null
- `price_rounding` integer · null
- `reorder_lead_days` integer · null
- `reorder_safety_qty` integer · null
- `reorder_default_qty` integer · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `group_id`)
- index (`group_id`) `company_group_settings_group_id_index`
- check `company_group_settings_margin_coefficient`: `margin_coefficient >= 1`
- check `company_group_settings_price_rounding`: `price_rounding > 0`
- check `company_group_settings_reorder_config`: `reorder_lead_days >= 0 and reorder_safety_qty >= 0 and reorder_default_qty >= 0`

## `product.company_product_settings`

Cài đặt sản phẩm của công ty (D11): mẫu SKU, số {SEQ} kế tiếp, gợi ý mặc định. Một dòng mỗi công ty, tạo cùng công ty (`seedCompanyDefaults`); RLS ở migration `*_nhom-hang-rls-quyen`. Cấp số SKU không tăng `version` (khoá advisory `lockVariants` tuần tự hoá việc cấp số).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `sku_pattern` text · not null · mặc định `'SP{SEQ:5}-{VAL}'`
- `sku_next_seq` integer · not null · mặc định `1`
- `margin_coefficient` numeric(18,2) · null
- `price_rounding` integer · null
- `reorder_lead_days` integer · null
- `reorder_safety_qty` integer · null
- `reorder_default_qty` integer · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- check `company_product_settings_sku_next_seq`: `sku_next_seq >= 1`
- check `company_product_settings_margin_coefficient`: `margin_coefficient >= 1`
- check `company_product_settings_price_rounding`: `price_rounding > 0`
- check `company_product_settings_reorder_config`: `reorder_lead_days >= 0 and reorder_safety_qty >= 0 and reorder_default_qty >= 0`

## `product.doc_counters`

Bộ đếm số chứng từ của cả module lớn `product` (phiếu kho, đề nghị nhập, phiếu nhận, phiếu trả NCC): cấp số bằng `UPDATE … SET next_number = next_number + 1 RETURNING` trong giao dịch. `period` trống khi đánh số không theo kỳ.

Khai ở `src/modules/product/inventory/repository/schema.ts` · module con `inventory` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `doc_type` text · khoá chính
- `period` text · khoá chính · mặc định `''`
- `next_number` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `doc_type`, `period`)

## `product.goods_receipt_lines`

Dòng phiếu nhận: số NCC báo giao, số đạt (vào tồn thực), số lỗi giữ lại (vào chờ xử lý), số trả tại chỗ. `shortage_qty` tự tính. `đạt + lỗi ≤ còn chờ` của dòng đề nghị do service kiểm (khác bảng, `over_outstanding`). `variant_id` trống khi dòng đề nghị là sản phẩm mới chưa có SKU; ghi sổ điền SKU vừa tạo. Service ép phiếu đã ghi sổ không còn dòng trống mà có đạt hoặc lỗi giữ > 0 (Documents/19, 21 mục 16.3).

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `receipt_id` uuid · not null → `product.goods_receipts.id` (khoá ngoại)
- `request_line_id` uuid · not null → `product.purchase_request_lines.id` (khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `declared_qty` integer · not null · mặc định `0`
- `accepted_qty` integer · not null · mặc định `0`
- `defective_qty` integer · not null · mặc định `0`
- `returned_on_spot_qty` integer · not null · mặc định `0`
- `shortage_qty` integer · null · sinh từ `declared_qty - accepted_qty - defective_qty - returned_on_spot_qty`
- `reason` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`receipt_id`, `request_line_id`) `goods_receipt_lines_receipt_id_request_line_id_unique`
- index (`variant_id`) `goods_receipt_lines_variant_id_index`
- check `goods_receipt_lines_counts`: `declared_qty >= 0 and accepted_qty >= 0 and defective_qty >= 0 and returned_on_spot_qty >= 0`
- check `goods_receipt_lines_within_declared`: `accepted_qty + defective_qty + returned_on_spot_qty <= declared_qty`

## `product.goods_receipts`

Một đợt NCC giao hàng cho một đề nghị. Ghi sổ một lần (`posted_by` khác người lập đề nghị, service kiểm vì khác bảng); sau đó chỉ theo dõi chỗ giao thiếu. `check_deadline`: người giao đã đi thì phải kiểm xong trong 24 giờ.

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `request_id` uuid · not null → `product.purchase_requests.id` (khoá ngoại)
- `delivery_mode` enum `product.delivery_mode` · not null: `driver_waiting` | `driver_left`
- `box_count` integer · null
- `status` enum `product.goods_receipt_status` · not null · mặc định `'counting'`: `counting` | `matched` | `short` | `resolved` | `cancelled`
- `check_deadline` timestamptz · null
- `short_resolution` enum `product.short_resolution` · null: `follow_up` | `close_short` | `supplier_wrong`
- `follow_up_receipt_id` uuid · null → `product.goods_receipts.id` (tham chiếu, không có khoá ngoại)
- `follows_up_receipt_id` uuid · null → `product.goods_receipts.id` (tham chiếu, không có khoá ngoại)
  Phiếu `short` cùng đề nghị mà đợt này giao bù, chỉ để tham chiếu (25 §4.1, #244).
- `resolution_note` text · null
- `resolved_by` uuid · null → `core.accounts` (người thao tác)
- `resolved_at` timestamptz · null
- `note` text · null
- `status_reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `posted_by` uuid · null → `core.accounts` (người thao tác)
- `posted_at` timestamptz · null
- `self_approved` boolean · not null · mặc định `false`
  Người ghi sổ là người lập đề nghị, được tự làm vì là CEO hoặc công ty một người (Documents/25 §11).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `number`) `goods_receipts_company_id_number_unique`
- index (`request_id`) `goods_receipts_request_id_index`
- check `goods_receipts_box_count`: `box_count > 0`
- check `goods_receipts_resolved`: `(status = 'resolved') = (short_resolution is not null)`
- check `goods_receipts_follow_up`: `(short_resolution = 'follow_up') = (follow_up_receipt_id is not null)`
- check `goods_receipts_posted`: `(status in ('matched', 'short', 'resolved')) = (posted_at is not null)`

Trỏ vào bảng này:

- `product.goods_receipt_lines.receipt_id` (khoá ngoại)
- `product.goods_receipts.follow_up_receipt_id` (tham chiếu, không có khoá ngoại)
- `product.goods_receipts.follows_up_receipt_id` (tham chiếu, không có khoá ngoại)

## `product.group_allowed_attributes`

Thuộc tính biến thể được phép của danh mục (#531, Documents/21 mục 5.7, 19 §3.2): chỉ để gợi ý và lọc ô chọn, không ràng buộc `variant_attribute_values` (sản phẩm dùng thuộc tính ngoài danh sách vẫn lưu, FE cảnh báo). Hai tầng: danh mục nền tảng có dòng nền tảng; công ty thêm dòng của mình vào danh mục nền tảng (không bỏ được dòng nền tảng); danh mục của công ty chỉ có dòng công ty. Trục chuẩn luôn nằm trong danh sách (migration ghi, service tự thêm). RLS `tier_*` ở migration `*_danh-muc-chuan-du-lieu`.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `group_id` uuid · not null → `product.product_groups.id` (khoá ngoại, ON DELETE cascade)
- `attribute_id` uuid · not null → `product.attributes.id` (khoá ngoại, ON DELETE cascade)
  Xoá thuộc tính của công ty thì rút khỏi danh sách.
- `position` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`group_id`, `attribute_id`, `company_id`) NULLS NOT DISTINCT `group_allowed_attributes_group_attr_company_uq`
- index (`attribute_id`) `group_allowed_attributes_attribute_id_index`
- check `group_allowed_attributes_position`: `position >= 0`

## `product.group_spec_fields`

Mẫu thông số của nhóm hàng: thông số nào, bắt buộc hay không, thứ tự. `required` chỉ tính vào độ hoàn thiện (missing `specs`), không chặn lưu sản phẩm (sản phẩm từ đề nghị nhập, từ SKU sàn chưa có thông số).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
  Hai tầng: dòng nền tảng là mẫu chuẩn; dòng công ty trên nhóm nền tảng là phần công ty thêm (chốt 1).
- `group_id` uuid · not null → `product.product_groups.id` (khoá ngoại, ON DELETE cascade)
- `field_id` uuid · not null → `product.spec_fields.id` (khoá ngoại, ON DELETE restrict)
- `required` boolean · not null · mặc định `false`
- `position` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`group_id`, `field_id`, `company_id`) NULLS NOT DISTINCT `group_spec_fields_group_field_company_uq`
- index (`field_id`) `group_spec_fields_field_id_index`
- check `group_spec_fields_position`: `position >= 0`

## `product.product_attribute_value_images`

Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/19 §3.2): áo 3 màu × 4 size có 3 dòng. Hai khoá ngoại ghép `pavi_product_fk` `(product_id, attribute_id) → products(id, image_attribute_id)` và `pavi_value_fk` `(attribute_value_id, attribute_id) → attribute_values(id, attribute_id)` viết ở migration `--custom` `*_anh-phan-loai-rls` (drizzle-kit sinh khoá ngoại trước unique đích, db/CLAUDE.md). `file_id` ở module files, không khoá ngoại chéo schema.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `product_id` uuid · not null → `product.products.id` (khoá ngoại viết tay)
- `attribute_id` uuid · not null → `product.products.image_attribute_id` (khoá ngoại viết tay)
- `attribute_value_id` uuid · not null → `product.attribute_values.id` (khoá ngoại viết tay)
- `file_id` uuid · not null → `core.files.id` (tham chiếu, không có khoá ngoại)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`product_id`, `attribute_value_id`) `pavi_product_value_uq`
- index (`file_id`) `product_attribute_value_images_file_id_index`
- khoá ngoại viết tay (`product_id`, `attribute_id`) → `product.products` (`id`, `image_attribute_id`), ở `db/migrations/20261118183221_anh-phan-loai-rls.sql`
- khoá ngoại viết tay (`attribute_value_id`, `attribute_id`) → `product.attribute_values` (`id`, `attribute_id`), ở `db/migrations/20261118183221_anh-phan-loai-rls.sql`

## `product.product_groups`

Nhóm hàng (Documents/19 D11, 21 mục 5.2): một cấp, không gắn sàn, không gắn SKU. Tên không trùng theo chữ thường trong tầng. Gợi ý `null` thì theo cài đặt công ty; nhóm nền tảng không mang gợi ý (gợi ý theo công ty ở `company_group_settings`).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `name` text · not null
- `margin_coefficient` numeric(18,2) · null
- `price_rounding` integer · null
- `reorder_lead_days` integer · null
- `reorder_safety_qty` integer · null
- `reorder_default_qty` integer · null
- `axis1_attribute_id` uuid · null → `product.attributes.id` (khoá ngoại, ON DELETE restrict)
  Trục phân loại chuẩn của nhóm (thông số sản phẩm, Documents/19 §3.2, 21 §5.5): form tạo sản phẩm chọn sẵn, người dùng đổi được; không ràng buộc sản phẩm đã có. Không có cờ "nhóm cần bảng kích cỡ": luật theo category sàn (`size_chart_missing`, 21 §18.5).
- `axis2_attribute_id` uuid · null → `product.attributes.id` (khoá ngoại, ON DELETE restrict)
- `renamed_from` text · null
  Gộp 12 danh mục cũ vào 27 danh mục chuẩn (#531, Documents/21 mục 5.7): tên cũ khi đổi tên giữ id, và danh mục hẹp hơn tách ra (FE gợi ý chuyển sản phẩm, người dùng tự xác nhận). Chỉ dòng nền tảng; migration ghi.
- `split_into` uuid[] · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique index (`lower("name")`) `product_groups_platform_lower_name_uq` where `company_id is null`
- unique index (`company_id`, `lower("name")`) `product_groups_company_lower_name_uq` where `company_id is not null`
- check `product_groups_margin_coefficient`: `margin_coefficient >= 1`
- check `product_groups_price_rounding`: `price_rounding > 0`
- check `product_groups_reorder_config`: `reorder_lead_days >= 0 and reorder_safety_qty >= 0 and reorder_default_qty >= 0`
- check `product_groups_axis_order`: `axis2_attribute_id is null or axis1_attribute_id is not null`
- check `product_groups_axis_distinct`: `axis1_attribute_id <> axis2_attribute_id`
- check `product_groups_merge_platform`: `company_id is null or (renamed_from is null and split_into is null)`

Trỏ vào bảng này:

- `product.company_group_settings.group_id` (khoá ngoại)
- `product.group_allowed_attributes.group_id` (khoá ngoại)
- `product.group_spec_fields.group_id` (khoá ngoại)
- `product.products.group_id` (khoá ngoại)
- `product.purchase_request_lines.new_group_id` (tham chiếu, không có khoá ngoại)
- `channel.platform_category_group_maps.group_id` (tham chiếu, không có khoá ngoại)

## `product.product_images`

Ảnh sản phẩm theo thứ tự, `position` 0 là ảnh đại diện (#303); `file_id` ở module files, không đặt khoá ngoại chéo schema. Mỗi vị trí một ảnh; `PUT` thay toàn bộ bằng xoá rồi chèn trong một giao dịch.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `product_id` uuid · not null → `product.products.id` (khoá ngoại)
- `file_id` uuid · not null → `core.files.id` (tham chiếu, không có khoá ngoại)
- `position` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`product_id`) `product_images_product_id_index`
- index (`file_id`) `product_images_file_id_index`
- unique index (`product_id`, `position`) `product_images_product_position_uq`
- check `product_images_position_nonneg`: `position >= 0`

## `product.product_spec_values`

Giá trị thông số của sản phẩm cha: select một dòng `option_id`, multiselect mỗi lựa chọn một dòng, text/number/date một dòng `value_text`. Khoá ngoại ghép `psv_option_fk` `(option_id, field_id) → spec_field_options(id, field_id)` viết ở migration `*_thong-so-rls` (lựa chọn chỉ thuộc đúng thông số của nó). Không phụ thuộc mẫu nhóm.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `product_id` uuid · not null → `product.products.id` (khoá ngoại, ON DELETE cascade)
- `field_id` uuid · not null → `product.spec_fields.id` (khoá ngoại, ON DELETE restrict)
- `option_id` uuid · null → `product.spec_field_options.id` (khoá ngoại viết tay, ON DELETE restrict)
- `value_text` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`product_id`, `field_id`, `option_id`) `product_spec_values_option_uq`
- unique index (`product_id`, `field_id`) `product_spec_values_text_uq` where `option_id is null`
- index (`field_id`) `product_spec_values_field_id_index`
- index (`option_id`) `product_spec_values_option_id_index`
- check `product_spec_values_one_of`: `(option_id is null) <> (value_text is null)`
- check `product_spec_values_text_length`: `value_text is null or char_length(value_text) between 1 and 2000`
- khoá ngoại viết tay (`option_id`, `field_id`) → `product.spec_field_options` (`id`, `field_id`), ON DELETE restrict, ở `db/migrations/20261120210458_thong-so-rls.sql`

## `product.product_variants`

Biến thể (SKU); SKU không cấp lại kể cả sau khi lưu trữ (Documents/21 P5). Giá chuẩn, giá muốn thực nhận và biên tối thiểu là đầu vào của bộ lọc giá theo sàn (25 §6.2); cân nặng, kích thước sàn dùng để tính phí ship. `source_request_line_id` là dòng đề nghị nhập sinh ra SKU (purchasing, không đặt khoá ngoại chéo module con).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `product_id` uuid · not null → `product.products.id` (khoá ngoại)
- `sku` text · not null
- `business_status` enum `product.business_status` · not null · mặc định `'selling'`: `selling` | `paused` | `discontinued` | `archived`
- `archived_at` timestamptz · null
- `standard_price` numeric(18,2) · null
- `target_net_price` numeric(18,2) · null
- `min_margin_pct` numeric(5,2) · null
- `weight_g` integer · null
- `length_mm` integer · null
- `width_mm` integer · null
- `height_mm` integer · null
- `source_request_line_id` uuid · null → `product.purchase_request_lines.id` (tham chiếu, không có khoá ngoại)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `sku`) `product_variants_company_id_sku_unique`
- index (`product_id`) `product_variants_product_id_index`
- check `product_variants_archived`: `(business_status = 'archived') = (archived_at is not null)`
- check `product_variants_prices`: `standard_price >= 0 and target_net_price >= 0`
- check `product_variants_dimensions`: `weight_g between 1 and 50000 and length_mm between 1 and 2000 and width_mm between 1 and 2000 and height_mm between 1 and 2000`
- check `product_variants_sku_length`: `char_length(sku) <= 50`

Trỏ vào bảng này:

- `product.variant_attribute_values.variant_id` (khoá ngoại)
- `product.goods_receipt_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `product.purchase_request_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `product.stock_document_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `product.stock_document_lines.actual_variant_id` (tham chiếu, không có khoá ngoại)
- `product.stock_levels.variant_id` (tham chiếu, không có khoá ngoại)
- `product.stock_moves.variant_id` (tham chiếu, không có khoá ngoại)
- `product.supplier_return_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `order.order_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `order.package_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `order.return_request_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `order.unmatched_return_parcel_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_package_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `finance.sales_invoice_lines.variant_id` (tham chiếu, không có khoá ngoại)
- `channel.listings.variant_id` (tham chiếu, không có khoá ngoại)
- `channel.listings.pending_variant_id` (tham chiếu, không có khoá ngoại)
- `channel.price_calculations.variant_id` (tham chiếu, không có khoá ngoại)

## `product.products`

Sản phẩm; đổi nhóm hàng được, SKU không đổi theo (Documents/21 P6, 19/11/2026). Không có trạng thái lưu riêng: trạng thái suy từ SKU con (#204). `code` là mã cha cấp lúc tạo, không route nào sửa (spec 204 D5).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `group_id` uuid · not null → `product.product_groups.id` (khoá ngoại)
- `name` text · not null
- `code` text · not null
- `description` text · null
- `size_chart_file_id` uuid · null → `core.files.id` (tham chiếu, không có khoá ngoại)
  Ảnh bảng kích cỡ (#347): một ảnh mỗi sản phẩm, tệp ở module `files` như ảnh sản phẩm (không khoá ngoại sang `core`).
- `image_attribute_id` uuid · null → `product.attributes.id` (khoá ngoại)
  Thuộc tính gắn ảnh (#340): trục mà mỗi giá trị mang một ảnh phân loại; null là chưa chọn. Service chỉ nhận trục của sản phẩm (khoá ngoại bỏ qua RLS).
- `origin_country` text · null
  Xuất xứ (mã ISO 3166-1 alpha-2) và thương hiệu dùng chung mọi sàn (#340); adapter sàn tự đổi sang giá trị của sàn.
- `brand` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`id`, `image_attribute_id`) `products_id_image_attribute_uq`
- unique index (`company_id`, `lower("name")`) `products_company_lower_name_uq`
- unique index (`company_id`, `code`) `products_company_code_uq`
- index (`group_id`) `products_group_id_index`
- check `products_origin_country`: `origin_country is null or origin_country ~ '^[A-Z]{2}$'`
- check `products_brand_length`: `brand is null or char_length(brand) <= 100`

Trỏ vào bảng này:

- `product.product_images.product_id` (khoá ngoại)
- `product.product_spec_values.product_id` (khoá ngoại)
- `product.product_variants.product_id` (khoá ngoại)
- `product.product_attribute_value_images.product_id, attribute_id` (khoá ngoại viết tay)
- `product.purchase_product_drafts.product_id` (tham chiếu, không có khoá ngoại)
- `product.purchase_request_lines.new_parent_product_id` (tham chiếu, không có khoá ngoại)
- `channel.product_specs.product_id` (tham chiếu, không có khoá ngoại)
- `channel.shop_products.product_id` (tham chiếu, không có khoá ngoại)

## `product.purchase_product_drafts`

Bản soạn trước nội dung của **một sản phẩm cha mới** trên một đề nghị (Documents/19 `purchase_product_drafts`, 21 mục 16.3 "Bản soạn trước", 29 bước 1); các dòng cùng tên cha mới dùng chung. `parent_key` = tên cha mới chữ thường đã gộp khoảng trắng. Ghi sổ phiếu nhận tạo cha thì chép sang sản phẩm và đặt `product_id`; từ đó phần sản phẩm chỉ đọc. `image_file_ids`, `size_chart_file_id`, `option_images.fileId` là tệp của module files (không khoá ngoại chéo, như `product_images.file_id`); `specs` jsonb không khoá ngoại tới `spec_fields` vì mẫu nhóm có thể đổi trước lúc hàng về, kiểm lại lúc chép. `variant_facts` khoá theo `optionValues` của dòng (dòng nháp có thể xoá, thêm lại). `updated_by`: người soạn gần nhất, nhật ký lúc chép ghi người này.

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `request_id` uuid · not null → `product.purchase_requests.id` (khoá ngoại, ON DELETE cascade)
- `parent_key` text · not null
- `description` text · null
- `brand` text · null
- `origin_country` text · null
- `image_file_ids` uuid[] · not null · mặc định `'{}'::uuid[]`
- `size_chart_file_id` uuid · null → `core.files.id` (tham chiếu, không có khoá ngoại)
- `specs` jsonb · not null · mặc định `'[]'::jsonb`
  Cùng hình dạng `specs` của `POST /catalog/products` (21 mục 5.5): `[{ fieldId, optionIds?, newValues?, value? }]`.
- `image_axis` text · null
  Tên trục gắn ảnh (không phải số thứ tự: trục của cha mới xếp theo thứ tự dòng).
- `option_images` jsonb · not null · mặc định `'[]'::jsonb`
- `variant_defaults` jsonb · not null · mặc định `'{}'::jsonb`
- `variant_facts` jsonb · not null · mặc định `'[]'::jsonb`
- `product_id` uuid · null → `product.products.id` (tham chiếu, không có khoá ngoại)
- `updated_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`request_id`, `parent_key`) `purchase_product_drafts_request_parent_uq`
- check `purchase_product_drafts_images`: `cardinality(image_file_ids) <= 9`
- check `purchase_product_drafts_brand`: `brand is null or char_length(brand) <= 100`
- check `purchase_product_drafts_origin`: `origin_country is null or origin_country ~ '^[A-Z]{2}$'`

## `product.purchase_request_lines`

Dòng đề nghị. Dòng sản phẩm mới chưa có `variant_id` tới lần ghi sổ phiếu nhận đầu tiên có đạt hoặc lỗi giữ > 0; lúc đó hệ thống tạo SKU rồi điền vào (Documents/21 mục 16.3, đổi 22/11/2026; trước đây điền khi duyệt). `còn chờ = ordered − received − defective − closed_short` (25 §3.1), luôn ≥ 0. `excluded`: CEO loại dòng khi duyệt.

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `request_id` uuid · not null → `product.purchase_requests.id` (khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `new_parent_product_id` uuid · null → `product.products.id` (tham chiếu, không có khoá ngoại)
  Dòng sản phẩm mới thuộc sản phẩm cha có sẵn (catalog `products`).
- `new_parent_name` text · null
  Tên sản phẩm cha mới (đã gộp khoảng trắng); các dòng cùng tên (chữ thường) trong đề nghị gộp một cha.
- `new_group_id` uuid · null → `product.product_groups.id` (tham chiếu, không có khoá ngoại)
  Nhóm hàng của cha mới; cha có sẵn thì trống.
- `new_option_values` jsonb · null
  Giá trị phân loại theo thứ tự trục, mảng `[{ axis, value }]` (object jsonb tự sắp lại khoá, mất thứ tự trục).
- `ordered_qty` integer · not null
- `received_qty` integer · not null · mặc định `0`
- `defective_qty` integer · not null · mặc định `0`
- `closed_short_qty` integer · not null · mặc định `0`
- `unit_price` numeric(18,2) · not null
- `excluded` boolean · not null · mặc định `false`
- `excluded_reason` text · null
  Lý do CEO loại dòng (bắt buộc khi loại, #243).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`request_id`, `variant_id`) `purchase_request_lines_request_variant_uq`
- index (`variant_id`) `purchase_request_lines_variant_id_index`
- check `purchase_request_lines_item`: `variant_id is not null or new_parent_product_id is not null or new_parent_name is not null`
- check `purchase_request_lines_one_parent`: `new_parent_product_id is null or new_parent_name is null`
- check `purchase_request_lines_new_parent_group`: `new_parent_name is null or new_group_id is not null`
- check `purchase_request_lines_ordered`: `ordered_qty > 0`
- check `purchase_request_lines_excluded_reason`: `not excluded or excluded_reason is not null`
- check `purchase_request_lines_counts`: `received_qty >= 0 and defective_qty >= 0 and closed_short_qty >= 0`
- check `purchase_request_lines_outstanding`: `ordered_qty - received_qty - defective_qty - closed_short_qty >= 0`
- check `purchase_request_lines_unit_price`: `unit_price >= 0`

Trỏ vào bảng này:

- `product.goods_receipt_lines.request_line_id` (khoá ngoại)
- `product.product_variants.source_request_line_id` (tham chiếu, không có khoá ngoại)

## `product.purchase_requests`

Một lần xin nhập hàng của một NCC. Giá chốt cứng khi duyệt; số "đang về" tính từ dòng, không lưu.

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `supplier_id` uuid · null → `product.suppliers.id` (khoá ngoại)
- `status` enum `product.purchase_request_status` · not null · mặc định `'draft'`: `draft` | `pending_approval` | `changes_requested` | `rejected` | `approved` | `ordered` | `partially_received` | `received` | `closed_short` | `cancelled`
- `source` enum `product.purchase_request_source` · not null · mặc định `'manual'`: `manual` | `reorder` | `replacement`
- `source_return_id` uuid · null → `product.supplier_returns.id` (tham chiếu, không có khoá ngoại)
- `expected_delivery_date` date · null
- `supplier_order_code` text · null
  Mã đơn bên NCC ghi lúc đặt (tuỳ chọn, 25 §3.2, #243).
- `note` text · null
- `status_reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `approved_at` timestamptz · null
- `self_approved` boolean · not null · mặc định `false`
- `ordered_by` uuid · null → `core.accounts` (người thao tác)
- `ordered_at` timestamptz · null
- `closed_by` uuid · null → `core.accounts` (người thao tác)
- `closed_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `number`) `purchase_requests_company_id_number_unique`
- index (`status`) `purchase_requests_status_index`
- index (`supplier_id`) `purchase_requests_supplier_id_index`
- check `purchase_requests_second_person`: `approved_by is null or approved_by is distinct from created_by or self_approved`
- check `purchase_requests_supplier`: `status in ('draft', 'cancelled') or supplier_id is not null`
- check `purchase_requests_replacement`: `(source = 'replacement') = (source_return_id is not null)`

Trỏ vào bảng này:

- `product.goods_receipts.request_id` (khoá ngoại)
- `product.purchase_product_drafts.request_id` (khoá ngoại)
- `product.purchase_request_lines.request_id` (khoá ngoại)
- `product.supplier_returns.replacement_request_id` (tham chiếu, không có khoá ngoại)
- `finance.supplier_invoices.purchase_request_id` (tham chiếu, không có khoá ngoại)

## `product.spec_field_options`

Lựa chọn của thông số select/multiselect, mỗi lựa chọn một dòng (để khoá ngoại từ giá trị và ánh xạ sàn theo lựa chọn). `(id, field_id)` là đích khoá ngoại ghép `psv_option_fk` (migration `*_thong-so-rls`).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
  Hai tầng: công ty thêm lựa chọn riêng vào thông số nền tảng (chốt 4).
- `field_id` uuid · not null → `product.spec_fields.id` (khoá ngoại, ON DELETE cascade)
- `value` text · not null
- `position` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`id`, `field_id`) `spec_field_options_id_field_uq`
- unique index (`field_id`, `lower("value")`) `spec_field_options_platform_lower_value_uq` where `company_id is null`
- unique index (`company_id`, `field_id`, `lower("value")`) `spec_field_options_company_lower_value_uq` where `company_id is not null`
- check `spec_field_options_value_length`: `char_length(value) between 1 and 60`
- check `spec_field_options_position`: `position >= 0`

Trỏ vào bảng này:

- `product.product_spec_values.option_id, field_id` (khoá ngoại viết tay)
- `channel.spec_option_mappings.option_id` (tham chiếu, không có khoá ngoại)

## `product.spec_fields`

Thư viện thông số của công ty (Documents/19 §3.2, 21 §5.5), dùng chung mọi nhóm hàng. `code` không sửa sau khi tạo: khoá để channel ánh xạ sang attribute sàn (`channel.spec_field_mappings`) và để AI nhập file đọc (#214). Thương hiệu, xuất xứ không ở đây (cột của `products`). RLS ở migration `*_thong-so-rls`.

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `code` text · not null
- `name` text · not null
- `input` text · not null
- `unit` text · null
- `allow_custom` boolean · not null · mặc định `false`
  select/multiselect nhận giá trị ngoài danh sách: tạo lựa chọn mới cùng giao dịch lưu sản phẩm.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique index (`code`) `spec_fields_platform_code_uq` where `company_id is null`
- unique index (`lower("name")`) `spec_fields_platform_lower_name_uq` where `company_id is null`
- unique index (`company_id`, `code`) `spec_fields_company_code_uq` where `company_id is not null`
- unique index (`company_id`, `lower("name")`) `spec_fields_company_lower_name_uq` where `company_id is not null`
- check `spec_fields_input`: `input in ('select', 'multiselect', 'text', 'number', 'date')`
- check `spec_fields_code_format`: `code ~ '^[a-z0-9_]{1,40}$'`
- check `spec_fields_name_length`: `char_length(name) between 1 and 40`
- check `spec_fields_unit`: `unit is null or (input = 'number' and char_length(unit) between 1 and 10)`

Trỏ vào bảng này:

- `product.group_spec_fields.field_id` (khoá ngoại)
- `product.product_spec_values.field_id` (khoá ngoại)
- `product.spec_field_options.field_id` (khoá ngoại)
- `channel.spec_field_mappings.field_id` (tham chiếu, không có khoá ngoại)

## `product.stock_document_lines`

Dòng phiếu kho. Kiểm kê: `book_qty`, `counted_qty` (chênh lệch = đếm − sổ). Kiểm hàng về: `expected_qty`, `scanned_qty` chia thành bán lại, hỏng, trả NCC; `actual_variant_id` khi sai mẫu. Loại khác dùng `quantity`. Phiếu xuất theo kiện: mỗi dòng kiện một dòng phiếu, `source_line_id` là id dòng kiện (uuid thường, không khoá ngoại sang `order`).

Khai ở `src/modules/product/inventory/repository/schema.ts` · module con `inventory` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `document_id` uuid · not null → `product.stock_documents.id` (khoá ngoại)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `quantity` integer · null
- `book_qty` integer · null
- `counted_qty` integer · null
- `expected_qty` integer · null
- `scanned_qty` integer · null
- `resell_qty` integer · null
- `damaged_qty` integer · null
- `to_supplier_qty` integer · null
- `actual_variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `source_line_id` uuid · null: đa hình: dòng của chứng từ nguồn
  Dòng của chứng từ nguồn: phiếu xuất theo kiện ghi id dòng kiện (lưới gọi lặp `ship`, spec #206 Q12).
- `unit_cost` numeric(18,2) · null
- `reason` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`document_id`) `stock_document_lines_document_id_index`
- index (`variant_id`) `stock_document_lines_variant_id_index`
- check `stock_document_lines_quantity`: `quantity > 0`
- check `stock_document_lines_counted`: `counted_qty >= 0`
- check `stock_document_lines_inspection`: `expected_qty >= 0 and scanned_qty >= 0 and resell_qty >= 0 and damaged_qty >= 0
        and to_supplier_qty >= 0`
- check `stock_document_lines_inspection_sum`: `scanned_qty is null or resell_qty + damaged_qty + to_supplier_qty = scanned_qty`

## `product.stock_documents`

Phiếu kho. Phiếu giảm đang `pending` làm tạm khoá phần giảm (tính khi đọc). Kiểm kê lưu thời điểm đếm và tồn sổ lúc đó để chênh lệch không lẫn biến động giữa lúc đếm và lúc duyệt; `is_opening` là kiểm kê đầu kỳ khi kết nối gian hàng đầu tiên. `source_type`/`source_id` trỏ kiện, yêu cầu trả hoặc phiếu sinh ra phiếu này.

Khai ở `src/modules/product/inventory/repository/schema.ts` · module con `inventory` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `kind` enum `product.stock_document_kind` · not null: `stocktake` | `write_off` | `to_quarantine` | `return_inspection` | `shipment` | `shipment_reversal`
- `status` enum `product.stock_document_status` · not null · mặc định `'draft'`: `draft` | `pending` | `posted` | `rejected` | `cancelled`
- `area` enum `product.stock_bucket` · not null · mặc định `'on_hand'`: `on_hand` | `quarantine`
- `counted_at` timestamptz · null
- `is_opening` boolean · not null · mặc định `false`
- `source_type` text · null
- `source_id` uuid · null: đa hình: chứng từ nguồn theo cột loại nguồn của bảng
- `source_number` text · null
  Số của chứng từ nguồn (mã kiện, mã yêu cầu trả) do bên lập phiếu đưa, để hiện mà không đọc chéo module.
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `claim_flag` boolean · not null · mặc định `false`
- `reject_decision` enum `product.reject_decision` · null: `restock` | `supplier_return`
- `note` text · null
- `status_reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `approved_at` timestamptz · null
- `self_approved` boolean · not null · mặc định `false`
- `posted_by` uuid · null → `core.accounts` (người thao tác)
- `posted_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `number`) `stock_documents_company_id_number_unique`
- index (`kind`, `status`) `stock_documents_kind_status_index`
- index (`source_type`, `source_id`) `stock_documents_source_type_source_id_index`
- unique index (`company_id`, `source_type`, `source_id`) `stock_documents_return_inspection_source_uq` where `kind = 'return_inspection'`
- unique index (`company_id`, `source_id`) `stock_documents_opening_uq` where `source_type = 'shop_setup' and status in ('draft', 'pending')`
- check `stock_documents_second_person`: `approved_by is null or approved_by is distinct from created_by or self_approved`
- check `stock_documents_shipment_source`: `kind not in ('shipment', 'shipment_reversal') or source_type is not distinct from 'package'`
- check `stock_documents_counted_at`: `kind <> 'stocktake' or counted_at is not null`
- check `stock_documents_opening`: `not is_opening or kind = 'stocktake'`
- check `stock_documents_posted`: `(status = 'posted') = (posted_at is not null)`

Trỏ vào bảng này:

- `product.stock_document_lines.document_id` (khoá ngoại)
- `order.return_requests.inspection_id` (tham chiếu, không có khoá ngoại)
- `order.unmatched_return_parcels.inspection_id` (tham chiếu, không có khoá ngoại)
- `channel.shops.opening_stocktake_id` (tham chiếu, không có khoá ngoại)
- `channel.shops.allocation_stocktake_id` (tham chiếu, không có khoá ngoại)

## `product.stock_levels`

Các con số lưu của SKU (25 §7.1, Documents/21 mục 15.1). Tạm khoá, đang về, đang thiếu, khả dụng tính khi đọc. Bất biến kiểu "không làm tệ hơn": tồn thực âm hoặc nhỏ hơn đang giữ chỉ được khi bật `invariant_broken` (bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt); cờ này là nhãn Tồn âm. `min_qty` là ngưỡng tồn (trống = chưa đặt).

Khai ở `src/modules/product/inventory/repository/schema.ts` · module con `inventory` · theo công ty (`company_id`)

Cột:

- `variant_id` uuid · khoá chính → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `on_hand` integer · not null · mặc định `0`
- `reserved` integer · not null · mặc định `0`
- `quarantine` integer · not null · mặc định `0`
- `avg_cost` numeric(18,2) · not null · mặc định `'0'`
- `min_qty` integer · null
- `invariant_broken` boolean · not null · mặc định `false`
- `alert_active` boolean · not null · mặc định `false`
  Đang ở dưới ngưỡng và đã báo (V31): chạm ngưỡng chỉ báo một lần, lên trên ngưỡng mới tắt (25 §7.5).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `variant_id`)
- check `stock_levels_reserved`: `reserved >= 0`
- check `stock_levels_quarantine`: `quarantine >= 0`
- check `stock_levels_min_qty`: `min_qty >= 0`
- check `stock_levels_invariant`: `(on_hand >= 0 and reserved <= on_hand) or invariant_broken`

## `product.stock_moves`

Thẻ kho, chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi biến động của tồn thực hoặc chờ xử lý là một dòng trỏ về chứng từ gốc (N2). Đang giữ không ghi thẻ kho: nguồn của nó là dòng kiện. `balance_after` là số của ngăn đó sau biến động, có thể âm trong hai ngoại lệ của `stock_levels`.

Khai ở `src/modules/product/inventory/repository/schema.ts` · module con `inventory` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `bucket` enum `product.stock_bucket` · not null: `on_hand` | `quarantine`
- `qty_change` integer · not null
- `balance_after` integer · not null
- `unit_cost` numeric(18,2) · null
- `source_type` enum `product.stock_source_type` · not null: `goods_receipt` | `stock_document` | `supplier_return`
- `source_id` uuid · not null: đa hình: chứng từ nguồn theo cột loại nguồn của bảng
- `source_line_id` uuid · null: đa hình: dòng của chứng từ nguồn
- `done_at` timestamptz · not null · mặc định `now()`
- `done_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- index (`variant_id`, `id`) `stock_moves_variant_id_id_index`
- index (`source_type`, `source_id`) `stock_moves_source_type_source_id_index`
- check `stock_moves_qty_change`: `qty_change <> 0`

## `product.supplier_return_lines`

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `return_id` uuid · not null → `product.supplier_returns.id` (khoá ngoại)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `quantity` integer · not null
- `unit_cost` numeric(18,2) · null
- `source_line_id` uuid · null: đa hình: dòng của chứng từ nguồn
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`return_id`) `supplier_return_lines_return_id_index`
- index (`variant_id`) `supplier_return_lines_variant_id_index`
- check `supplier_return_lines_quantity`: `quantity > 0`

## `product.supplier_returns`

Hàng lỗi trả NCC. Gửi xong thì chờ xử lý giảm. Người ghi kết quả khác người gửi; hoàn tiền bắt buộc số tiền; huỷ bắt buộc chọn nhập lại tồn hoặc xuất huỷ.

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `supplier_id` uuid · null → `product.suppliers.id` (khoá ngoại)
- `status` enum `product.supplier_return_status` · not null · mặc định `'draft'`: `draft` | `pending_approval` | `sent` | `refunded` | `replaced` | `returned_to_us` | `cancelled`
- `source` enum `product.supplier_return_source` · not null: `receipt_defect` | `quarantine` | `customer_return` | `write_off_rejected` | `manual`
- `source_id` uuid · null: đa hình: chứng từ nguồn theo cột loại nguồn của bảng
- `refund_amount` numeric(18,2) · null
- `replacement_request_id` uuid · null → `product.purchase_requests.id` (tham chiếu, không có khoá ngoại)
- `cancel_decision` enum `product.cancel_decision` · null: `restock` | `write_off`
- `note` text · null
- `status_reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `approved_at` timestamptz · null
- `self_approved` boolean · not null · mặc định `false`
- `sent_by` uuid · null → `core.accounts` (người thao tác)
- `sent_at` timestamptz · null
- `result_by` uuid · null → `core.accounts` (người thao tác)
- `result_at` timestamptz · null
- `result_self_approved` boolean · not null · mặc định `false`
  Người ghi kết quả là người gửi, được nhờ ngoại lệ tự duyệt (25 §11, #210).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `number`) `supplier_returns_company_id_number_unique`
- index (`status`) `supplier_returns_status_index`
- check `supplier_returns_second_person`: `approved_by is null or approved_by is distinct from created_by or self_approved`
- check `supplier_returns_supplier`: `status in ('draft', 'cancelled') or supplier_id is not null`
- check `supplier_returns_refund`: `(status = 'refunded') = (refund_amount is not null)`
- check `supplier_returns_refund_amount`: `refund_amount >= 1`
- check `supplier_returns_cancel`: `(status = 'cancelled') = (cancel_decision is not null)`
- check `supplier_returns_result_by`: `result_by is null or result_by is distinct from sent_by or result_self_approved`

Trỏ vào bảng này:

- `product.supplier_return_lines.return_id` (khoá ngoại)
- `product.purchase_requests.source_return_id` (tham chiếu, không có khoá ngoại)

## `product.suppliers`

Nhà cung cấp; ngừng giao dịch thì `active = false` (`supplier_inactive`), không xoá. Tên không trùng (chữ thường).

Khai ở `src/modules/product/purchasing/repository/schema.ts` · module con `purchasing` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `name` text · not null
- `phone` text · null
- `email` text · null
- `address` text · null
- `note` text · null
- `active` boolean · not null · mặc định `true`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique index (`company_id`, `lower("name")`) `suppliers_company_lower_name_uq`

Trỏ vào bảng này:

- `product.purchase_requests.supplier_id` (khoá ngoại)
- `product.supplier_returns.supplier_id` (khoá ngoại)
- `finance.supplier_invoices.supplier_id` (tham chiếu, không có khoá ngoại)

## `product.variant_attribute_values`

Tổ hợp giá trị của biến thể; `position` giữ thứ tự thuộc tính để ghép {VAL} và nhãn (D8).

Khai ở `src/modules/product/catalog/repository/schema.ts` · module con `catalog` · theo công ty (`company_id`)

Cột:

- `variant_id` uuid · khoá chính → `product.product_variants.id` (khoá ngoại)
- `attribute_value_id` uuid · khoá chính → `product.attribute_values.id` (khoá ngoại)
- `position` integer · not null
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`variant_id`, `attribute_value_id`)
- index (`attribute_value_id`) `variant_attribute_values_attribute_value_id_index`
- check `variant_attribute_values_position`: `position in (0, 1)`
