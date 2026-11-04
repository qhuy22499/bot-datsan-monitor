# Bot DatSan — GitHub Actions + Worker + D1 (chuẩn bị triển khai)

Ngày rà soát: **31/10/2026 JST**. Chỉ dùng **Group TEST**. Chưa deploy, chưa push,
chưa ghi D1 remote, chưa gửi Telegram từ runtime này. Schedule **OFF**.
Lần cutover GitHub TEST đầu tiên đã chốt **QUIET**; không gửi lại baseline Windows.

## Phạm vi và cấu trúc

`Actions one-shot → public Playwright headless → core đã kiểm chứng → Worker API → D1 → outbox → Telegram TEST → receipt D1`.

- `monitor/shared/`: bản xuất AST allowlist của domain, UI reader, mapping,
  collector, tháng lịch, eligibility, holiday loader, renderer và Telegram adapter
  Windows. `CORE_PROVENANCE.json` ghi checksum; không sao chép repo cũ.
- `monitor/collector.py`: chỉ đổi hosting sang headless và thêm cleanup/oracle;
  giữ `次の日`, chờ đúng ngày và đủ 14 ô/ngày của MVP đã PASS.
- `monitor/core.py`: pure delta planner cho storage D1; không dùng reservation,
  quota ba ngày/tuần hoặc auto-booking engine. D1 transaction khác SQLite nên
  không chạy SQL repository Windows qua HTTP. Bộ dịch delta/lifecycle D1 mới
  được kiểm riêng; không khẳng định đã chạy lại toàn bộ Notification Manager cũ.
- `monitor/storage.py`: port `call(command,payload)` và client HTTPS không retry,
  không redirect; không có SQLite authoritative/cache trong runner.
- `worker/src/index.mjs`: auth bearer, API command cố định, SQL bind, D1 batch,
  lease/fencing, outbox claim/receipt. Không endpoint SQL tùy ý.
- `worker/migrations/0001_monitor.sql`: schema MVP mới riêng; không chuyển các
  bảng account/reservation/callback cũ.
- `.github/workflows/monitor.yml`: manual trigger, Linux Python 3.13, timeout
  10 phút, concurrency, permissions read. Cron chỉ là comment.

Windows APScheduler/SQLite vẫn hoạt động bằng source cũ. Oracle có thể dùng nguyên
runtime Windows với adapter OS phù hợp hoặc collector/core/Storage port ở đây;
không có business rule phụ thuộc vào GitHub hay Cloudflare.

## Kiểm thử offline độc lập

Cần Python 3.13, Node **24.22.2** hoặc Node 24 tương thích; không cần Administrator.
Từ thư mục này:

```powershell
python -m pip install --require-hashes --only-binary=:all: -r requirements.lock
python -m playwright install chromium
python -m unittest tests.test_deployment tests.test_collector_dom tests.test_release_safety -v
python -m monitor.runtime --dry-run
cd worker
npm ci --ignore-scripts
node --test test/api.test.mjs
node --test test/miniflare.test.mjs
```

`tests.test_deployment` và dry-run dùng Worker JS thật + shim binding SQLite
Node `node:sqlite` trên loopback, Telegram mock và clock giả. Chúng **không phải
D1 thực tế**. `miniflare.test.mjs` dùng workerd + D1 local, không tài khoản Cloudflare.
Không skip test này để nhận chứng chỉ D1. Trên máy Windows hiện tại workerd bị
`ERR_RUNTIME_FAILURE / 0xC0000005` trước khi D1 chạy; đây là bước kiểm chứng còn
thiếu. Cần chạy trên Ubuntu CI sau khi được phép publish hoặc sửa dependency
runtime Windows. Không tự cài VC++ Redistributable toàn hệ thống.

