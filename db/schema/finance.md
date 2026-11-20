# Schema `finance` · Tài chính · lớp 4

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V105**, 21 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

## `finance.bank_matches`

Khớp dòng sổ (rút tiền, NCC hoàn tiền, bồi thường) với sao kê ngân hàng (#117, Documents/21 §21.3). Bảng riêng vì sổ chỉ thêm, không cập nhật dòng; mỗi dòng sổ khớp tối đa một lần. RLS ở migration `--custom`.

Khai ở `src/modules/finance/finance/repository/schema.ts:464` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `entry_id` uuid · not null → `finance.ledger_entries.id` (khoá ngoại)
- `bank_ref` text · not null
- `matched_by` uuid · not null → `core.accounts` (người thao tác)
- `matched_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`entry_id`) `bank_matches_entry_uq`
- check `bank_matches_ref`: `length(trim(bank_ref)) > 0`

## `finance.config_versions`

Phiên bản cấu hình phí (theo gian hàng), loại hình thuế, quy tắc thuế, ngưỡng lệch, biên tối thiểu. Nội dung trong `payload`, Zod kiểm theo `kind`. Chọn phiên bản theo ngày kiện giao. Không có hai bản `active` chồng ngày cho cùng (công ty, loại, gian hàng): ràng buộc EXCLUDE viết tay trong migration RLS (drizzle không sinh được).

Khai ở `src/modules/finance/finance/repository/schema.ts:539` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `kind` enum `finance.config_kind` · not null: `fee` | `tax_regime` | `tax_rules` | `mismatch_threshold` | `min_margin`
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `status` enum `finance.config_status` · not null · mặc định `'draft'`: `draft` | `pending_approval` | `rejected` | `scheduled` | `active` | `superseded` | `cancelled`
- `payload` jsonb · not null
- `effective_from` date · null
- `effective_to` date · null
- `supersedes_id` uuid · null → `finance.config_versions.id` (khoá ngoại)
- `is_correction` boolean · not null · mặc định `false`
- `retroactive_from` date · null
- `dry_run_result` jsonb · null
- `status_reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `approved_at` timestamptz · null
- `self_approved` boolean · not null · mặc định `false`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`kind`, `shop_id`, `status`) `config_versions_kind_shop_id_status_index`
- check `config_versions_second_person`: `approved_by is null or approved_by is distinct from created_by or self_approved`
- check `config_versions_fee_shop`: `(kind = 'fee') = (shop_id is not null)`
- check `config_versions_effective`: `status not in ('scheduled', 'active', 'superseded') or effective_from is not null`
- check `config_versions_range`: `effective_to is null or effective_to >= effective_from`
- check `config_versions_retroactive`: `retroactive_from is null or is_correction`
- check `config_versions_approved`: `status not in ('scheduled', 'active', 'superseded') or approved_by is not null`

Trỏ vào bảng này:

- `finance.config_versions.supersedes_id` (khoá ngoại)
- `finance.ledger_entries.config_version_id` (tham chiếu, không có khoá ngoại)
- `channel.price_calculations.fee_version_id` (tham chiếu, không có khoá ngoại)
- `channel.price_calculations.tax_version_id` (tham chiếu, không có khoá ngoại)
- `channel.price_calculations.tax_regime_version_id` (tham chiếu, không có khoá ngoại)
- `channel.price_calculations.min_margin_version_id` (tham chiếu, không có khoá ngoại)

## `finance.doc_counters`

Bộ đếm số hoá đơn, phiếu thu, phiếu chi; `period` theo tháng nếu #27 đánh số theo kỳ (plan chuẩn bị A4/K5).

Khai ở `src/modules/finance/finance/repository/schema.ts:574` · module con `finance` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `doc_type` text · khoá chính
- `period` text · khoá chính · mặc định `''`
- `next_number` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `doc_type`, `period`)

## `finance.gateway_configs`

Khoá cổng của công ty, mã hoá AES-256-GCM. `webhook_receiver_key` là phần cuối URL webhook SePay riêng của công ty, unique toàn hệ thống vì webhook đến trước khi biết công ty (D16); tra bằng role chủ bảng.

Khai ở `src/modules/finance/payment/repository/schema.ts:55` · module con `payment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `gateway` enum `finance.gateway` · not null: `vnpay` | `momo` | `zalopay` | `vietqr`
- `credentials_enc` bytea · null
- `is_configured` boolean · not null · mặc định `false`
- `webhook_receiver_key` text · null
- `updated_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`webhook_receiver_key`) `gateway_configs_webhook_receiver_key_unique`
- unique (`company_id`, `gateway`) `gateway_configs_company_id_gateway_unique`

