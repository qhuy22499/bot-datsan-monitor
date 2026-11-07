"""Verified PoC03 navigation/probe, unchanged one-submit login primitive."""
import os
from dataclasses import dataclass
from pathlib import Path
from playwright.sync_api import Page,TimeoutError as PlaywrightTimeoutError
BASE_URL="https://rsv.shisetsu.city.katsushika.lg.jp/katsushika/web/"
TIMEOUT_MS=30000
DOM_PROBE=Path(__file__).with_name("login_probe.js").read_text(encoding="utf-8")
EVIDENCE_NAMES=("trusted_origin","id_field_visible","password_field_visible","logout_control_visible","reservation_heading_visible","reservation_columns_visible","error_region_visible","verification_prompt_visible")
class LoginSafetyError(Exception):
    """Chỉ dùng thông báo cố định, không đưa dữ liệu trang hoặc lỗi gốc vào đây."""

@dataclass
class LoginAttempt:
    attempted: bool = False

    def submit_once(self, login_link) -> None:
        if self.attempted:
            raise LoginSafetyError("Đã thử gửi đăng nhập; không được tự gửi lần hai.")
        # Đánh dấu TRƯỚC click: timeout vẫn có thể có nghĩa server đã nhận yêu cầu.
        self.attempted = True
        login_link.click(timeout=TIMEOUT_MS)

def check_debug_settings() -> None:
    if os.environ.get("DEBUG") or os.environ.get("PWDEBUG"):
        raise LoginSafetyError("Hãy tắt DEBUG/PWDEBUG trước khi chạy với tài khoản thật.")

def read_evidence(page: Page) -> dict[str, bool]:
    raw = page.evaluate(DOM_PROBE)
    # Chỉ cho phép boolean với các tên có sẵn; không in dict trả về trực tiếp.
    if not isinstance(raw, dict) or any(type(raw.get(name)) is not bool for name in EVIDENCE_NAMES):
        raise LoginSafetyError("Không đọc được bộ cờ DOM an toàn.")
    return {name: raw[name] for name in EVIDENCE_NAMES}

def classify_evidence(before: dict[str, bool], after: dict[str, bool]) -> str:
    """Chỉ xác nhận khi đủ cả bằng chứng xác thực và cấu trúc danh sách lịch."""
    if not after["trusted_origin"]:
        return "UNKNOWN_NEEDS_VERIFICATION"
    if after["verification_prompt_visible"]:
        return "MANUAL_ACTION_REQUIRED"
    new_logout = after["logout_control_visible"] and not before["logout_control_visible"]
    new_error = after["error_region_visible"] and not before["error_region_visible"]
    if new_error:
        return "LOGIN_ERROR_CANDIDATE"
    no_login_fields = not after["id_field_visible"] and not after["password_field_visible"]
    if new_logout and no_login_fields and not after["error_region_visible"]:
        if after["reservation_heading_visible"] and after["reservation_columns_visible"]:
            return "LOGIN_CONFIRMED"
        if after["reservation_heading_visible"] or after["reservation_columns_visible"]:
            return "LOGIN_SUCCESS_CANDIDATE"
    return "UNKNOWN_NEEDS_VERIFICATION"

def wait_for_evidence(page: Page, before: dict[str, bool]) -> dict[str, bool]:
    # Chờ dấu hiệu mới, không chờ URL hoặc chỉ chờ form biến mất.
    expression = """before => {
        const now = PROBE;
        return (!now.trusted_origin || now.verification_prompt_visible
            || (now.logout_control_visible && !before.logout_control_visible
                && now.reservation_heading_visible && now.reservation_columns_visible
                && !now.id_field_visible && !now.password_field_visible && !now.error_region_visible)
            || (now.error_region_visible && !before.error_region_visible)) ? now : false;
    }""".replace("PROBE", DOM_PROBE)
    try:
        handle = page.wait_for_function(expression, arg=before, timeout=TIMEOUT_MS, polling=250)
        handle.dispose()
    except PlaywrightTimeoutError:
        pass
    return read_evidence(page)

def open_login_page(page: Page) -> None:
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.get_by_role("link").filter(
        has_text="施設を利用するにはこちらをクリックして下さい。"
    ).click()
    page.get_by_role("link", name="施設の空き状況", exact=True).wait_for(state="visible")
    page.get_by_role("link", name="予約の確認", exact=True).click()
    page.get_by_label("登録番号(ID)（半角）：", exact=True).wait_for(state="visible")
    page.get_by_label("パスワード（半角）：", exact=True).wait_for(state="visible")
    page.get_by_role("link", name="ログイン", exact=True).wait_for(state="visible")