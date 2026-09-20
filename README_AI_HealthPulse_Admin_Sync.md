# AI HealthPulse — cập nhật admin và đồng bộ Google Sheets

## Đã bổ sung

- Admin có ba luồng: đăng nhập, tạo tài khoản và quên tài khoản/mật khẩu.
- Tài khoản admin lưu họ tên, tên đăng nhập, mật khẩu đã băm, trường, phường/xã, quận/huyện và tỉnh/thành.
- Admin chỉ xem dữ liệu khảo sát có cùng `schoolId`.
- Web ghi thay đổi tài khoản, trường, kết quả và tư liệu về Google Sheets.
- Khi sửa dữ liệu JSON trong các tab `students`, `admins` hoặc `results`, trang web tự kiểm tra lại và cập nhật phiên/thông tin trường đang mở.

## Cách triển khai

1. Mở Google Sheet dùng làm nơi lưu dữ liệu → Extensions → Apps Script.
2. Dán toàn bộ `Code(4).gs` vào Apps Script và lưu.
3. Deploy → New deployment → Web app.
4. Chọn `Execute as: Me` và `Who has access: Anyone`.
5. Deploy một phiên bản mới sau mỗi lần sửa Apps Script.
6. Giữ đúng URL Apps Script trong `SHEETS_API_URL` của file JavaScript.
7. Đặt bốn tệp HTML, JavaScript, CSS và Apps Script cùng thư mục khi chạy ngoài Claude/GitHub Pages.

## Thông tin trường

Để triển khai đơn giản và ổn định, hệ thống không còn tải danh mục trường từ bên ngoài và không gọi trang CSDL Bộ. Người dùng nhập trực tiếp:

- tên trường;
- cấp học: THCS, THPT hoặc THCS–THPT;
- phường/xã, quận/huyện và tỉnh/thành phố.

Web tự tạo `schoolId` từ các thông tin này rồi lưu cùng tài khoản và kết quả. Nhập giống nhau ở các tài khoản thuộc cùng trường để Dashboard admin lọc đúng dữ liệu. Nếu sửa JSON trong Google Sheet, trang web vẫn đọc lại bản sửa qua cơ chế polling.
