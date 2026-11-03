# Manual Ubuntu validation — điều kiện nghiệm thu

Chưa chạy GitHub Actions trong lần review này. WSL chưa được cài; không cài WSL,
VM, VC++ runtime hoặc sửa Windows để vượt lỗi workerd cũ. Mục tiêu bước tiếp theo
là test trên GitHub Ubuntu sau khi được phép publish, chưa phải deploy Cloudflare.

## Kích hoạt

Chỉ sau phê duyệt publish: đưa đúng payload đã review lên main. Push không kích
hoạt workflow. Trong GitHub → Actions → **Offline package validation (manual)**
→ Run workflow → main. Không cần thêm Telegram/Cloudflare secrets để validate.
`monitor.yml` là workflow khác, không chạy trong giai đoạn này.

`validate.yml` chỉ có workflow_dispatch, `contents: read`, concurrency riêng,
Ubuntu-latest, Python 3.13, Node 24.22.2, timeout 10 phút. Token/API env để rỗng,
telemetry Wrangler tắt. Không có `--remote`, Telegram live, website scan hoặc
upload DB/log artifacts. Chromium chỉ chạy HTML fixture đã intercept mọi request.

## Các bước phải thực sự chạy

1. Kiểm manifest/checksum và cài Python bằng `requirements.lock` hash-checked,
   binary wheels; `npm ci --ignore-scripts` theo lock integrity.
2. Bộ Python offline, release exporter/path guards, DOM fixture Chromium;
   dry-run Worker JS + Node SQLite shim + Telegram mock.
3. `node --test ... test/miniflare.test.mjs`: actual workerd và DB binding local,
   migration hai lần, full atomic commit, claims song song, receipt, rollback,
   FK/integrity và stale-owner fencing. Đây không phải Node SQLite shim.
4. Toàn bộ `tests.test_deployment.Integration` với
   `MONITOR_TEST_STORAGE=workerd`. Nếu workerd không khởi động: FAIL, không
   chuyển sang shim. Backend readiness metadata bắt buộc `D1_LOCAL_WORKERD`.
5. `wrangler deploy --dry-run`: chỉ build bundle, không deploy/upload.

Harness D1 dùng Miniflare phiên bản khóa bởi Wrangler; copy Worker production
byte-for-byte vào module test và gọi `createHandler` với clock fixture. Clock
fixture nằm ở wrapper test, không phải env/endpoint production. Worker default
chỉ dùng server clock, có test từ chối ý tưởng override bằng header.
Persistence D1 local tách từng test. Restart thực sự tắt Node/workerd rồi mở lại
cùng thư mục D1; kiểm PENDING, IN_FLIGHT→UNCERTAIN, SENT sau receipt response lost.
Tất cả Telegram calls đều MockTelegramAdapter, không có website booking execution.

## Ma trận chấp nhận

| Phạm vi actual D1 local | Bằng chứng cần có |
|---|---|
| Migration | Lặp 0001 không mất dữ liệu; FK/unique/index hoạt động |
| Concurrency | Hai acquire/claim không tạo hai owner/delivery |
| Atomic mutation | Revision/fence sai rollback cả scan, slot, batch/outbox |
| QUIET | First COMPLETE không SEND; restart với NOTIFY vẫn giữ baseline QUIET |
| AVAILABLE giữ nguyên | observed_at mới, ID/transition/delivery không nhân đôi |
| Invalidation/reopen | Sửa đúng member/batch; reopen ID mới, không tái dùng ID cũ |
| PARTIAL/UNKNOWN/FAILED | Giữ facts cũ, không suy diễn RESERVED |
| Crash | PENDING còn tiếp tục được; IN_FLIGHT owner cũ thành UNCERTAIN |
| Mất receipt | Chưa commit → UNCERTAIN; đã commit nhưng response lost → SENT, không resend |
| Freshness/started | Không claim SEND từ nguồn cũ/slot đã bắt đầu |
| Safety | execution_allowed=false và auto_booking_allowed=false |

Không skip/xfailed các bước actual D1 để nhận PASS. Fail-fast được bật ở bộ D1;
không retry workflow tự động. Node tests có timeout 120 giây, child startup có
deadline, job bounded 10 phút. Nếu timeout vì môi trường: ghi FAILED/PARTIAL,
phân tích rồi sửa trong đúng scope, không chuyển paid hoặc dùng remote D1 thay local.

## Sau validation

Chỉ gọi **Ubuntu local D1 PASS** khi cả smoke và full lifecycle suite xanh trên
commit release đã review. Ghi run URL/commit SHA, số tests, engine/binding và lỗi
nếu có vào báo cáo. Chưa gọi Cloud LIVE PASS: Worker Cloud/D1 remote/Telegram vẫn
NOT_RUN. Sau đó mới xin phê duyệt riêng deploy Worker/migration remote/manual
monitor TEST. Schedule, production Group, Auto Booking/Lottery vẫn tắt.