## `finance.ledger_entries`

Sổ tiền, chỉ thêm (T1): mỗi khoản một dòng, số có dấu (vào dương, ra âm), cờ ước tính hay thực tế. Có quyết toán thì thêm dòng thực tế, cặp thực tế–ước tính ghi ở `ledger_replacements` (#231; cột `replaces_entry_id` cũ không ghi nữa); sai thì thêm dòng `adjustment`, không sửa dòng cũ. Mỗi dòng lưu bản cấu hình phí, thuế đã dùng. Khoản không gắn đơn (quảng cáo, chi vận hành) để trống đơn và kiện.

Khai ở `src/modules/finance/finance/repository/schema.ts:344` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `kind` enum `finance.ledger_kind` · not null: `revenue` | `platform_subsidy` | `shipping_income` | `shipping_cost` | `fee_fixed` | `fee_transaction` | `fee_service` | `fee_optional` | `withholding_tax` | `customer_refund` | `return_fee` | `lost_compensation` | `penalty` | `cogs` | `cogs_reversal` | `ads` | `opex` | `supplier_payment` | `supplier_refund` | `cod_collected` | `adjustment` | `withdrawal`
- `amount` numeric(18,2) · not null
- `is_estimate` boolean · not null
- `occurred_on` date · not null
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `package_id` uuid · null → `order.packages.id` (tham chiếu, không có khoá ngoại)
- `return_request_id` uuid · null → `order.return_requests.id` (tham chiếu, không có khoá ngoại)
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `source_type` text · null
- `source_id` uuid · null: đa hình: chứng từ nguồn theo cột loại nguồn của bảng
- `replaces_entry_id` uuid · null → `finance.ledger_entries.id` (khoá ngoại)
  **Đã bỏ:** Cặp thay ước tính đã chép sang `ledger_replacements` (#231), cột này không ghi nữa.
- `config_version_id` uuid · null → `finance.config_versions.id` (tham chiếu, không có khoá ngoại)
- `settlement_line_id` uuid · null → `finance.settlement_lines.id` (khoá ngoại)
- `external_transaction_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
  Mã giao dịch của sàn trên dòng thực tế; kéo lại cùng kỳ không ghi trùng (#117).
- `external_order_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
  Mã đơn sàn của khoản quyết toán; có mà `order_id` trống là đơn không có trong app (cờ Không rõ đơn, E140, #250).
- `reason` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`id`, `is_estimate`) `ledger_entries_id_estimate_uq`
- index (`order_id`) `ledger_entries_order_id_index`
- index (`shop_id`, `occurred_on`) `ledger_entries_shop_id_occurred_on_index`
- index (`occurred_on`) `ledger_entries_occurred_on_index`
- index (`source_type`, `source_id`) `ledger_entries_source_type_source_id_index`
- unique index (`replaces_entry_id`) `ledger_entries_replaces_uq` where `replaces_entry_id is not null`
- unique index (`company_id`, `shop_id`, `external_transaction_id`) `ledger_entries_external_txn_uq` where `external_transaction_id is not null`
- check `ledger_entries_amount`: `amount <> 0`
- check `ledger_entries_actual_replaces`: `replaces_entry_id is null or not is_estimate`
- check `ledger_entries_adjustment_reason`: `kind <> 'adjustment' or reason is not null`
- check `ledger_entries_shop_by_kind`: `(shop_id is not null or kind in ('opex', 'supplier_payment', 'supplier_refund', 'cod_collected')) and (shop_id is null or kind not in ('supplier_payment', 'supplier_refund', 'opex'))`

Trỏ vào bảng này:

- `finance.bank_matches.entry_id` (khoá ngoại)
- `finance.ledger_entries.replaces_entry_id` (khoá ngoại)
- `finance.ledger_replacements.actual_id, actual_is_estimate` (khoá ngoại viết tay)
- `finance.ledger_replacements.estimate_id, estimate_is_estimate` (khoá ngoại viết tay)

## `finance.ledger_package_lines`

Dòng hàng của kiện đã giao (#231), chép từ payload `fulfillment.package_delivered` lúc ghi sổ: lãi theo SKU (25 §10.2) gộp trong schema finance, không đọc chéo bảng kiện. Chỉ thêm (RLS, REVOKE UPDATE, DELETE ở migration `--custom`); mỗi kiện ghi một lần (unique kiện, số thứ tự dòng).

Khai ở `src/modules/finance/finance/repository/schema.ts:432` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `package_id` uuid · not null → `order.packages.id` (tham chiếu, không có khoá ngoại)
- `line_no` integer · not null
- `order_id` uuid · not null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `shop_id` uuid · not null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
  Null khi dòng kiện chưa ghép SKU lúc bàn giao.
- `quantity` integer · not null
- `unit_price` numeric(18,2) · not null
  Giá bán sau voucher shop.
- `unit_cost` numeric(18,2) · null
  Giá vốn chốt lúc bàn giao; null khi dòng kiện không có giá vốn (#229).
- `occurred_on` date · not null
  Ngày giao (giờ Việt Nam), như `occurred_on` của dòng sổ nguồn `package`.
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`package_id`, `line_no`) `ledger_package_lines_line_uq`
- index (`occurred_on`) `ledger_package_lines_occurred_on_index`
- index (`order_id`) `ledger_package_lines_order_id_index`
- check `ledger_package_lines_quantity`: `quantity > 0`

## `finance.ledger_replacements`

Quan hệ thay giữa dòng thực tế và dòng ước tính (#231): một dòng thực tế thay tối đa một dòng ước tính và ngược lại. Ghi ở hai lúc: lần quyết toán nối dòng thực tế về dòng ước tính còn hiệu lực cùng đơn, cùng loại; ghi dòng ước tính mà đơn đã có dòng thực tế cùng loại chưa nối (sàn quyết toán trước khi app nhận sự kiện) thì nối luôn. Chỉ thêm (RLS, REVOKE UPDATE, DELETE ở migration `--custom`), thay cho cột `ledger_entries.replaces_entry_id` (cột cũ giữ làm lịch sử, không ghi nữa; dữ liệu cũ đã chép sang bảng này). Chiều cặp ép ở CSDL: khoá ngoại ghép (`actual_id`, `false`) và (`estimate_id`, `true`) tới (`id`, `is_estimate`) của sổ; hai cột cờ là hằng (CHECK), chỉ để làm vế khoá ngoại. Hai khoá ngoại ghép viết ở migration `--custom` `rls-lai-theo-sku-bang-noi`, không khai ở đây: drizzle-kit sinh khoá ngoại trước unique (`id`, `is_estimate`) mà nó trỏ tới nên migration sinh ra chạy lỗi.

Khai ở `src/modules/finance/finance/repository/schema.ts:405` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `actual_id` uuid · not null → `finance.ledger_entries.id` (khoá ngoại viết tay)
- `actual_is_estimate` boolean · not null · mặc định `false` → `finance.ledger_entries.is_estimate` (khoá ngoại viết tay)
  Luôn `false`: vế cờ của khoá ngoại ghép tới dòng thực tế.
- `estimate_id` uuid · not null → `finance.ledger_entries.id` (khoá ngoại viết tay)
- `estimate_is_estimate` boolean · not null · mặc định `true` → `finance.ledger_entries.is_estimate` (khoá ngoại viết tay)
  Luôn `true`: vế cờ của khoá ngoại ghép tới dòng ước tính.
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`actual_id`) `ledger_replacements_actual_uq`
- unique (`estimate_id`) `ledger_replacements_estimate_uq`
- check `ledger_replacements_distinct`: `actual_id <> estimate_id`
- check `ledger_replacements_actual_flag`: `not actual_is_estimate`
- check `ledger_replacements_estimate_flag`: `estimate_is_estimate`
- khoá ngoại viết tay (`actual_id`, `actual_is_estimate`) → `finance.ledger_entries` (`id`, `is_estimate`), ở `db/migrations/20261115074227_rls-lai-theo-sku-bang-noi.sql`
- khoá ngoại viết tay (`estimate_id`, `estimate_is_estimate`) → `finance.ledger_entries` (`id`, `is_estimate`), ở `db/migrations/20261115074227_rls-lai-theo-sku-bang-noi.sql`

## `finance.order_payments`

Trạng thái tiền của đơn hộp thư, đơn tạo tay (đơn sàn không có dòng, 19-D11). Phương thức, số tiền đọc từ đơn (`sales.getOrderForPayment`). `paid_at` ghi khi sang `paid`/`cod_collected`; `delivered_at` do fulfillment ghi qua `markDelivered` khi giao xong, tab COD đọc cột này (R2).

Khai ở `src/modules/finance/payment/repository/schema.ts:40` · module con `payment` · theo công ty (`company_id`)

Cột:

- `order_id` uuid · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `status` enum `finance.payment_status` · not null: `unpaid` | `paid` | `cod_pending` | `cod_collected` | `not_collected`
- `refund_status` enum `finance.refund_status` · not null · mặc định `'none'`: `none` | `pending_refund` | `refunded`
- `paid_at` timestamptz · null
- `delivered_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

## `finance.order_settlements`

Một dòng mỗi đơn sàn. `diff` = thực tế − ước tính; lệch vượt ngưỡng thì `mismatch`. Chốt lệch ghi người và lý do; lệch vượt ngưỡng chốt cần CEO duyệt (`approved_by`). `resolved_diff_base` là lệch lúc chốt, để lần điều chỉnh sau tính lệch từ đó.

Khai ở `src/modules/finance/finance/repository/schema.ts:487` · module con `finance` · theo công ty (`company_id`)

Cột:

- `order_id` uuid · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `status` enum `finance.settlement_state` · not null · mặc định `'none'`: `none` | `pending` | `settled` | `mismatch` | `resolved`
- `estimated_total` numeric(18,2) · not null · mặc định `'0'`
- `settled_total` numeric(18,2) · null
- `diff` numeric(18,2) · null
- `resolved_diff_base` numeric(18,2) · null
- `resolved_by` uuid · null → `core.accounts` (người thao tác)
- `resolved_at` timestamptz · null
- `resolved_reason` text · null
- `self_approved` boolean · not null · mặc định `false`
  Người chốt là người soạn cấu hình phí, được chốt nhờ ngoại lệ tự duyệt (25 §11, #249).
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `cost_missing` boolean · not null · mặc định `false`
  Có dòng kiện đã giao không có giá vốn (`unitCost` null, #229): lãi của đơn thiếu phần đó (Documents/21 §21.1).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`status`) `order_settlements_status_index`
- check `order_settlements_resolved`: `status <> 'resolved' or (resolved_by is not null and resolved_reason is not null)`
- check `order_settlements_settled`: `status not in ('settled', 'resolved') or settled_total is not null`
- check `order_settlements_approver`: `approved_by is null or approved_by is distinct from resolved_by`

## `finance.payment_links`

Mã thanh toán. `payment_code` unique toàn hệ thống (D14) vì webhook tìm mã trước khi biết công ty (D16); mỗi đơn tối đa một mã `active` (19-D21).

Khai ở `src/modules/finance/payment/repository/schema.ts:75` · module con `payment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `order_id` uuid · not null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `gateway` enum `finance.gateway` · not null: `vnpay` | `momo` | `zalopay` | `vietqr`
- `payment_code` text · not null
- `gateway_order_ref` text · null
- `amount` numeric(18,2) · not null
- `pay_url` text · null
- `qr_content` text · null
- `expires_at` timestamptz · not null
- `status` enum `finance.link_status` · not null · mặc định `'active'`: `active` | `paid` | `expired` | `cancelled`
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`payment_code`) `payment_links_payment_code_unique`
- index (`order_id`) `payment_links_order_id_index`
- unique index (`order_id`) `payment_links_one_active_per_order` where `status = 'active'`
- check `payment_links_amount`: `amount > 0`

Trỏ vào bảng này:

- `finance.payment_transactions.payment_link_id` (khoá ngoại)

## `finance.payment_transactions`

Giao dịch cổng báo về, ghi một lần (19-D19). Chống trùng theo `(gateway, gateway_txn_id)` toàn hệ thống (plan chuẩn bị A7). `fee` là phí cổng nếu cổng trả (QT-45), trống khi không biết.

Khai ở `src/modules/finance/payment/repository/schema.ts:104` · module con `payment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `payment_link_id` uuid · null → `finance.payment_links.id` (khoá ngoại)
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `gateway` enum `finance.gateway` · not null: `vnpay` | `momo` | `zalopay` | `vietqr`
- `gateway_txn_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `amount` numeric(18,2) · not null
- `fee` numeric(18,2) · null
- `source` enum `finance.txn_source` · not null: `webhook` | `query` | `sepay`
- `status` enum `finance.txn_status` · not null · mặc định `'pending'`: `pending` | `succeeded` | `failed` | `needs_review`
- `raw_payload` jsonb · null
- `occurred_at` timestamptz · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`gateway`, `gateway_txn_id`) `payment_transactions_gateway_gateway_txn_id_unique`
- index (`payment_link_id`) `payment_transactions_payment_link_id_index`
- index (`order_id`) `payment_transactions_order_id_index`

Trỏ vào bảng này:

- `finance.receipts.payment_transaction_id` (tham chiếu, không có khoá ngoại)
- `finance.unmatched_receipts.payment_transaction_id` (tham chiếu, không có khoá ngoại)

## `finance.payment_vouchers`

Phiếu chi: nháp → ghi sổ → (đảo). Trỏ tối đa một chứng từ gốc theo `purpose`. Chỉ phiếu đảo mang số âm.

**Đã bỏ:** Gỡ ở #235: không còn code ghi, chưa drop. Xoá shop vẫn đếm dòng cũ (`shop-purge.ts`).

Khai ở `src/modules/finance/finance/repository/schema.ts:162` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `purpose` enum `finance.voucher_purpose` · not null: `supplier_payment` | `customer_refund` | `unmatched_refund`
- `supplier_invoice_id` uuid · null → `finance.supplier_invoices.id` (khoá ngoại)
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `unmatched_receipt_id` uuid · null → `finance.unmatched_receipts.id` (khoá ngoại)
- `amount` numeric(18,2) · not null
- `paid_on` date · not null
- `note` text · null
- `status` enum `finance.voucher_status` · not null · mặc định `'draft'`: `draft` | `posted` | `reversed`
- `created_by` uuid · not null → `core.accounts` (người thao tác)
- `posted_by` uuid · null → `core.accounts` (người thao tác)
- `posted_at` timestamptz · null
- `reversal_of_id` uuid · null → `finance.payment_vouchers.id` (khoá ngoại)
- `reversal_reason` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`reversal_of_id`) `payment_vouchers_reversal_of_id_unique`
- unique (`company_id`, `number`) `payment_vouchers_company_id_number_unique`
- index (`order_id`) `payment_vouchers_order_id_index`
- index (`unmatched_receipt_id`) `payment_vouchers_unmatched_receipt_id_index`
- check `payment_vouchers_one_source`: `num_nonnulls(supplier_invoice_id, order_id, unmatched_receipt_id) <= 1`
- check `payment_vouchers_amount_sign`: `amount <> 0 and (reversal_of_id is null) = (amount > 0)`
- check `payment_vouchers_reversal_reason`: `(reversal_of_id is null) = (reversal_reason is null)`

