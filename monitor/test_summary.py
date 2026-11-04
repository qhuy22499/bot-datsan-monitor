"""One approved TEST summary: fresh public collector -> Telegram; no storage port.

This does not plan, commit, claim or acknowledge monitoring outbox jobs.
The temporary/manual workflow is disabled by the operator after its one run.
"""
from datetime import datetime
import argparse
import json
import os
from .display import display_date
from .shared.domain import JST, FACILITY, ScanResult, ScanError, iso_time, require
from .shared.scope import MonitoringScope, notification_eligibility
from .shared.calendar import load_calendar
from .shared.telegram import TelegramBotAdapter, TelegramDeliveryError, chat_id

TITLE = '[TEST — DANH SÁCH SÂN TRỐNG HIỆN TẠI]'
MAX_TEXT_UNITS = 3900


def text_units(text):
    return len(text.encode('utf-16-le')) // 2


def verify_scan(scan, *, now):
    require(isinstance(scan, ScanResult) and scan.read_status == 'COMPLETE', 'SUMMARY_SCAN_INCOMPLETE')
    scan.__post_init__()
    require(scan.scope_mode == 'ALL_BOOKABLE' and scan.boundary_verified, 'SUMMARY_SCOPE_UNVERIFIED')
    scope = MonitoringScope().resolve(anchor=scan.started_at.astimezone(JST).date())
    days = [d for d, _ in scan.observations]
    require(days[0] == scope.start_date and days[-1] == scope.end_date
            and scan.expected_days == scope.expected_days and scan.slots_read == scope.expected_slots,
            'SUMMARY_SCOPE_UNVERIFIED')
    iso_time(now)
    require(now.astimezone(JST).date() == days[0], 'SUMMARY_SCAN_DATE_CHANGED')
    require(all(0 <= (now - observed).total_seconds() <= 300 for _, observed in scan.observations)
            and 0 <= (now - scan.finished_at).total_seconds() <= 300, 'SUMMARY_DATA_STALE')


def matching_slots(scan, calendar, *, now):
    verify_scan(scan, now=now)
    observed = dict(scan.observations)
    matches = []
    for slot in scan.slots:
        if slot.status != 'AVAILABLE':
            continue
        decision = notification_eligibility(slot, calendar, now=now, observed_at=observed[slot.day])
        require(decision['notification_eligibility'] != 'DATA_INCOMPLETE', 'SUMMARY_ELIGIBILITY_UNVERIFIED')
        if decision['notification_eligibility'] == 'ELIGIBLE':
            matches.append(slot)
    return sorted(matches, key=lambda s: (s.day, s.start, s.court))


def summary_pages(scan, matches):
    observed = min(at for _, at in scan.observations)
    header = '\n'.join([TITLE, FACILITY,
        f'Đã kiểm tra ALL_BOOKABLE: {display_date(scan.observations[0][0].isoformat())} → '
        f'{display_date(scan.observations[-1][0].isoformat())}',
        f'Quan sát từ: {observed.astimezone(JST):%d/%m/%Y %H:%M:%S} JST',
        f'Hoàn tất: {scan.finished_at.astimezone(JST):%d/%m/%Y %H:%M:%S} JST',
        'Snapshot do admin yêu cầu; cần kiểm tra lại website trước khi đặt. Không đặt sân tự động.', ''])
    lines = [f'{display_date(s.day.isoformat())} · Sân {s.court} · {s.start}–{s.end}' for s in matches]
    if not lines:
        lines = ['Không tìm thấy sân phù hợp trong phạm vi vừa quét.']
    # Worst-case page digits reserve enough room; never truncate a slot.
    reserve = f'Trang {len(lines)}/{len(lines)} · {len(matches)} slot phù hợp\n\n'
    groups, current = [], []
    for line in lines:
        if text_units(header + reserve + '\n\n'.join(current + [line])) > MAX_TEXT_UNITS:
            require(bool(current), 'SUMMARY_TEXT_TOO_LONG')
            groups.append(current); current = []
        current.append(line)
    if current: groups.append(current)
    pages = [header + f'Trang {i}/{len(groups)} · {len(matches)} slot phù hợp\n\n' + '\n\n'.join(group)
             for i, group in enumerate(groups, 1)]
    require(all(text_units(p) <= MAX_TEXT_UNITS for p in pages), 'SUMMARY_TEXT_TOO_LONG')
    return pages


