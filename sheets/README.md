# Google Sheets Availability — Phase 2

Worker đích **bot-datsan-sheets**. Phase 2 đã được phê duyệt; cấu hình repository
bật webhook Group TEST và Cron Sheets 16 lần/ngày. Chỉ deploy sau kiểm chứng Google
LIVE và webhook không xung đột. Không sửa storage, monitoring, D1 schema hay Windows.

## Luồng và dữ liệu

Cloudflare scheduled event hoặc Telegram webhook đã xác thực → **một SQLite
Durable Object singleton `AVAILABLE-v1`** → một SELECT D1 nhất quán → projection
theo giờ JST hiện tại → đọc tab AVAILABLE → so sánh → một Google batchUpdate
REPLACE A:E nếu cần. Không Playwright, GitHub dispatch hay reservation sync.

`read-model.mjs` dùng schema `worker/migrations/0001_monitor.sql`, chọn COMPLETE
gần nhất, kiểm source.last_success và đầy đủ days×14 ô cùng scan_id. Lượt sau
FAILED/PARTIAL không thay COMPLETE cũ; cảnh báo rõ. UNKNOWN/thiếu/trùng/mixed
scan/D1 lỗi chặn ghi Sheets, không diễn giải là 0 AVAILABLE.

Chỉ AVAILABLE + in_scope=1, từ hôm nay đến window_end đã lưu. Hôm nay bỏ slot
đã bắt đầu; ngày sau giữ mọi giờ. Sắp xếp ngày/giờ/sân. Không tự cộng 30/31 ngày.
Các nhãn từ quy tắc đã chốt: ngày thường20:30 Ưu tiên1; cuối tuần/lễ18:30 Ưu
tiên1,20:30 Ưu tiên2,16:00 Chỉ thông báo; giờ khác Thông thường. Không bỏ giờ
thường. Lịch lễ dùng lại JSON Cabinet Office 2026–2027; thiếu coverage ghi
Chưa xác minh ngày lễ. Thứ T2…CN và DD/MM/YYYY chỉ là trình bày.

## Sheets và concurrency

Metadata rows1–8; header row9; dữ liệu từ row10. Chỉ một tab AVAILABLE, A:E do
Bot quản lý. Tab ID giữ nguyên. batchUpdate xóa giá trị cũ ngoài danh sách mới
và ghi danh sách trong cùng transaction atomic; không append/delete/create tab.
Field masks giữ định dạng ngoài phần tiêu đề/header, độ rộng cột và bộ lọc mà
Bot quản lý. Không reset number formats/borders hay cột F trở đi. 0 slot hợp lệ
vẫn ghi metadata0 và làm sạch dòng cũ.

So sánh cả grid đã lọc theo **giờ hiện tại**, observed_at, cảnh báo stale/source;
chỉ bỏ timestamp cập nhật Sheets khỏi phép so sánh. Cùng scan_id vẫn phải bỏ
slot vừa bắt đầu/cập nhật cảnh báo. Timestamp quan sát luôn tách timestamp ghi.

Khóa không chỉ nằm trong RAM: mọi instance dùng cùng DO ID. SQL ledger riêng
lưu WRITING trước Google request. Restart WRITING→UNCERTAIN; chỉ read-back
khớp toàn bộ lần ghi, kể cả timestamp, mới xác nhận. Không khớp thì chặn lần
ghi sau và cần quản trị viên đối chiếu; không reset/retry mù quáng.

**Không có mutation D1:** chỉ `read-model.mjs` nhận binding DB và chỉ prepare
một SELECT. Các INSERT/UPDATE/CREATE trong `store.mjs` thuộc `ctx.storage.sql`
của DO mới, hoàn toàn không phải D1 nghiệp vụ. Không migration D1.

## Telegram

Public route duy nhất POST `/telegram/webhook`, mặc định tắt. Xác minh header
`X-Telegram-Bot-Api-Secret-Token`, đúng Group TEST, `/available` hoặc
`/available@TELEGRAM_BOT_USERNAME`. Thành viên trong Group đều có thể gọi.
Không public manual-sync endpoint; không getUpdates/long polling trong Worker.