Workflow `validate.yml` chạy thủ công bộ offline trên Ubuntu, không secret hay
D1 remote/Telegram thật. Sau smoke test workerd, workflow chạy toàn bộ Integration
suite với `MONITOR_TEST_STORAGE=workerd`: actual D1 binding, không fallback shim.
Harness bắt buộc đúng backend, có restart tiến trình và persistence D1 local.
Fake clock chỉ ở wrapper test; Worker deploy không nhận clock từ header.
Chưa push nên workflow này cũng chưa chạy. Xem `UBUNTU_VALIDATION.md`.

Wrangler được pin **4.156.0**, package-lock có integrity. Lần thử 4.45.0 cũng bị
runtime access violation nên không giữ bản cũ. Python pin đúng bản môi trường
đã PASS: Playwright 1.64.1, greenlet 3.5.6, pyee 14.0.0 và transitive dependency
typing_extensions 4.16.0. Wheel Ubuntu đã được pip download kiểm đủ hash.
Không cần keyring,
APScheduler hay Telegram framework trong runner. CI không chạy `npm audit fix`
hoặc tự nâng dependency. Review lại advisory trước publish/deploy.

## API/storage contract

Mọi request POST JSON qua HTTPS, `Authorization: Bearer <MONITOR_API_SECRET>`.
Worker Secret tên **API_SECRET** phải cùng giá trị, chỉ nhập tại máy/Cloudflare.
Chọn bearer trên TLS: đơn giản, scope chỉ API Monitoring; không cấp Cloudflare
admin token cho Actions runtime. Hash so sánh cố định, không log header/body.
HMAC không cần thiết ở bản đầu; lease/revision chống replay tạo duplicate state.

API `/v1/`: `acquire`, `snapshot`, `commit`, `failure`, `claim`, `receipt`, `release`.
Body tối đa 800 KB; row limits và exact key/type/status validation. Snapshot chặn
khi vượt 20.000 hàng/bảng; client response tối đa 2 MB. Vượt cap thì dừng, không
tự nhận COMPLETE. Đây là guard kỹ thuật; retention/archive phải thiết kế trước
vận hành dài hạn. Không có API xóa history hoặc tự retry/reconcile mù quáng.

- Lease server-time **12 phút**, dài hơn timeout job 10 phút; một owner/fence.
- Owner mới chỉ acquire khi lease hết/được release; mỗi acquire tăng fence.
- Mọi mutation trong `D1.batch()` có SQL CHECK guard cùng transaction; commit
  kiểm revision. Owner cũ không được ghi sau khi fence mới xuất hiện.
- Snapshot dùng SELECT-only batch cùng primary session, vẫn kiểm owner/fence;
  không INSERT/DELETE guard khi chỉ đọc và không thay source revision.
- Claim chỉ khi latest scan COMPLETE, slot AVAILABLE/in-scope/chưa bắt đầu,
  observation không quá 5 phút, batch revision hợp lệ và chưa có claim/UNCERTAIN.
- D1 `IN_FLIGHT` được ghi **trước** Telegram. Owner kế tiếp chuyển claim bỏ dở
  thành `UNCERTAIN`. Không tự chuyển về PENDING.
- Chỉ ghi SENT/message_id sau response Telegram hợp lệ. Receipt lost → dừng;
  nếu D1 đã commit thì giữ SENT, nếu chưa commit thì lần sau UNCERTAIN.
- FAILED không tự retry. UNCERTAIN chặn dispatch nguồn; cần admin đối chiếu
  message trong Group và sửa bằng quy trình maintenance được duyệt riêng.
- Telegram + D1 **không có distributed transaction / exactly-once tuyệt đối**.
  Ưu tiên không spam; có thể bỏ lỡ một tin cho tới khi admin xử lý ambiguity.

Schema: `source`, `lease`, `atomic_guard`, `scans`, `slots`, `opportunities`,
`batches`, `members`, `jobs`, `transitions`, `schema_meta`. Identity slot ổn định
theo ngày/sân/giờ, active opportunity unique/slot, membership unique/opportunity,
job unique(batch,revision,kind), FK và unique indexes. No-change refresh observed_at
nhưng không ghi transition/opportunity mới. Out-of-scope/STARTED là EXPIRED;
không sửa trạng thái website thành RESERVED. PARTIAL/FAILED chỉ ghi scan/error.
COMPLETE sau lỗi xóa last_error, giữ lịch sử scans.