Trỏ vào bảng này:

- `finance.payment_vouchers.reversal_of_id` (khoá ngoại)

## `finance.receipts`

Phiếu thu, không có nháp. Chỉ phiếu đảo mang số âm.

Khai ở `src/modules/finance/finance/repository/schema.ts:125` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `source` enum `finance.receipt_source` · not null: `gateway` | `cod` | `settlement` | `unmatched_assignment`
- `payment_transaction_id` uuid · null → `finance.payment_transactions.id` (tham chiếu, không có khoá ngoại)
- `unmatched_receipt_id` uuid · null → `finance.unmatched_receipts.id` (khoá ngoại)
- `settlement_line_id` uuid · null → `finance.settlement_lines.id` (khoá ngoại)
- `amount` numeric(18,2) · not null
- `status` enum `finance.voucher_status` · not null · mặc định `'posted'`: `draft` | `posted` | `reversed`
- `posted_at` timestamptz · not null · mặc định `now()`
- `reversal_of_id` uuid · null → `finance.receipts.id` (khoá ngoại)
- `reversal_reason` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`payment_transaction_id`) `receipts_payment_transaction_id_unique`
- unique (`settlement_line_id`) `receipts_settlement_line_id_unique`
- unique (`reversal_of_id`) `receipts_reversal_of_id_unique`
- unique (`company_id`, `number`) `receipts_company_id_number_unique`
- index (`order_id`) `receipts_order_id_index`
- index (`unmatched_receipt_id`) `receipts_unmatched_receipt_id_index`
- check `receipts_amount_sign`: `amount <> 0 and (reversal_of_id is null) = (amount > 0)`
- check `receipts_reversal_reason`: `(reversal_of_id is null) = (reversal_reason is null)`
- check `receipts_not_draft`: `status <> 'draft'`

