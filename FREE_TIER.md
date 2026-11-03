# Ước tính Free Tier — 31/10/2026

Mục tiêu **¥0/tháng**, chưa phải hóa đơn hay cam kết uptime. Không bật billing,
không mua tài nguyên. Cần theo dõi usage thực trước khi schedule.

| Thành phần | Hạn mức chính thức | Ước tính cho MVP |
|---|---|---|
| GitHub standard Linux runner, public repo | Free compute; larger runners khác | 68 jobs/ngày, khoảng 2.040/tháng 30 ngày |
| Thời gian job | Phụ thuộc queue/install/browser | Dự toán 2–5 phút/job, 136–340 phút compute/ngày; chưa đo Ubuntu |
| Runner public Linux | Standard x64: 4 vCPU, 16GB RAM | Một Chromium, không parallel; MVP Windows đo scan ~24–28 giây |
| Workers Free | 100.000 request/ngày, 10ms CPU/request, 128MB | No-change khoảng 6 API calls/job ≈408/ngày; có delivery thêm claim+receipt |
| D1 Free | 5 triệu rows read/ngày, 100.000 rows written/ngày | 434×68=29.512 current row updates/ngày, cộng lease/guard/scan/source |
| D1 storage | 500MB/database, 5GB/account Free | Dữ liệu hiện tại nhỏ; history/retention cần theo dõi dài hạn |

Nguồn: [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Ước tính planning: khoảng **31–65 nghìn writes/ngày** với cửa sổ 434 ô, ít
transition; khoảng **0,1–0,5 triệu reads/ngày** với history còn nhỏ. Đây là khoảng
ước lượng, không phải D1 `meta.rows_written/rows_read` thực đo. Index có thể tăng
writes; membership/job/receipt/guard và baseline ban đầu cũng phát sinh writes.
Không index observed_at để tránh nhân writes mỗi scan; chỉ ghi transitions khi
status thay đổi. Bulk JSON upsert giảm Worker prepare/HTTP overhead, không giảm
số row được cập nhật. D1.batch được tài liệu nêu là một query đối với giới hạn
50 queries/invocation Free; statements vẫn có limit riêng (100 bound params).

Review mới đã đổi snapshot sang SELECT-only batch, vẫn kiểm lease và primary
session. Bỏ 2 guard writes × 3 snapshot/lượt × 68 lượt = **408 logical writes/ngày**.
Đây là số thao tác SQL giảm, không phải usage D1 đã đo. Giữ mọi fence/revision
guard khi mutate/claim/receipt; không giảm observed_at để tiết kiệm quota.
Ở steady state vẫn cần 29.512 cập nhật slot/ngày, scan metadata và source state,
lease/release, outbox khi có thay đổi. Không tạo transition nếu status giữ nguyên.

Có thể chuẩn hóa timestamp theo ngày (14 slot chia sẻ một observation/day) để
giảm writes nhiều hơn, nhưng cần schema/adapter migration mới. Chỉ đề xuất cho
giai đoạn sau khi đo usage thật; chưa triển khai hoặc thay contract MVP hiện tại.

**Điểm cần đo trước bật schedule:** Worker CPU 10ms có thể là nút thắt dù số
request còn thấp. Validation/JSON snapshot ngày càng lớn và SQL query cost phải
đo thực trên Free. Workerd local hiện chưa chạy được trên Windows; không lấy
thời gian Node shim làm CPU Workers. Nếu vượt Free, dừng/review tối ưu hoặc chia
commit có staging an toàn, không tự chuyển Paid hay bỏ atomicity/completeness.

Không TTL/opportunity deletion tự động. History scans/opportunities/jobs tăng
dần; snapshot/validation hiện có cap fail-closed. Cần projection/archive/pagination
được review khi gần cap, không khẳng định chạy miễn phí vô hạn bằng dữ liệu nhỏ.
Không dùng Actions artifacts/cache làm database. Không upload DB/log/payload.

Cron 15 phút có thể bị trễ hoặc drop, default branch mới chạy; public repo có
thể tắt cron sau 60 ngày không hoạt động. Chọn phút 7/22/37/52 thay đầu giờ.
Runtime kiểm giờ thực 07–24 JST, không giả định cron đúng giờ. Schedule vẫn OFF.
Xem [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