Batch tối đa 24 slot, không bỏ slot vì message dài; membership gắn receipt từng
opportunity. Initial có thể chia batch; mỗi run tối đa 2 tin mới. Khi một member
invalidated chỉ sửa batch liên quan, giữ member khác, keyboard luôn rỗng. Không
TTL. No command/polling/callback/booking trong package này. Nội dung ghi rõ TEST,
nguồn, phạm vi, quan sát JST và yêu cầu tự kiểm tra trước khi đặt.

## Chuẩn bị publish an toàn

Chỉ publish file có trong **PUBLIC_MANIFEST.json** sau khi review checksum.
Không `git add D:\Projects\VSC`, không copy `.git`, DB, `.venv`, logs hay config
private. Không copy nguyên cây staging có `node_modules` hoặc artifacts.

```powershell
python tools/audit_public.py
```

Lệnh kiểm cả file không ignore, tên file nhạy cảm, symlink, kích thước và mẫu secret;
chỉ in path finding, không in match. Manifest thay đổi phải review rồi mới refresh.
Sau publish, GitHub Secret Scanning/Push Protection là lớp bổ sung. Xem
`SECURITY_REVIEW.md`: reachable history đích đã quét bằng Git portable/Gitleaks;
không đưa Git history Windows vào release. Cách export/publish: `PUBLISHING.md`.

## Deploy sau khi người dùng duyệt riêng (chưa thực hiện)

1. Review package + baseline plan; dừng Windows sender trước cutover để hai
   database không độc lập gửi cùng nguồn. Không tự kill process.
2. Chỉ đưa manifest vào repo `qhuy22499/bot-datsan-monitor`. Giữ repo public,
   dùng standard hosted runner; không đổi settings, không force push.
3. Trong Cloudflare, lấy ID của **database đã có** `bot-datsan-monitor-db`.
   Copy `worker/wrangler.jsonc` thành `worker/wrangler.deploy.json` (ignored),
   thay database_id placeholder; không tạo/xóa database. Không commit token.
4. Đăng nhập Wrangler tại terminal hoặc cấp API token tối thiểu qua biến môi
   trường local. Quyền chỉ Worker Scripts edit và D1 edit của account đích cho
   deploy/migration; không đưa token quản trị này vào runtime Actions. Workers
   Secrets dùng prompt, không đặt giá trị secret trên command line/log.
5. Backup/export D1 trước migration nếu đã có dữ liệu. Review migration list.
   Các lệnh dưới **chỉ chạy sau phê duyệt remote write/deploy**:

```powershell
cd worker
npm ci --ignore-scripts
npx wrangler d1 migrations list bot-datsan-monitor-db --remote --config wrangler.deploy.json
npx wrangler d1 migrations apply bot-datsan-monitor-db --remote --config wrangler.deploy.json
npx wrangler secret put API_SECRET --config wrangler.deploy.json
npx wrangler deploy --config wrangler.deploy.json
```

6. GitHub repository Secrets (chỉ nêu tên, tự nhập qua UI):
   **MONITOR_API_URL**, **MONITOR_API_SECRET**, **TELEGRAM_BOT_TOKEN**,
   **TELEGRAM_TEST_CHAT_ID**. Worker Secret: **API_SECRET**. Giá trị secret API
   nên là chuỗi ngẫu nhiên URL-safe tối thiểu 32 ký tự, không gửi trong chat.
7. Xác minh chat là Group TEST. Không dùng Group đội chính thức. D1 source giữ
   destination đầu tiên và từ chối destination khác để tránh đổi nhầm qua jobs.