Trỏ vào bảng này:

- `finance.receipts.reversal_of_id` (khoá ngoại)

## `finance.sales_invoice_lines`

Dòng hoá đơn: chép từ dòng đơn; dòng của hoá đơn đảo mang số âm.

**Đã bỏ:** Gỡ ở #235 cùng `sales_invoices`: không còn code ghi, chưa drop.

Khai ở `src/modules/finance/finance/repository/schema.ts:87` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `invoice_id` uuid · not null → `finance.sales_invoices.id` (khoá ngoại)
- `order_line_id` uuid · not null → `order.order_lines.id` (tham chiếu, không có khoá ngoại)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `quantity` integer · not null
- `unit_price` numeric(18,2) · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`invoice_id`) `sales_invoice_lines_invoice_id_index`

## `finance.sales_invoices`

Hoá đơn bán, tự sinh khi xuất kho. Một đơn tối đa một hoá đơn `posted` chưa bị đảo (plan chuẩn bị A7).

**Đã bỏ:** Gỡ ở #235: không còn code ghi, chưa drop. Xoá shop vẫn đếm dòng cũ (`shop-purge.ts`).

Khai ở `src/modules/finance/finance/repository/schema.ts:56` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `number` text · not null
- `order_id` uuid · not null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `status` enum `finance.invoice_status` · not null · mặc định `'posted'`: `posted` | `reversed`
- `issued_at` timestamptz · not null · mặc định `now()`
- `total` numeric(18,2) · not null
- `reversal_of_id` uuid · null → `finance.sales_invoices.id` (khoá ngoại)
- `reversal_reason` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`reversal_of_id`) `sales_invoices_reversal_of_id_unique`
- unique (`company_id`, `number`) `sales_invoices_company_id_number_unique`
- index (`order_id`) `sales_invoices_order_id_index`
- unique index (`order_id`) `sales_invoices_one_posted_per_order` where `reversal_of_id is null and status = 'posted'`
- check `sales_invoices_reversal_reason`: `(reversal_of_id is null) = (reversal_reason is null)`

