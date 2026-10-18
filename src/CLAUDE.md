# src/

Toàn bộ mã chạy. Không có bước build: Node 24 chạy thẳng file `.ts`, `tsc` chỉ kiểm kiểu.

| Đường dẫn | Vai trò |
|---|---|
| `entrypoints/` | Điểm khởi động của ba tiến trình `api`, `worker`, `realtime` |
| `app.ts` | Ráp ứng dụng Express cho `api`: middleware chung → router từng module → 404 → xử lý lỗi |
| `wiring.ts` | Dựng `ModuleContext` (`authorize`, hàm nối giữa module) cho `app.ts` và `worker`. Chỉ import `index.ts` của module |
| `modules/` | 19 module nghiệp vụ, mỗi module bốn lớp |
| `shared/` | Nền dùng chung: cấu hình, DB, lỗi, middleware HTTP, log, số liệu |

Chiều phụ thuộc chỉ đi một hướng: `entrypoints` → `app.ts` → `wiring.ts` → `modules` → `shared`. Đi ngược lại thì `npm run depcruise` báo lỗi.

Không đặt file test trong `src/`. Mọi test nằm ở `test/`, xem `test/CLAUDE.md`.