8. Sau khi Ubuntu local-D1 test PASS và được duyệt deploy/gửi TEST riêng, chạy
   `monitor.yml` và đánh dấu `confirm_test_delivery`. Baseline cố định **QUIET**.
   Lượt đầu ghi baseline không Telegram. Kiểm tra counts/current/opportunity,
   FK, receipt, Worker CPU/rows metrics trên dashboard, không in payload logs.
9. Lượt manual tiếp theo: giữ AVAILABLE → gửi 0; khi có thay đổi thật mới gửi.
   Không tạo giả dữ liệu website để gọi LIVE PASS. Có thể cần chờ cơ hội tự nhiên.
10. Kiểm tra riêng GitHub → Telegram: manual `workflow_dispatch`, chọn cả
    `confirm_test_delivery` và `telegram_transport_test`. Chế độ này gửi đúng một
    tin TEST trung lập, bỏ qua Chromium/scan/D1, không đổi opportunity/baseline.
    Không chạy lại mù quáng nếu kết quả gửi UNCERTAIN. Probe đã LIVE PASS ngày
    03/11/2026, message_id 16; không cần bật probe khi chạy monitoring bình thường.

## Cloudflare Cron trial — chỉ Group TEST

Nguồn kích hoạt tự động hiện tại: **Worker `bot-datsan-cron` → GitHub
workflow_dispatch → Python/Playwright → D1 → Telegram Group TEST**. GitHub native
schedule đã bị loại khỏi workflow sau hai controlled dispatch LIVE COMPLETE ngày
04/11/2026. Không có sender thứ hai; Storage Worker và baseline QUIET giữ nguyên.

Cron Worker chỉ gọi GitHub API, không có D1 binding, không chạy Chromium hoặc gửi
Telegram. Source ở `cron/`, dùng Wrangler đã pin trong `worker/node_modules`.
Secret duy nhất: **GITHUB_DISPATCH_TOKEN**, fine-grained PAT chỉ repository này,
Actions read/write; nhập qua Worker Secrets, không commit. Theo dõi expiry và
rotation của token. Không sử dụng credential GitHub rộng quyền từ máy local.

`cron/wrangler.jsonc`: UTC `7,22,37,52 0-14,22-23 * * *` = **07:07–23:52 JST**,
68 lượt/ngày, cách nhau 15 phút trong giờ website 07:00–24:00 JST.
Production `workers_dev=false`, `preview_urls=false`; HTTP handler luôn 404.
Không có endpoint công khai để kích hoạt job. Không tự deploy file config này
nếu chưa kiểm tra đúng account, thử dispatch và tắt nguồn schedule khác.

Cron gọi đúng `monitor.yml`, `main`, `confirm_test_delivery=true`,
`telegram_transport_test=false`, metadata `dispatch_source=cloudflare_cron` và
`trigger_id`. Input metadata không cấp quyền booking. GitHub concurrency cùng
lease/fencing/outbox D1 chống overlap và gửi trùng. Mỗi event chỉ POST một lần;
UNCERTAIN/HTTP 5xx không tự resend. Dùng trigger_id để reconcile Actions history.
HTTP 200 chỉ được chấp nhận với schema run ID/URLs đúng repository; vẫn hỗ trợ
204 cũ. Không coi dispatch accepted là scan COMPLETE.

Manual Actions + Worker/D1 LIVE đã PASS hai lượt ngày 03/11/2026, mỗi lượt
31 ngày/434 ô, baseline QUIET; không tạo notification trùng.
Sau GitHub → Telegram TEST PASS, lịch trial đã được phép bật ngày 03/11/2026.
Người vận hành chấp nhận độ trễ 30–60 phút hoặc bỏ một lượt trên Free Tier.
CPU có thể vượt 10ms trong burst; không bảo đảm mọi request luôn thành công.
Giữ source lock/fencing, atomic commit và UNCERTAIN khi kết quả gửi chưa rõ;
lượt lỗi không được coi COMPLETE và lượt sau phải quét mới để xác minh phục hồi.
Giữ manual confirmation cho workflow_dispatch; Cron Worker gửi confirmation
TEST rõ ràng. Không bật lại GitHub native cron khi Cloudflare Cron đang hoạt động.
Tiếp tục theo dõi quotas, lịch lễ, kỳ thiếu ngày tương ứng và không hai sender.
Dù cron delayed, runtime
vẫn kiểm giờ thực và date ở JST; qua nửa đêm scan không COMPLETE. Cron không
bảo đảm tick đúng giờ, có thể drop/disable sau inactivity. Không SLA realtime.

