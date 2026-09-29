# Đưa AI HealthPulse lên GitHub Pages

1. Vào https://github.com/new → đặt tên kho, ví dụ `ai-healthpulse` → chọn **Public** → Create repository.
2. Bấm **uploading an existing file** → kéo thả **cả 2 tệp** `index.html` và `.nojekyll` (tệp ẩn; trên Windows bật "Hiện tệp ẩn" để thấy) → **Commit changes**.
3. Vào **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, thư mục **/(root)** → **Save**.
4. Đợi 1–2 phút, web chạy tại: `https://<tên-tài-khoản>.github.io/ai-healthpulse/`
   - Trang khiếm thị: `https://<tên-tài-khoản>.github.io/ai-healthpulse/?voice=khiemthi`

## Giọng đọc tiếng Việt trên Chrome
- Có giọng Việt sẵn (Edge, Android, Mac, hoặc Windows đã cài giọng "Microsoft An"): dùng giọng máy.
- Chrome trên Windows chưa có giọng Việt: trang tự tải giọng AI tiếng Việt (~90 MB, chỉ lần đầu, sau đó dùng không cần mạng). Trong lúc tải, trợ lý dùng giọng tiếng Việt trực tuyến.
- Lần đầu mở trang: chạm hoặc nhấn phím bất kỳ một lần (Chrome yêu cầu trước khi phát tiếng), rồi bấm **Cho phép** micro. Trang github.io sẽ nhớ quyền micro cho các lần sau.

## Cập nhật web
Mỗi lần có bản mới: vào kho → bấm vào `index.html` → biểu tượng ✏️ hoặc **Add file → Upload files** → tải `index.html` mới đè lên → Commit. Nhấn Ctrl+F5 trên trình duyệt để tải lại bản mới.