Trỏ vào bảng này:

- `finance.sales_invoice_lines.invoice_id` (khoá ngoại)
- `finance.sales_invoices.reversal_of_id` (khoá ngoại)

## `finance.settlement_batches`

Một lần kéo quyết toán của một gian hàng, bằng API hoặc file khi gian hàng đã ngắt. Mốc kéo của gian hàng (`channel.shops.settlement_cursor`) chỉ tiến khi lô `done`: chạy lại an toàn (D4.3).

Khai ở `src/modules/finance/finance/repository/schema.ts:281` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `source` enum `finance.settlement_source` · not null: `api` | `file`
- `file_id` uuid · null → `core.files.id` (tham chiếu, không có khoá ngoại)
- `period_from` timestamptz · not null
- `period_to` timestamptz · not null
- `status` enum `finance.settlement_batch_status` · not null · mặc định `'running'`: `running` | `done` | `failed`
- `line_count` integer · not null · mặc định `0`
- `duplicates` integer · not null · mặc định `0`
  Giao dịch sàn đã có trong sổ, lần chạy này bỏ qua (#117).
- `wallet_diff` numeric(18,2) · null
  Số dư sàn báo trừ số dư theo sổ khi lô xong; khác 0 thì cờ `wallet_mismatch` (#117).
- `error` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`shop_id`) `settlement_batches_shop_id_index`
- check `settlement_batches_file`: `(source = 'file') = (file_id is not null)`
- check `settlement_batches_period`: `period_from <= period_to`

Trỏ vào bảng này:

- `finance.settlement_statements.batch_id` (khoá ngoại)

## `finance.settlement_lines`

Dòng đối soát, một dòng mỗi giao dịch của bảng kê; chạy lại đối soát không sinh trùng nhờ `external_transaction_id`. Khớp khi `revenue − Σfees − shipping_cost ± adjustment = settlement` (API 12.8, T23); `raw` là bản gốc của sàn.

Khai ở `src/modules/finance/finance/repository/schema.ts:240` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `statement_id` uuid · not null → `finance.settlement_statements.id` (khoá ngoại)
- `kind` enum `finance.settlement_line_kind` · not null: `order` | `adjustment` | `reserve`
- `external_transaction_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `external_order_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `revenue` numeric(18,2) · not null
- `fees` jsonb · not null
- `shipping_cost` numeric(18,2) · not null · mặc định `'0'`
- `adjustment` numeric(18,2) · not null · mặc định `'0'`
- `settlement` numeric(18,2) · not null
- `match_status` enum `finance.match_status` · not null: `matched` | `discrepancy` | `refund_tagged`
- `discrepancy_reason` enum `finance.discrepancy_reason` · null: `order_not_found` | `revenue_mismatch` | `formula_mismatch`
- `raw` jsonb · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `external_transaction_id`) `settlement_lines_company_id_external_transaction_id_unique`
- index (`statement_id`) `settlement_lines_statement_id_index`
- index (`order_id`) `settlement_lines_order_id_index`
- check `settlement_lines_discrepancy_reason`: `(match_status = 'discrepancy') = (discrepancy_reason is not null)`