Ngày cuối tháng ngắn có thể trả BOOKABLE_BOUNDARY_UNVERIFIED; giữ fail-safe,
không âm thầm rút ngắn ALL_BOOKABLE. Calendar chỉ có coverage 2026–2027.
Không dùng Reservation Freshness để chặn Availability notification.

Lịch đã cấu hình không phải bằng chứng scheduled run hoặc trial 24–48 giờ PASS.
Xem Actions → workflow → event `workflow_dispatch`, trigger_id `cfcron-…`, summary và D1 last_success. Khi chưa
có scheduled run thành công, chỉ ghi CONFIGURED. Theo dõi Worker CPU/5xx và D1
Metrics → Row Metrics; không coi zero notification khi không có biến động là lỗi.

**Tạm dừng nhanh:** Actions → workflow này → menu `…` → Disable workflow.
Việc này chặn lượt mới, không rollback D1 hoặc tự dừng job đang chạy; ưu tiên cho
job hiện tại kết thúc để ghi receipt/release lease. Không chạy Windows sender song
song. Nếu buộc phải cancel do nguy cơ spam, kiểm tra IN_FLIGHT/UNCERTAIN trước khi
khởi động lại, không reset baseline hoặc resend. Không tự bật Paid.

**Tạm dừng trigger lâu hơn:** đặt `triggers.crons=[]` rồi deploy đúng Cron Worker,
hoặc xóa Cron Trigger trong Dashboard. Chỉ bỏ property không bảo đảm xóa trigger.
Không xóa Worker, database hoặc baseline. Nếu chỉ disable workflow GitHub thì
Cron vẫn có thể gọi API và nhận lỗi; cần dừng cả trigger khi bảo trì kéo dài.

**Inactivity/token:** chính sách auto-disable 60 ngày của GitHub native schedule
không phải lý do tự thêm keepalive cho luồng workflow_dispatch. Vẫn kiểm tra
workflow active, account/Actions permissions và PAT expiry. Khi khôi phục, giữ
D1 identity/receipts, kiểm tra UNCERTAIN và quan sát run mới thực COMPLETE.

**execution_allowed=false; auto_booking_allowed=false.**

Ngày trong tin SEND/EDIT được trình bày `T2 16/11/2026` … `CN 22/11/2026` bởi
`monitor/display.py` tại lớp adapter; renderer generated và ngày ISO trong D1
giữ nguyên. Workflow `availability-summary-test.yml` chỉ phục vụ một bản tổng
hợp TEST mới do admin yêu cầu ngày 04/11/2026, manual-only, cùng concurrency
group và không nhận D1 secrets. Sau lượt được duyệt, workflow được disable;
không phải tính năng gửi tổng hợp định kỳ. Bản tổng hợp yêu cầu COMPLETE
ALL_BOOKABLE, từng observation <=5 phút và không cắt mất slot khi phân trang.

**Rollback về 30 phút:** thay đồng bộ `cron/wrangler.jsonc`, `CRON` và minute
allowlist trong `cron/src/index.mjs` về `7,37 0-14,22-23 * * *`, phút `[7,37]`;
cập nhật tests/manifest, kiểm tra targeted tests rồi deploy **cùng** Worker
`bot-datsan-cron`. Chỉ sửa Cron trên Dashboard sẽ không đồng bộ validation.
Giữ đúng một trigger; không bật GitHub native schedule, không reset D1/baseline.
