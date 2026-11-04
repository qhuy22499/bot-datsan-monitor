import ast
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from monitor.core import plan
from monitor.display import display_date
from monitor.shared.calendar import load_calendar
from monitor.shared.domain import JST, ScanError, ScanResult, Slot
from monitor.shared.scope import MonitoringScope
from monitor.shared.telegram import MockTelegramAdapter, TelegramDeliveryError
from monitor.test_summary import run_summary, matching_slots, summary_pages, text_units, verify_scan
from .support import scan

ROOT=Path(__file__).resolve().parents[1]


class SummaryDisplay(unittest.TestCase):
    def setUp(self):
        self.now=datetime(2026,11,16,8,tzinfo=JST)
        self.telegram=MockTelegramAdapter()

    def fixture(self, *, available=None, at=None):
        at=at or self.now-timedelta(seconds=2)
        scope=MonitoringScope().resolve(anchor=at.date())
        return replace(scan(at,available=available,days=scope.expected_days),boundary_source=scope.boundary_source)

    def run_fixture(self, fixture, **kwargs):
        return run_summary(lambda **_:fixture,self.telegram,'-1001',clock=lambda:self.now,**kwargs)

    def test_all_weekdays_month_year_and_leap_dates(self):
        for n,weekday in enumerate(('T2','T3','T4','T5','T6','T7','CN')):
            day=self.now.date()+timedelta(days=n)
            self.assertEqual(display_date(day.isoformat()),f'{weekday} {day:%d/%m/%Y}')
        for iso,expected in [('2026-11-07','T7 07/11/2026'),('2026-11-08','CN 08/11/2026'),
                             ('2026-12-31','T5 31/12/2026'),('2027-01-01','T6 01/01/2027'),
                             ('2024-02-29','T5 29/02/2024'),('2024-03-01','T6 01/03/2024')]:
            self.assertEqual(display_date(iso),expected)
        with self.assertRaises(ValueError):display_date('2026-02-29')

    def test_send_and_edit_share_display_without_mutating_iso_data(self):
        initial={'source':{'revision':0,'baseline':None},'slots':[],'opportunities':[],
                 'batches':[],'members':[],'jobs':[]}
        original=deepcopy(initial);fixture=self.fixture()
        first=plan(initial,fixture,load_calendar(now=self.now),now=self.now,baseline_mode='NOTIFY')
        self.assertEqual(initial,original)
        self.assertEqual(first['jobs'][0]['kind'],'SEND')
        self.assertIn('T2 16/11/2026 · sân A · 20:30–22:30',first['jobs'][0]['text'])
        self.assertTrue(all(s['day'].startswith(('2026-','2027-')) for s in first['slots']))
        snapshot={k:deepcopy(first[k]) for k in ('slots','opportunities','batches','members')}
        snapshot['source']={'revision':1,'baseline':'NOTIFY'}
        snapshot['jobs']=[{**first['jobs'][0],'status':'SENT'}]
        snapshot['batches'][0]['message_id']=17
        self.now+=timedelta(minutes=15)
        second=plan(snapshot,self.fixture(available=set()),load_calendar(now=self.now),now=self.now)
        self.assertEqual(second['jobs'][0]['kind'],'EDIT')
        self.assertIn('T2 16/11/2026 · sân A · 20:30–22:30',second['jobs'][0]['text'])
        self.assertIn('không còn AVAILABLE',second['jobs'][0]['text'])

    def test_weekday_weekend_holiday_filter_and_chronological_court_sort(self):
        from datetime import date
        candidates={(date(2026,11,16),'A','16:00'),(date(2026,11,16),'B','20:30'),
                    (date(2026,11,21),'A','16:00'),(date(2026,11,21),'B','16:00'),
                    (date(2026,11,22),'B','18:30'),(date(2026,11,23),'A','16:00')}
        result=self.run_fixture(self.fixture(available=candidates))
        self.assertEqual((result['status'],result['matched_slots']),('SENT',5))
        text=self.telegram.calls[0]['payload']['text']
        self.assertNotIn('T2 16/11/2026 · Sân A · 16:00',text)
        self.assertIn('T2 23/11/2026 · Sân A · 16:00',text)
        self.assertLess(text.index('T7 21/11/2026 · Sân A'),text.index('T7 21/11/2026 · Sân B'))
        self.assertIn('[TEST — DANH SÁCH SÂN TRỐNG HIỆN TẠI]',text)
        self.assertIn('cần kiểm tra lại website trước khi đặt',text)
        self.assertFalse(result['execution_allowed']);self.assertFalse(result['auto_booking_allowed'])

    def test_complete_empty_scan_sends_one_explicit_empty_message(self):
        result=self.run_fixture(self.fixture(available=set()))
        self.assertEqual((result['status'],result['sent'],result['matched_slots']),('SENT',1,0))
        self.assertIn('Không tìm thấy sân phù hợp',self.telegram.calls[0]['payload']['text'])

    def test_partial_failed_unknown_and_collector_error_never_send(self):
        for status in ('PARTIAL','FAILED'):
            fixture=ScanResult(self.now,self.now,status,'SOURCE_INCOMPLETE')
            self.assertEqual(self.run_fixture(fixture)['status'],'NOT_SENT')
        for code in ('UNKNOWN_STATUS','READ_ERROR','TIMEOUT','WEBSITE_UNAVAILABLE'):
            collector=Mock(side_effect=ScanError(code,days_read=1,slots_read=14))
            result=run_summary(collector,self.telegram,'-1001',clock=lambda:self.now)
            self.assertEqual((result['status'],result['reason']),('NOT_SENT',code))
            collector.assert_called_once()
        self.assertEqual(self.telegram.calls,[])

    def test_fixed_scope_or_short_all_bookable_range_never_send(self):
        fixture=self.fixture()
        for bad in (replace(fixture,scope_mode='FIXED_DAYS'),scan(self.now-timedelta(seconds=2),days=2)):
            self.assertEqual(self.run_fixture(bad)['status'],'NOT_SENT')
        self.assertEqual(self.telegram.calls,[])

    def test_oldest_observation_300_seconds_ok_301_or_future_rejected(self):
        fixture=self.fixture(at=self.now-timedelta(seconds=301)) # observations exactly 300 s old
        verify_scan(fixture,now=self.now)
        for now in (self.now+timedelta(seconds=1),fixture.started_at-timedelta(seconds=1)):
            with self.assertRaises(ValueError):verify_scan(fixture,now=now)
        stale=self.fixture(at=self.now-timedelta(seconds=302))
        self.assertEqual(self.run_fixture(stale)['reason'],'SUMMARY_DATA_STALE')
        self.assertEqual(self.telegram.calls,[])

    def test_midnight_change_and_missing_calendar_block_send(self):
        with self.assertRaises(ValueError):verify_scan(self.fixture(),now=self.now+timedelta(days=1))
        from monitor.shared.domain import HolidayCalendar
        with patch('monitor.test_summary.load_calendar',return_value=HolidayCalendar()):
            self.assertEqual(self.run_fixture(self.fixture())['reason'],'SUMMARY_ELIGIBILITY_UNVERIFIED')
        self.assertEqual(self.telegram.calls,[])

    def test_event_reserved_and_started_slots_excluded(self):
        fixture=self.fixture()
        rows=tuple(replace(s,status='EVENT_RESERVED') if s.status=='AVAILABLE' else s for s in fixture.slots)
        self.assertEqual(self.run_fixture(replace(fixture,slots=rows))['matched_slots'],0)
        self.now=self.now.replace(hour=21)
        result=self.run_fixture(self.fixture())
        self.assertEqual(result['matched_slots'],0)

    def test_pagination_preserves_every_slot_with_utf16_budget(self):
        fixture=self.fixture()
        all_available=replace(fixture,slots=tuple(replace(s,status='AVAILABLE') for s in fixture.slots))
        matches=matching_slots(all_available,load_calendar(now=self.now),now=self.now)
        pages=summary_pages(all_available,matches)
        self.assertGreater(len(pages),1)
        self.assertTrue(all(text_units(p)<=3900 for p in pages))
        for i,p in enumerate(pages,1):self.assertIn(f'Trang {i}/{len(pages)}',p)
        for s in matches:
            line=f'{display_date(s.day.isoformat())} · Sân {s.court} · {s.start}–{s.end}'
            self.assertEqual(sum(p.count(line) for p in pages),1)

    def test_telegram_failure_and_uncertain_are_not_retried(self):
        for ambiguous in (False,True):
            adapter=MockTelegramAdapter();adapter.fail_next('sendMessage','TELEGRAM_DELIVERY_UNKNOWN' if ambiguous else 'TELEGRAM_FORBIDDEN',ambiguous)
            result=run_summary(lambda **_:self.fixture(),adapter,'-1001',clock=lambda:self.now)
            self.assertEqual(result['status'],'UNCERTAIN' if ambiguous else 'FAILED')
            self.assertEqual(len(adapter.calls),1)
        adapter=Mock();adapter.send_message.side_effect=RuntimeError('sensitive raw response')
        result=run_summary(lambda **_:self.fixture(),adapter,'-1001',clock=lambda:self.now)
        self.assertEqual(result['status'],'UNCERTAIN');adapter.send_message.assert_called_once()
        self.assertNotIn('sensitive',str(result))

    def test_age_is_checked_again_before_send(self):
        with patch('monitor.test_summary.summary_pages',wraps=summary_pages) as pages:
            pages.side_effect=lambda *a:(setattr(self,'now',self.now+timedelta(minutes=6)) or summary_pages(*a))
            self.assertEqual(self.run_fixture(self.fixture())['reason'],'SUMMARY_DATA_STALE')
        self.assertEqual(self.telegram.calls,[])

    def test_no_storage_dependency_secret_or_mutation_path_and_same_concurrency(self):
        tree=ast.parse((ROOT/'monitor/test_summary.py').read_text(encoding='utf-8'))
        modules=[n.module or '' for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)]
        self.assertFalse(any(m in ('storage','core','runtime','sqlite3') for m in modules))
        self.assertFalse(any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)
                             and n.func.attr in ('execute','executemany','call','connect') for n in ast.walk(tree)))
        wf=(ROOT/'.github/workflows/availability-summary-test.yml').read_text(encoding='utf-8')
        import re
        self.assertEqual(set(re.findall(r'secrets\.([A-Z_]+)',wf)),{'TELEGRAM_BOT_TOKEN','TELEGRAM_TEST_CHAT_ID'})
        self.assertNotIn('schedule:',wf);self.assertIn('github.run_attempt == 1',wf)
        self.assertIn('group: katsushika-public-monitor-test\n  cancel-in-progress: false',wf)
        self.assertEqual(self.run_fixture(self.fixture())['d1_mutations'],0)


if __name__=='__main__':unittest.main()
