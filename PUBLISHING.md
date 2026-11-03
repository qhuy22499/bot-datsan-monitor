# Publish sau phê duyệt cuối cùng — chưa thực hiện

Chỉ publish allowlist cộng chính `PUBLIC_MANIFEST.json`. Không push dự án Windows,
không dùng Git history Windows, không copy node_modules/.wrangler/artifacts/DB.
`tools/export_release.py` từ chối checksum thay đổi, path traversal, links/junction,
private files và destination đã tồn tại. Không có lệnh Git/network trong exporter.

## Chuẩn bị payload

SHA-256 manifest đã duyệt và vị trí payload cụ thể được ghi trong báo cáo review
ở workspace gốc. Không tự lấy hash mới rồi coi như đã được admin duyệt.

```powershell
python tools/audit_public.py
python tools/export_release.py --destination PATH_MOI_NGOAI_PACKAGE --expected-manifest-sha256 HASH_DA_REVIEW
```

Scan payload bằng Gitleaks 8.30.1, redaction đầy đủ, default rules + config
`.gitleaks.toml`. Ngoại lệ duy nhất thêm vào là SHA-256 64 hex trong manifest đã
được verifier đối chiếu, không miễn trừ cả file/test directory hay inline allow.
Lưu report redacted ngoài public payload. Nếu có finding mới: dừng publish,
không in secret và không thêm ignore rộng để vượt scan.

## Worktree và kiểm soát trước push

1. Chỉ tạo clone từ repository đích `qhuy22499/bot-datsan-monitor` hoặc mirror đã
   audit. Kiểm HEAD main khớp commit audit trong báo cáo; nếu remote thay đổi,
   audit lại phần history mới. Không rebase/import history Windows.
2. Copy từng file trong manifest từ payload vào worktree, gồm cả dotfiles. Giữ
   `.git` của clone đích, không copy `.git` từ source/payload.
3. Chỉ `git add` các path allowlist. Kiểm `git ls-files` toàn cây đúng allowlist
   + manifest; checksum bytes trong index khớp payload. Kiểm diff staged.
4. Git config danh tính commit chỉ đặt riêng worktree nếu cần; không đổi global
   hoặc chạy Windows Administrator. Không đặt token vào remote URL/command line.
5. Local review worktree được chuẩn bị với push URL **DISABLED_FOR_READONLY_AUDIT**.
   Không gỡ guard hoặc commit/push cho tới phê duyệt cuối cùng.

Sau phê duyệt, agent/người có quyền có thể thực hiện trong worktree đã review:

```powershell
git fetch origin
git rev-parse origin/main
# DỪNG nếu không khớp audited upstream HEAD; audit lại trước.
git diff --cached --stat
git -c core.whitespace=trailing-space,space-before-tab,cr-at-eol,-blank-at-eof diff --cached --check
git commit -m "Prepare public monitoring package and Ubuntu D1 validation"
git config --unset remote.origin.pushurl
git push origin HEAD:main
```

Không `--force`, không thêm billing, không đổi visibility/settings/secrets. Không
để credential trong source/terminal/report. Nếu auth chưa có, dùng cơ chế GitHub
an toàn trên máy, không gửi token trong chat. Lệnh trên chỉ là hướng dẫn, chưa chạy.

Whitespace profile chỉ áp dụng cho lệnh review: chấp nhận CRLF của các file export
Windows và blank EOF của generated code để giữ nguyên checksum đã kiểm chứng.
Vẫn kiểm trailing whitespace thật; không đổi Git config toàn cục hoặc normalize
ngầm bytes. Đây không phải ngoại lệ cho secret/security scanning.

## Chạy validation sau publish

Chỉ chạy **validate.yml**, không cần Telegram/Cloudflare secrets. GitHub UI:
Actions → Offline package validation → Run workflow (main). Hoặc khi gh CLI đã
có auth an toàn và đã được phép dispatch:

```text
gh workflow run validate.yml --ref main --repo qhuy22499/bot-datsan-monitor
```

Push không tự kích hoạt validate/monitor; không schedule. Theo dõi yêu cầu trong
`UBUNTU_VALIDATION.md`. Chỉ sau Ubuntu D1 local PASS mới bàn deploy Worker remote.

## Cutover TEST sau này

Đã chốt **QUIET**, không phát lại tin Windows cũ, không chuyển NOTIFY sau restart.
Không giữ liên kết message cũ Windows nên không edit các tin đó từ D1. Không chạy
đồng thời hai sender. Workflow monitor có checkbox `confirm_test_delivery=false`
mặc định; chỉ được bật khi riêng phần deploy/gửi TEST đã được phê duyệt. Chỉ Group
TEST, không website login/booking, không scheduler 24/7.
