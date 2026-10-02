# Đưa AI HealthPulse lên GitHub Pages

1. Vào https://github.com/new → đặt tên kho, ví dụ `ai-healthpulse` → chọn **Public** → Create repository.
2. Bấm **uploading an existing file** → kéo thả **cả 2 tệp** `index.html` và `.nojekyll` (tệp ẩn; trên Windows bật "Hiện tệp ẩn" để thấy) → **Commit changes**.
3. Vào **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, thư mục **/(root)** → **Save**.
4. Đợi 1–2 phút, web chạy tại: `https://<tên-tài-khoản>.github.io/ai-healthpulse/`
   - Trang khiếm thị: `https://<tên-tài-khoản>.github.io/ai-healthpulse/?voice=khiemthi`

## Khi mở web
- Màn hình tải hiện thanh tiến độ: Giao diện · Dữ liệu & tài khoản · Giọng đọc · Micro. Tải xong mới vào màn hình chọn chế độ, trợ lý bắt đầu nói.
- Lần đầu: bấm **Cho phép** micro khi trình duyệt hỏi. Nếu trợ lý chưa nói, chạm hoặc nhấn phím bất kỳ một lần (Chrome yêu cầu trước khi phát tiếng).
- Điều khiển bằng giọng nói, hoặc rê chuột tới khung nào trợ lý đọc khung đó. Chữ trợ lý đọc hiện thành phụ đề ở cuối màn hình.
- Học sinh khiếm thị nhập thông tin: nói nội dung; hoặc nói "chữ nổi" rồi gõ Braille bằng 6 phím F D S J K L; hoặc nói "ký hiệu tay" để dùng camera.
- Sai họ tên, khối hoặc trường: menu tài khoản → **Cập nhật thông tin** (hoặc nói "cập nhật thông tin").

## Google Sheet (Trang tính1)
Dán `Code.gs` vào Apps Script → menu **AI HealthPulse → 1. Thiết lập Trang tính1** → Quản lý các bản triển khai → Sửa → **Phiên bản mới** (giữ nguyên URL).

## Giọng đọc tiếng Việt trên Chrome
- Có giọng Việt sẵn (Edge, Android, Mac, hoặc Windows đã cài giọng "Microsoft An"): dùng giọng máy.
- Chrome trên Windows chưa có giọng Việt: trang tự tải giọng AI tiếng Việt (~90 MB, chỉ lần đầu, sau đó dùng không cần mạng). Trong lúc tải, trợ lý dùng giọng tiếng Việt trực tuyến.

## Cập nhật web
Mỗi lần có bản mới: vào kho → **Add file → Upload files** → tải `index.html` mới đè lên → Commit. Nhấn Ctrl+F5 trên trình duyệt để tải lại bản mới.
