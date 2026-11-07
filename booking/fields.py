"""Pure PoC03-B verified field validators; no 90-day truncation."""
import re,unicodedata
from datetime import date
from typing import Any
RESERVATION_TOKENS = frozenset({
    "確定", "予約確定", "予約済", "確認済", "承認済", "仮予約", "未確定",
    "承認待ち", "確認待ち", "申込中", "取消", "取消済", "取消済み",
    "キャンセル", "キャンセル済", "抽選申込", "抽選待ち", "抽選中",
    "当選", "落選", "未抽選", "申請中", "審査中",
})
PAYMENT_TOKENS = frozenset({
    "支払前", "支払済", "支払済み", "支払い済み", "未払い", "入金済", "未入金",
})
class DataValidationError(ValueError):
    """Thông báo cố định; không mang nội dung dữ liệu nguồn."""

def _invalid() -> None:
    raise DataValidationError("Cấu trúc dữ liệu PoC 03-B không hợp lệ.") from None

def _normal(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 120:
        _invalid()
    return " ".join(unicodedata.normalize("NFKC", value).split())

def _date_text(value: Any) -> date:
    text = _normal(value)
    match = re.fullmatch(r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(?:[日月火水木金土]曜日|\([日月火水木金土](?:曜日)?\)))?", text)
    if not match:
        match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)
    if not match:
        _invalid()
    try:
        return date(*(int(part) for part in match.groups()))
    except (ValueError, OverflowError):
        _invalid()

def _times(value: Any) -> tuple[str, str]:
    text = _normal(value)
    parts = re.split(r"\s*[〜~～\-]\s*", text)
    if len(parts) != 2:
        _invalid()
    parsed = []
    for part in parts:
        match = re.fullmatch(r"(\d{1,2})時\s*(\d{1,2})分", part)
        if not match:
            match = re.fullmatch(r"(\d{1,2}):(\d{2})", part)
        if not match:
            _invalid()
        parsed.extend(int(number) for number in match.groups())
    start_h, start_m, end_h, end_m = parsed
    if not (0 <= start_h <= 23 and 0 <= end_h <= 23 and 0 <= start_m <= 59
            and 0 <= end_m <= 59 and (start_h, start_m) < (end_h, end_m)):
        _invalid()
    return f"{start_h:02}:{start_m:02}", f"{end_h:02}:{end_m:02}"

def _number(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,40}", value):
        _invalid()
    return value

def _reservation_status(value: Any) -> str:
    # raw chỉ dùng để kiểm tra hợp đồng DOM nội bộ; không cần có cột trạng thái.
    if value is not None and (not isinstance(value, str) or value not in RESERVATION_TOKENS):
        _invalid()
    return "CONFIRMED"

def _payment_status(value: Any) -> dict:
    if value is not None and (not isinstance(value, str) or value not in PAYMENT_TOKENS):
        _invalid()
    # Chỉ 支払前 đã được xác minh nghĩa là chưa thanh toán.
    normalized = "UNPAID" if value == "支払前" else "UNKNOWN"
    return {"raw": value, "normalized": normalized}
