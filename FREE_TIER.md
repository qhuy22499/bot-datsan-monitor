# Ước tính Free Tier — cập nhật 04/11/2026

Mục tiêu **¥0/tháng**, chưa phải hóa đơn hay cam kết uptime. Không bật billing,
không mua tài nguyên. Cần theo dõi usage thực trước khi schedule.

| Thành phần | Hạn mức chính thức | Ước tính cho MVP |
|---|---|---|
| GitHub standard Linux runner, public repo | Free compute; larger runners khác | Trial 68 jobs/ngày, khoảng 2.040/tháng 30 ngày; chỉ Group TEST |
| Thời gian job | Phụ thuộc queue/install/browser | Hai manual workflow LIVE: 78 và 66 giây từ tạo đến kết thúc; scan 42 và 37 giây |
| Runner public Linux | Standard x64: 4 vCPU, 16GB RAM | Một Chromium, không parallel; MVP Windows đo scan ~24–28 giây |
| Workers Free | 100.000 request/ngày, 10ms CPU/request, 128MB | No-change 6 Storage API calls/job; ≈408/ngày + 68 Cron invocations, thêm claim+receipt nếu gửi |
| D1 Free | 5 triệu rows read/ngày, 100.000 rows written/ngày | 434×68=29.512 current row updates/ngày, cộng lease/guard/scan/source/index |
| D1 storage | 500MB/database, 5GB/account Free | Dữ liệu hiện tại nhỏ; history/retention cần theo dõi dài hạn |

Nguồn: [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

**Đo trước khi tăng tần suất, 04/11/2026 21:47 JST:** GraphQL toàn account ghi
54.938 rows read và 3.656 rows written trong ngày UTC (chỉ một database phát sinh
usage). So với snapshot 19:52 JST, bốn COMPLETE scans mới tăng 1.792 rows written:
**448 writes/scan**, kể cả metadata hiện tại. Dự toán steady state **448×68=30.464
writes/ngày** (~30,5% quota), khoảng 0,375 triệu reads/ngày theo delta quan sát.
Đây là ước tính từ trial ngắn, không phải giới hạn trên: biến động trạng thái,
baseline mới, delivery/receipt và history tăng có thể tốn thêm. Kịch bản planning
gấp đôi writes vẫn khoảng 60.928/ngày; tiếp tục theo dõi Metrics → Row Metrics.
Không cần chia khung giờ ưu tiên ở mức usage này. Quota reset 00:00 UTC/09:00 JST;
hết quota Free thì queries có thể bị chặn đến lần reset, không tự chuyển Paid.
Index có thể tăng
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

**Bằng chứng LIVE:** hai manual jobs COMPLETE, 12 Worker requests HTTP 200,
CPU median theo lượt 4ms / 5,5ms, max 16ms / 14ms, không có 503/1102 trong hai
lượt. Đây là burst thực đo, không phải cam kết request luôn dưới 10ms hay SLA.
Người vận hành chấp nhận chậm 30–60 phút hoặc bỏ một lượt để giữ Free Tier.
Nếu CPU limit/5xx xảy ra, giữ nguyên dữ liệu thành công trước đó, không resend
UNCERTAIN; chỉ công nhận phục hồi khi job sau COMPLETE. Không tự nâng Paid.
History/snapshot lớn dần vẫn có thể cần tối ưu khi có bằng chứng lỗi thực tế.

Không TTL/opportunity deletion tự động. History scans/opportunities/jobs tăng
dần; snapshot/validation hiện có cap fail-closed. Cần projection/archive/pagination
được review khi gần cap, không khẳng định chạy miễn phí vô hạn bằng dữ liệu nhỏ.
Không dùng Actions artifacts/cache làm database. Không upload DB/log/payload.

GitHub native cron cũ có thể trễ/drop hoặc bị tắt sau inactivity; nguồn hiện tại
là Cloudflare dispatch vào default branch. Chọn phút 7/22/37/52 thay đầu giờ.
Runtime kiểm giờ thực 07–24 JST, không giả định cron đúng giờ. Schedule đã được
phép bật sau GitHub → Telegram TEST PASS; quy đổi Asia/Tokyo, phút 7/22/37/52,
giờ 7–23. Không coi cấu hình lịch là bằng chứng trial dài hạn đã PASS.
Xem [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

**Cập nhật 04/11/2026:** sau kiểm thử controlled LIVE, nguồn kích hoạt chuyển
sang Worker `bot-datsan-cron`, GitHub native schedule OFF. Cron Cloudflare UTC
`7,22,37,52 0-14,22-23 * * *`, 68 lượt/ngày, chỉ dispatch cùng workflow cũ. Dự toán
no-change: khoảng 408 Storage Worker requests + 68 Cron Worker invocations/ngày;
mỗi Cron có một GitHub subrequest. Không thêm D1 writes bên trong Cron Worker.
Free hỗ trợ 5 Cron Triggers/account; trước cutover account có 0. Không bật Paid.
Giữ Worker HTTP 404/workers.dev OFF; token dispatch riêng chỉ Actions write trên
repo đích. Không chạy hai scheduler song song hoặc hứa Cron có SLA chính xác.
Xem [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Usage snapshot ngày 03/11/2026 trước khi bật lịch: 44.659 D1 rows read,
13.841 rows written, 575 read queries, 173 write queries; Worker 81 requests,
0 runtime errors, CPU P50 5,518ms / P99 34,068ms. Đây là aggregate ngày gồm
migration, validation cũ, các lượt manual và truy vấn quản trị, không phải chi phí
một scan hoặc bằng chứng 24–48 giờ. Chưa bật Paid; theo dõi Dashboard trong trial.