def run_summary(collector, telegram, destination, *, clock=lambda: datetime.now(JST)):
    result = {'kind':'ADMIN_CURRENT_AVAILABILITY_TEST_SUMMARY', 'status':'NOT_SENT',
              'scan_status':'NOT_RUN', 'sent':0, 'message_ids':[], 'd1_mutations':0,
              'execution_allowed':False, 'auto_booking_allowed':False}
    send_attempted = False
    try:
        destination = chat_id(destination)
        require(destination.startswith('-'), 'SUMMARY_TEST_GROUP_REQUIRED')
        started = clock()
        require(started.astimezone(JST).hour >= 7, 'SUMMARY_OUTSIDE_OPERATING_HOURS')
        scan = collector(started_at=started, clock=clock)
        result['scan_status'] = scan.read_status
        matches = matching_slots(scan, load_calendar(now=clock()), now=clock())
        pages = summary_pages(scan, matches)
        result.update(scan_status='COMPLETE', days=scan.days_read, cells=scan.slots_read,
                      matched_slots=len(matches), pages=len(pages),
                      observed_at=iso_time(min(at for _, at in scan.observations)),
                      window_start=scan.observations[0][0].isoformat(),
                      window_end=scan.observations[-1][0].isoformat())
        for page in pages:
            # Revalidate every observation before each send; do not resend on failure.
            require(matching_slots(scan, load_calendar(now=clock()), now=clock()) == matches,
                    'SUMMARY_ELIGIBILITY_CHANGED')
            send_attempted = True
            receipt = telegram.send_message(destination, page, [])
            if receipt.chat_id != destination:
                raise TelegramDeliveryError('TELEGRAM_INVALID_RESPONSE', True)
            result['message_ids'].append(receipt.message_id)
            result['sent'] += 1
        result['status'] = 'SENT'
    except ScanError as error:
        result.update(scan_status='PARTIAL' if error.days_read else 'FAILED', reason=error.code)
    except TelegramDeliveryError as error:
        result.update(status='UNCERTAIN' if error.ambiguous else 'FAILED', reason=error.code)
    except ValueError as error:
        safe = {'SUMMARY_SCAN_INCOMPLETE','SUMMARY_SCOPE_UNVERIFIED','SUMMARY_SCAN_DATE_CHANGED',
                'SUMMARY_DATA_STALE','SUMMARY_ELIGIBILITY_UNVERIFIED','SUMMARY_ELIGIBILITY_CHANGED',
                'SUMMARY_TEXT_TOO_LONG','SUMMARY_TEST_GROUP_REQUIRED','SUMMARY_OUTSIDE_OPERATING_HOURS'}
        result['reason'] = str(error) if str(error) in safe else 'SUMMARY_VALIDATION_FAILED'
        if result['sent']: result['status'] = 'FAILED'
    except Exception:
        result.update(status='UNCERTAIN' if send_attempted else 'NOT_SENT', reason='SUMMARY_STOPPED_NO_RETRY')
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--send-test-once',action='store_true')
    args=parser.parse_args()
    if not args.send_test_once or os.environ.get('TELEGRAM_DESTINATION') != 'TEST':
        report={'status':'NOT_SENT','reason':'SUMMARY_TEST_GROUP_REQUIRED',
                'execution_allowed':False,'auto_booking_allowed':False}
    else:
        from .collector import PublicCollector
        report=run_summary(PublicCollector(), TelegramBotAdapter(os.environ.get('TELEGRAM_BOT_TOKEN'),enabled=True),
                           os.environ.get('TELEGRAM_TEST_CHAT_ID',''))
    print(json.dumps(report,ensure_ascii=True))
    return 0 if report['status']=='SENT' else 2


if __name__=='__main__':
    raise SystemExit(main())