Trỏ vào bảng này:

- `finance.ledger_entries.settlement_line_id` (khoá ngoại)
- `finance.receipts.settlement_line_id` (khoá ngoại)

## `finance.settlement_statements`

Bảng kê thanh toán của sàn; `shop_id` trỏ channel, `payment_status` giữ nguyên chữ của sàn (PAID, PROCESSING…).

Khai ở `src/modules/finance/finance/repository/schema.ts:219` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `batch_id` uuid · null → `finance.settlement_batches.id` (khoá ngoại)
- `external_statement_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `statement_time` timestamptz · not null
- `settlement_amount` numeric(18,2) · not null
- `payment_status` text · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `external_statement_id`) `settlement_statements_company_id_external_statement_id_unique`
- index (`shop_id`) `settlement_statements_shop_id_index`

Trỏ vào bảng này:

- `finance.settlement_lines.statement_id` (khoá ngoại)

## `finance.supplier_invoices`

Hoá đơn nhà cung cấp (UC-PF-08); `supplier_id`, `purchase_request_id` trỏ purchasing, không khoá ngoại (19-D1).

Khai ở `src/modules/finance/finance/repository/schema.ts:197` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `supplier_id` uuid · not null → `product.suppliers.id` (tham chiếu, không có khoá ngoại)
- `purchase_request_id` uuid · null → `product.purchase_requests.id` (tham chiếu, không có khoá ngoại)
- `invoice_no` text · not null
- `invoice_date` date · not null
- `amount` numeric(18,2) · not null
- `amount_due` numeric(18,2) · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`supplier_id`) `supplier_invoices_supplier_id_index`
- index (`purchase_request_id`) `supplier_invoices_purchase_request_id_index`
- check `supplier_invoices_amount`: `amount > 0`

Trỏ vào bảng này:

- `finance.payment_vouchers.supplier_invoice_id` (khoá ngoại)

## `finance.unmatched_receipts`

Tiền về không gán được vào đơn (không có mã, lệch tiền, đơn đã huỷ); gán hoặc hoàn sau (UC-PF-07).

Khai ở `src/modules/finance/finance/repository/schema.ts:106` · module con `finance` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `payment_transaction_id` uuid · null → `finance.payment_transactions.id` (tham chiếu, không có khoá ngoại)
- `amount` numeric(18,2) · not null
- `transfer_content` text · null
- `reason` enum `finance.unmatched_reason` · not null: `no_payment_code` | `amount_mismatch` | `order_cancelled`
- `status` enum `finance.unmatched_status` · not null · mặc định `'open'`: `open` | `assigned` | `refunded`
- `assigned_order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `received_at` timestamptz · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`payment_transaction_id`) `unmatched_receipts_payment_transaction_id_index`
- index (`assigned_order_id`) `unmatched_receipts_assigned_order_id_index`

Trỏ vào bảng này:

- `finance.payment_vouchers.unmatched_receipt_id` (khoá ngoại)
- `finance.receipts.unmatched_receipt_id` (khoá ngoại)

## `finance.webhook_events`

Webhook cổng đã nhận (sau khi kiểm chữ ký), chống xử lý lặp. Khoá gồm cả `gateway`: mã sự kiện của hai cổng đều là số, có thể trùng nhau trong một công ty.

Khai ở `src/modules/finance/payment/repository/schema.ts:129` · module con `payment` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `gateway` enum `finance.gateway` · not null: `vnpay` | `momo` | `zalopay` | `vietqr`
- `event_key` text · not null
- `payload` jsonb · not null
- `received_at` timestamptz · not null · mặc định `now()`
- `processed_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`company_id`, `gateway`, `event_key`) `webhook_events_company_id_gateway_event_key_unique`
