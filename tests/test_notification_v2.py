from copy import deepcopy
from datetime import date, timedelta
from unittest.mock import patch
import unittest
from monitor.core import plan
from monitor.runtime import run_once
from monitor.notifications_v2 import pages, current_slots, units, line
from monitor.shared.calendar import load_calendar
from monitor.shared.domain import Slot, ScanError, HolidayCalendar
from monitor.shared.telegram import MockTelegramAdapter
from monitor.storage import StorageError
from . import test_deployment as legacy
from .support import T0, scan

class NotificationV2(unittest.TestCase):
    setUp = legacy.Integration.setUp
    tearDown = legacy.Integration.tearDown
    advance = legacy.Integration.advance
    snapshot = legacy.Integration.snapshot

    def test_scope_roll_forward_does_not_report_reserved(self):
        self.tick(baseline='NOTIFY')
        self.now += timedelta(days=1)
        result = self.tick(set())
        self.assertEqual((result['sent'],result['edited']),(0,0))
        old = self.snapshot()['opportunities'][0]
        self.assertEqual(old['reason'],'OUT_OF_SCOPE')

    def test_receipt_loss_keeps_uncertain_and_never_resends_after_restart(self):
        self.tick();self.advance()
        original = self.db.call
        def lost(command,payload):
            if command == 'receipt':raise StorageError()
            return original(command,payload)
        with patch.object(self.db,'call',side_effect=lost), self.assertRaises(StorageError):
            self.tick(set())
        self.db.restart();self.advance();self.tick(set())
        self.assertEqual(len(self.telegram.calls),1)
        self.assertIn('UNCERTAIN',{j['status'] for j in self.snapshot()['jobs']})

    def test_cutover_retires_only_legacy_pending_and_prevents_downgrade(self):
        legacy.Integration.tick(self,available=set());self.advance();self.db.clock(self.now)
        owner='11111111-1111-4111-8111-111111111111'
        lease=self.db.call('acquire',{'owner':owner,'destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')}
        state=self.db.call('snapshot',auth)
        prepared=plan(state,scan(self.now-timedelta(seconds=2)),load_calendar(now=self.now),now=self.now)
        self.db.call('commit',{**auth,**prepared});self.db.call('release',auth)
        self.advance();self.tick()
        state=self.snapshot();self.assertEqual(state['jobs'][0]['status'],'CANCELLED')
        self.assertEqual(len(self.telegram.calls),0)
        lease=self.db.call('acquire',{'owner':owner,'destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')}
        prepared=plan(self.db.call('snapshot',auth),scan(self.now-timedelta(seconds=1)),load_calendar(now=self.now),now=self.now)
        with self.assertRaises(StorageError):self.db.call('commit',{**auth,**prepared})
        self.db.call('release',auth)

    def tick(self, available=None, *, baseline='QUIET', error=None, days=2):
        self.db.clock(self.now)

        def collect(**_):
            if error:
                raise error
            return scan(self.now - timedelta(seconds=2), available=available, days=days)
        return run_once(self.db, collect, self.telegram, '-1001', clock=lambda: self.now, baseline_mode=baseline, notification_version=2, max_sends=128)

    def test_removal_from_quiet_baseline(self):
        self.tick()
        self.advance()
        result = self.tick(set())
        self.assertEqual((result['sent'], result['edited']), (1, 0))
        text = self.telegram.calls[-1]['payload']['text']
        self.assertIn('🔴 Vừa hết trống (1)', text)
        self.assertIn('Hiện không còn sân trống ưu tiên.', text)
        self.assertNotIn('batch', text.lower())
        self.assertNotIn('revision', text)
        self.assertEqual(self.snapshot()['opportunities'][0]['state'], 'INVALIDATED')

    def test_mixed_and_reopen(self):
        day = self.now.date()
        a = (day, 'A', '20:30')
        b = (day, 'B', '20:30')
        self.tick({a})
        first = self.snapshot()['opportunities'][0]['id']
        self.advance()
        result = self.tick({b})
        self.assertEqual((result['sent'], result['edited']), (1, 0))
        text = self.telegram.calls[-1]['payload']['text']
        self.assertIn('🟢 Vừa xuất hiện (1)', text)
        self.assertIn('🔴 Vừa hết trống (1)', text)
        current = text.split('⭐ SÂN ƯU TIÊN HIỆN TẠI', 1)[1]
        self.assertIn('Sân B', current)
        self.assertNotIn('Sân A', current)
        self.assertIn('🆕', current)
        self.advance()
        self.tick({a, b})
        active = [o for o in self.snapshot()['opportunities'] if o['state'] == 'ACTIVE' and o['slot_id'].split(':')[1] == 'A']
        self.assertEqual(active[0]['origin'], 'REOPENED')
        self.assertNotEqual(active[0]['id'], first)

    def test_no_change_failures_expiry_and_scope(self):
        self.tick(baseline='NOTIFY')
        self.advance()
        self.assertEqual(self.tick()['sent'], 0)
        for code in ['WEBSITE_UNAVAILABLE', 'UNKNOWN_STATUS', 'TIMEOUT']:
            self.advance()
            self.tick(error=ScanError(code, days_read=1, slots_read=14))
        self.assertEqual(len(self.telegram.calls), 1)
        self.now = self.now.replace(hour=21)
        self.assertEqual(self.tick(set())['sent'], 0)
        self.now += timedelta(days=1)
        self.assertEqual(self.tick(set())['sent'], 0)
        self.assertEqual(len(self.telegram.calls), 1)

    def test_cutover_no_history_replay(self):
        legacy.Integration.tick(self, baseline='NOTIFY')
        self.advance()
        legacy.Integration.tick(self, set())
        self.assertEqual(len(self.telegram.calls), 2)
        self.advance()
        self.db.restart()
        self.assertEqual(self.tick(set())['sent'], 0)
        self.assertEqual(len(self.telegram.calls), 2)
        state = self.snapshot()
        self.assertEqual(state['source']['notification_version'], 2)
        self.assertEqual(len(state['jobs']), 2)
        self.advance()
        self.assertEqual(self.tick()['sent'], 1)

    def test_uncertain_restart(self):
        self.tick()
        self.advance()
        self.telegram.fail_next('sendMessage', 'TELEGRAM_DELIVERY_UNKNOWN', True)
        self.assertEqual(self.tick(set())['status'], 'PARTIAL')
        self.db.restart()
        self.advance()
        self.tick(set())
        self.assertEqual(len(self.telegram.calls), 1)
        self.assertIn('UNCERTAIN', {j['status'] for j in self.snapshot()['jobs']})

    def test_duplicate_scan(self):
        self.tick()
        self.advance()
        self.tick(set())
        self.db.restart()
        result = self.tick(set())
        self.assertEqual(len(self.telegram.calls), 1)
        self.assertEqual(result['sent'], 0)
        self.assertFalse(result['execution_allowed'])
        self.assertFalse(result['auto_booking_allowed'])
        self.assertEqual(self.db.integrity(), {'foreign_key_errors': 0, 'integrity_ok': True})

