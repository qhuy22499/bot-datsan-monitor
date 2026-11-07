"""Scan-bound public availability messages; no storage, network or booking."""
from datetime import datetime
from .display import display_date
from .shared.domain import JST, Slot
from .shared.scope import notification_eligibility

SHEETS_URL = 'https://docs.google.com/spreadsheets/d/1Qj5UBVpXQ6M_FfsYvCYbj_nnKlRRya7cWrcMR7Ifeqc/edit#range=AVAILABLE!A1:E'


def units(text):
    return len(text.encode('utf-16-le')) // 2


def category(slot, calendar):
    holiday = calendar.is_holiday(slot.day)
    if slot.day.weekday() < 5 and holiday is None:
        return 'Cần xác minh ngày lễ' if slot.start in {'16:00', '18:30', '20:30'} else None
    if slot.day.weekday() >= 5 or holiday:
        return {'16:00': 'Chỉ thông báo', '18:30': 'Ưu tiên 1', '20:30': 'Ưu tiên 2'}.get(slot.start)
    return 'Ưu tiên 1' if slot.start == '20:30' else None


def current_slots(scan, calendar, now):
    result = []
    for slot in scan.slots:
        if slot.status != 'AVAILABLE' or datetime.combine(slot.day, datetime.strptime(slot.start, '%H:%M').time(), JST) <= now:
            continue
        label = category(slot, calendar)
        if label:
            result.append((slot, label))
    return sorted(result, key=lambda item: (item[0].day, item[0].start, item[0].court))


def interesting(slot, calendar, observations, now):
    # Use AVAILABLE only to ask the existing time/calendar eligibility rule;
    # a removal's real website state is retained separately by the planner.
    candidate = Slot(slot.day, slot.court, slot.start, slot.end, 'AVAILABLE')
    return notification_eligibility(candidate, calendar, now=now,
        observed_at=observations[slot.day])['notification_eligibility'] == 'ELIGIBLE'


def line(slot):
    return f'{display_date(slot.day.isoformat())} · Sân {slot.court} · {slot.start}–{slot.end}'


def pages(changes, current, observed_at):
    """Never truncate changes. Only the current list may be shortened explicitly."""
    new_keys = {(s.day, s.court, s.start) for kind, s in changes if kind == 'new'}
    known = [(s, label) for s, label in current if label != 'Cần xác minh ngày lễ']
    unknown = [(s, label) for s, label in current if label == 'Cần xác minh ngày lễ']

    def render(items, page, total, count):
        text = ['⚽ CẬP NHẬT SÂN TRỐNG']
        if total > 1:
            text.append(f'Trang {page}/{total}')
        for kind, title in [('new', '🟢 Vừa xuất hiện'), ('lost', '🔴 Vừa hết trống')]:
            rows = [s for k, s in items if k == kind]
            if rows:
                text.extend(['', f'{title} ({len(rows)})', *map(line, rows)])
        text.extend(['', f'⭐ SÂN ƯU TIÊN HIỆN TẠI ({len(known)})'])
        if not known and not unknown:
            text.append('Hiện không còn sân trống ưu tiên.')
        elif not known:
            text.append('Chưa thể xác định đầy đủ khung giờ phù hợp do thiếu lịch lễ.')
        ordered = sorted(known + unknown, key=lambda item: (item[0].day, item[0].start, item[0].court))
        for s, label in ordered[:count]:
            text.append(line(s) + f' · {label}' + (' 🆕' if (s.day, s.court, s.start) in new_keys else ''))
        if count < len(ordered):
            text.append(f'… Còn {len(ordered)-count} khung giờ trong danh sách; xem Google Sheets và đối chiếu thời điểm cập nhật.')
        if unknown:
            text.append(f'⚠️ {len(unknown)} khung giờ cần xác minh lịch lễ, chưa tính vào tổng ưu tiên.')
        text.extend(['', f'🕒 Quét: {observed_at.astimezone(JST):%d/%m/%Y %H:%M} JST',
                     f'🔗 Google Sheets: {SHEETS_URL}', 'Kiểm tra website trước khi đặt.'])
        return '\n'.join(text)

    chunks = [[]]
    for change in changes:
        if units(render(chunks[-1] + [change], 128, 128, 0)) > 3800:
            chunks.append([])
        chunks[-1].append(change)
    output = []
    for index, chunk in enumerate(chunks, 1):
        count = 0
        while count < len(current) and units(render(chunk, index, len(chunks), count + 1)) <= 4000:
            count += 1
        text = render(chunk, index, len(chunks), count)
        if units(text) > 4096:
            raise ValueError('MESSAGE_TOO_LONG')
        output.append((chunk, text))
    return output
