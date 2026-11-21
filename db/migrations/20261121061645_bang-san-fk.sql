-- Danh mục sàn channel.marketplaces (Documents/19 mục 3.3, 21/11/2026): chèn các sàn, commerio_app chỉ đọc, khoá ngoại từ mọi cột platform của channel; gắn lại hai khoá ngoại ghép đã gỡ khi đổi kiểu.
-- Sàn có adapter thì bật; shopee (chưa có adapter) và mock (sàn giả lập của test) tắt. Worker đối chiếu với registry adapter lúc khởi động (verifyMarketplaces).
INSERT INTO channel.marketplaces (code, enabled) VALUES
  ('lazada', true),
  ('tiktok', true),
  ('shopee', false),
  ('mock', false)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON channel.marketplaces FROM commerio_app;--> statement-breakpoint
ALTER TABLE channel.api_usage ADD CONSTRAINT api_usage_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.axis_mappings ADD CONSTRAINT axis_mappings_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.platform_categories ADD CONSTRAINT platform_categories_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.platform_category_attributes ADD CONSTRAINT platform_category_attributes_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.product_specs ADD CONSTRAINT product_specs_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.shops ADD CONSTRAINT shops_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.spec_field_mappings ADD CONSTRAINT spec_field_mappings_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.spec_option_mappings ADD CONSTRAINT spec_option_mappings_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
ALTER TABLE channel.webhook_events ADD CONSTRAINT webhook_events_platform_fk FOREIGN KEY (platform) REFERENCES channel.marketplaces (code);--> statement-breakpoint
-- Hai khoá ngoại ghép gỡ ở *_bang-san-go-khoa và *_bang-san (đổi kiểu không làm được khi chúng còn), gắn lại như cũ.
ALTER TABLE channel.platform_category_attributes ADD CONSTRAINT platform_category_attributes_category_fk FOREIGN KEY (platform, external_category_id)
  REFERENCES channel.platform_categories (platform, external_id);--> statement-breakpoint
ALTER TABLE channel.spec_option_mappings ADD CONSTRAINT spec_option_mappings_field_fk FOREIGN KEY (field_id, platform, attribute_code)
  REFERENCES channel.spec_field_mappings (field_id, platform, attribute_code) ON DELETE CASCADE;
