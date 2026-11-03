# Baseline/cutover và rollback

SQLite Windows hiện có: **434 current rows, 145 raw opportunities, 1 baseline,
1 batch, 3 members, 1 job SENT**. Chỉ đọc aggregate từ DB chế độ `mode=ro`;
không export token/chat/message IDs vào package public. D1 remote chưa được đọc
hay ghi trong nhiệm vụ này; trạng thái rỗng do người dùng cung cấp.

## A — Chuyển state tối thiểu

Cần private export riêng ngoài public staging: current observations, lifecycle,
3 membership và message/destination references đã gửi; không chuyển website
credentials, Telegram token, callback token hoặc account/reservation tables.
Phải đối chiếu identity, nhóm đích, schema, scan completeness và receipt trước
import. Không copy DB thô lên repository. D1 schema khác Windows, không chạy
SQLite dump nguyên xi. Phải có importer chuyên biệt/validation và test roundtrip
trước chọn A; **chưa viết importer hoặc chạy migration dữ liệu thật**.

Ưu điểm A: giữ liên kết edit 3 opportunity đã gửi. Nhược điểm: cần chuyển private
message metadata/145 raw lifecycle và giải quyết bản dịch schema; không an toàn
nếu chỉ copy một vài bảng tùy ý. Dữ liệu 31/10 không thay thế scan mới hôm cutover.

## B — Quiet baseline mới (đã được người dùng chọn cho cutover TEST đầu tiên)

Lần COMPLETE đầu tạo current/opportunities, source.baseline=QUIET, không có job
SEND hoặc initial summary. Restart/no-change giữ ID và gửi 0. Subsequent new
slot hoặc RESERVED→AVAILABLE mới tạo opportunity/batch; calendar/range fail-safe
vẫn giữ nguyên. Workflow Monitoring chỉ dùng QUIET. NOTIFY giữ cho fixture/offline
và hợp đồng gốc; không tự đổi QUIET sang NOTIFY bằng lần run sau.

Ưu điểm B: không mang private dữ liệu Windows đi, tránh phát lại 3 notification.
Giới hạn: không có message reference cho tin cũ nên D1 không edit các tin Windows
đó. Admin cần chấp nhận ranh giới cutover và xử lý tin cũ thủ công nếu cần.
Không coi đây là đã migrate đầy đủ lifecycle cũ. Dừng Windows sender trước cutover;
chỉ một backend sở hữu nguồn từ thời điểm này. Chưa thực hiện việc dừng/cutover.

## Schema migration/rollback

0001 chỉ tạo bảng/index nếu chưa có; insert source/lease/schema dùng OR IGNORE.
Tests chạy lại migration trên dữ liệu đã có, unique/FK, lỗi ở giữa D1 batch phải
rollback hoàn toàn. D1.batch là transaction API; Worker không dùng BEGIN IMMEDIATE
qua binding. Lease guard và mutation cùng batch, không check-then-write riêng.

Không có destructive down migration tự động. Rollback code trước; giữ schema
additive tương thích. Nếu cần khôi phục dữ liệu phải dùng export/backup hoặc
Time Travel với phê duyệt riêng, dừng sender trước rồi verify counts/FK/delivery.
Không drop/recreate database để giải quyết UNCERTAIN. D1 Free Time Travel theo
nguồn chính thức hiện là 7 ngày; chưa chạy backup/restore Cloud trong nhiệm vụ này.

UNCERTAIN không thể tự kết luận từ getUpdates (không có ingress ở deploy).
Admin đối chiếu Group + D1 job/membership, xác nhận message_id nếu tìm thấy;
thực hiện reconciliation được review riêng, không UPDATE mọi job về PENDING.
Không có retry/backoff tự động. Nếu chưa rõ, giữ UNCERTAIN và nguồn tạm ngừng gửi.