Trước HTTP200, inbox update_id phải lưu bền vững. Sheets xử lý bất đồng bộ bằng
DO waitUntil; alarm là fallback cho inbox PENDING sau gián đoạn, không retry send.
Cùng update không gửi hai lần. Nhiều update khác nhau được mỗi update một phản
hồi ngắn nhưng cùng đợi một sync, không ghi Google nhiều lần. SENDING gián đoạn
hoặc mất response giữ UNCERTAIN, không resend. Không lưu tên/user ID/raw payload.

Deadline chung **15 giây từ nhận webhook**, xuyên qua chờ D1/OAuth/Google; không
cộng15 giây mỗi tầng. Hết hạn trả cảnh báo/link dữ liệu trước đó, không báo
UPDATED giả. Việc gửi phản hồi Telegram có timeout mạng riêng tối đa10 giây.
Crash/hết quota nền tảng không thể bảo đảm thời gian giao tin tuyệt đối; inbox
bền vững vẫn cho phép phục hồi an toàn. Scheduled Sync không gửi Telegram.

## Cấu hình triển khai đã được phê duyệt

`wrangler.jsonc` dùng đúng DB hiện có và Spreadsheet ID, không placeholder.
Giữ Google secret hiện có, không đọc/ghi giá trị trong repository:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: secret có sẵn; RS256 OAuth, scope spreadsheets.
- `GOOGLE_SPREADSHEET_ID`: var có sẵn.
- DB: `bot-datsan-monitor-db`, binding `DB`, ID đã đối chiếu.
- DO binding `SHEETS_COORDINATOR`, SQLite class migration
  `sheets-coordinator-v1` (**không phải D1 migration**).
- Phase2 cần secrets `TG_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_TEST_CHAT_ID`; var `TELEGRAM_BOT_USERNAME` lấy từ getMe.

Phase1 từng giữ flags OFF và không có Cron. Phase2 dùng flags ON, bot username
đã xác minh bằng getMe; chat ID luôn là Secret, không đưa vào cấu hình Git.

Sau phê duyệt Phase2: kiểm secrets/bindings; deploy đúng Worker với flags OFF;
sync TEST có kiểm soát và kiểm tab; xác minh không có getUpdates consumer rồi
đăng ký webhook với secret header và allowed_updates=[message] (không tự xóa
pending updates). Sau test /available, bật flag và Cron:

`10 0-13,22-23 * * *` UTC = **07:10,08:10,…,22:10 JST**,16 lần/ngày. UTC22/23
thuộc ngày JST kế tiếp. Không đợi monitoring phút07. Guard bỏ scheduled event
thực thi ngoài07:10–22:10 JST; monitoring Cron15 phút giữ nguyên.

## Test/build offline

Từ repository, Node24.22.2 và Wrangler4.156.0 đã pin trong worker:

```powershell
node --test sheets/test/*.test.mjs
cd sheets
node ../worker/node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir artifacts/build
```

Tests offline dùng RSA key sinh trong RAM và mock Google/Telegram, không credential
thật. Quy trình triển khai LIVE chỉ áp dụng trong phạm vi Phase2 đã được admin duyệt.

## Quota và giới hạn còn lại

SQLite DO dùng được Workers Free:100k requests/ngày,13k GB-s/ngày,5M SQL reads,
100k SQL writes/ngày,5GB storage; vượt quota phải lỗi, không bật Paid. Ledger này
không tiêu rows written D1.16 sync/day thường khoảng16 Google reads,0–16 atomic
writes, cộng lệnh thành viên. Google quota60 read/write/phút/user/project và300
/phút/project; không bật billing/trial. API không retry/backoff tự đặt.

History inbox giữ bền vững, chưa tự xóa; cần xem xét retention khi vận hành lâu.
D1 query latest COMPLETE có thể đọc scan history tăng dần; chưa thêm index vì
không được đổi schema. Khóa/quota/CPU và actual DO/workerd/Google/webhook LIVE
còn phải xác minh Phase2. Phase1 không đồng nghĩa sẵn sàng chạy production.

Nguồn: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[DO state](https://developers.cloudflare.com/durable-objects/api/state/),
[Sheets limits](https://developers.google.com/workspace/sheets/api/limits),
[Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate),
[Google Service Account](https://developers.google.com/identity/protocols/oauth2/service-account),
[Telegram webhook](https://core.telegram.org/bots/api#setwebhook).

`execution_allowed=false`; `auto_booking_allowed=false`.
