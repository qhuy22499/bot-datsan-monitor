# Security review / phạm vi kiểm chứng

- [x] Staging riêng, export AST allowlist, checksum gốc và generated outputs.
- [x] Không login/reservation/account/Vault Windows/SQLite thật trong package.
- [x] Không copy git history, DB/backup/trace/session/cookie/private config.
- [x] Token Telegram chỉ nhận environment; Worker auth chỉ nhận Secret.
- [x] API HTTPS, không redirect, auth trên cả snapshot, typed endpoints/payload,
  body cap, record cap, SQL bind và enum/identity/date/grid validation.
- [x] SQL identifiers trong bulk helper do code cố định, không nhận từ request.
- [x] Lease/fence/revision guard, claim trước send, receipt sau response hợp lệ.
- [x] UNCERTAIN và FAILED không tự retry; không có retry/backoff tự đặt.
- [x] Workflow quyền read, SHA-pinned actions, không persist Git credential,
  không pull_request_target, không cache/artifact hay secret echo.
- [x] Production mutation/booking endpoints không tồn tại. Telegram keyboard rỗng.
- [x] Local source/token/DB không ghi vào report public hoặc log.
- [x] Git portable 2.56.0.windows.4 + Gitleaks 8.30.1: mirror đích, mọi ref reachable
  fetch được, 1 commit, 0 finding, git fsck PASS. Không lấy history Windows.
- [x] Gitleaks trên payload allowlist, redacted, mặc định rules; một false positive
  SHA-256 manifest đã được chứng minh và ngoại lệ AND path + 64-hex rất hẹp.
- [x] npm audit lockfile 0 advisory; OSV cho bốn Python packages 0 advisory tại
  review. Pin wheel hash cho Ubuntu/Windows. Không đồng nghĩa không có lỗ hổng;
  vẫn cần theo dõi upstream. Không tự gán license cho project của người dùng.
- [x] actionlint 1.7.12 kiểm YAML; validate không secrets/live/remote DB, monitor
  manual có checkbox false mặc định và baseline cố định QUIET.
- [ ] Worker/D1 local thực tế: workerd Windows runtime access violation; Ubuntu
  test workflow được chuẩn bị nhưng chưa push/chạy. Cloud E2E chưa được phép.
- [ ] Quotas, CPU, restore và reconciliation operator cần nghiệm thu thực tế.

`python tools/audit_public.py` so sánh tất cả file khả dụng với manifest và scan
các mẫu phổ biến. Chỉ `PUBLIC_MANIFEST.json` là danh sách chuyển sang repo mới;
thư mục hiện có node_modules/artifacts ignored phục vụ test, không publish chúng.
Không dùng `git add .` ở workspace gốc. Không in matched secret khi có finding.
Nếu phát hiện secret thật, dừng publish và rotate qua provider UI, không gửi lại
secret trong chat. Lần rà soát này không đọc Vault hoặc root debug.log.

Bearer có quyền đọc/ghi state Monitoring nên phải bảo vệ như credential. Giữ
secret riêng môi trường TEST; không dùng Cloudflare admin credential trong Actions
job runtime. Các ID Telegram/message được lưu D1 có auth, không ghi public logs.
Local test harness chỉ bind 127.0.0.1, fake secret rõ ràng, không nằm trong Worker
bundle; `/__clock` và `/__integrity` chỉ tồn tại ở harness, không có ở deployed API.
Mọi lifecycle integration test được chuẩn bị chạy lại trên actual local D1 ở
Ubuntu, không fallback shim. Source Windows được xác minh checksum, không sửa.