class MessageV2(unittest.TestCase):

    def test_weekend_holiday_sort_warning_and_scan_time(self):
        at = T0
        fixture = scan(at, days=25, available=set())
        chosen = [Slot(date(2026, 11, 2), 'A', '20:30', '22:30'), Slot(date(2026, 11, 3), 'A', '16:00', '18:00'), Slot(date(2026, 11, 1), 'B', '18:30', '20:30'), Slot(date(2026, 11, 1), 'A', '20:30', '22:30')]
        from dataclasses import replace
        fixture = scan(at, days=25, available={(s.day,s.court,s.start) for s in chosen})
        current = current_slots(fixture, load_calendar(now=at), at)
        text = pages([('new', chosen[0])], current, at)[0][1]
        for value in ['Ưu tiên 1', 'Ưu tiên 2', 'Chỉ thông báo', '31/10/2026 08:00 JST', 'T2 02/11/2026']:
            self.assertIn(value, text)
        unknown = current_slots(fixture, HolidayCalendar(), at)
        self.assertIn('cần xác minh lịch lễ', pages([('lost', chosen[0])], unknown, at)[0][1])

    def test_long_changes_are_all_preserved_and_current_list_explicitly_shortened(self):
        rows = [Slot(T0.date() + timedelta(days=n), 'A', '20:30', '22:30') for n in range(150)]
        changes = [('new' if n % 2 else 'lost', s) for n, s in enumerate(rows)]
        result = pages(changes, [(s, 'Ưu tiên 1') for s in rows], T0)
        self.assertGreater(len(result), 1)
        self.assertEqual([c for chunk, _ in result for c in chunk], changes)
        for _, text in result:
            self.assertLessEqual(units(text), 4096)
            self.assertIn('Google Sheets:', text)
            self.assertIn('khung giờ trong danh sách', text)

    def test_later_plan_uses_current_scan_not_old_opportunity_or_batch_text(self):
        from dataclasses import replace
        old = {'source': {'revision': 0, 'baseline': None}, 'slots': [], 'opportunities': [], 'batches': [], 'members': [], 'jobs': []}
        first = plan(old, scan(), load_calendar(now=T0), now=T0 + timedelta(seconds=2), notification_version=2)
        snapshot = {k: deepcopy(first[k]) for k in ['slots', 'opportunities', 'batches', 'members']}
        snapshot.update(source={'revision': 1, 'baseline': 'QUIET'}, jobs=[])
        later = T0 + timedelta(minutes=15)
        changed = plan(snapshot, scan(later, available=set()), load_calendar(now=later), now=later + timedelta(seconds=2), notification_version=2)
        self.assertEqual(len(changed['jobs']), 1)
        self.assertIn('08:15 JST', changed['jobs'][0]['text'])
        self.assertIn('Hiện không còn sân trống ưu tiên.', changed['jobs'][0]['text'])
