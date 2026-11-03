import hashlib
import json
from pathlib import Path
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from unittest.mock import patch, MagicMock
from monitor.core import plan, key, render
from monitor.runtime import run_once
from monitor.shared.calendar import load_calendar
from monitor.shared.domain import JST, Slot, ScanError
from monitor.shared.scope import MonitoringScope, notification_eligibility
from monitor.shared.telegram import MockTelegramAdapter
from monitor.storage import D1Storage, StorageError
from .support import Worker, T0, scan, ROOT


class Integration(unittest.TestCase):
    def setUp(self):
        self.db = Worker()
        self.now = T0+timedelta(seconds=2)
        self.telegram = MockTelegramAdapter()

    def tearDown(self): self.db.close()

    def tick(self, available=None, *, baseline='QUIET', error=None, days=2):
        self.db.clock(self.now)
        def collector(**kwargs):
            if error: raise error
            return scan(self.now-timedelta(seconds=2), available=available, days=days)
        return run_once(self.db, collector, self.telegram, '-1001', clock=lambda:self.now,
                        baseline_mode=baseline)

    def snapshot(self):
        lease=self.db.call('acquire', {'owner':'11111111-1111-4111-8111-111111111111','destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')}
        state=self.db.call('snapshot',auth)
        self.db.call('release',auth)
        return state

    def advance(self, minutes=15): self.now += timedelta(minutes=minutes)

    def test_quiet_initial_no_restart_duplicate(self):
        self.assertEqual(self.tick()['sent'],0)
        a=self.snapshot();self.assertEqual(a['source']['baseline'],'QUIET');self.assertEqual(len(a['opportunities']),1)
        self.advance();self.assertEqual(self.tick()['sent'],0)
        b=self.snapshot();self.assertEqual(len(b['opportunities']),1)
        self.assertNotEqual(a['slots'][0]['observed_at'],b['slots'][0]['observed_at'])
        self.assertEqual(len(b['jobs']),0)
        self.assertEqual(a['stats']['transition_count'],b['stats']['transition_count'])
        self.db.restart()
        self.advance();self.assertEqual(self.tick(baseline='NOTIFY')['sent'],0)
        self.assertEqual(self.snapshot()['source']['baseline'],'QUIET')

    def test_notify_initial_replay_and_restart(self):
        self.assertEqual(self.tick(baseline='NOTIFY')['sent'],1)
        self.assertEqual(self.tick(baseline='NOTIFY')['sent'],0) # same observation, no new commit
        self.advance();self.assertEqual(self.tick()['sent'],0)
        state=self.snapshot();self.assertEqual(len(state['jobs']),1)
        self.assertEqual(state['jobs'][0]['status'],'SENT');self.assertEqual(state['members'][0]['delivery'],'SENT')

    def test_reserved_invalidation_edit_and_reopen(self):
        self.tick(baseline='NOTIFY');first=self.snapshot()['opportunities'][0]['id']
        self.advance();self.assertEqual(self.tick(available=set())['edited'],1)
        state=self.snapshot();self.assertEqual(state['opportunities'][0]['state'],'INVALIDATED')
        self.advance();self.assertEqual(self.tick()['sent'],1)
        state=self.snapshot();self.assertEqual(len(state['opportunities']),2)
        self.assertNotEqual(first,next(o['id'] for o in state['opportunities'] if o['state']=='ACTIVE'))

    def test_batch_one_invalidation_preserves_other_member(self):
        d=self.now.date();both={(d,'A','20:30'),(d,'B','20:30')}
        self.tick(both,baseline='NOTIFY');self.advance()
        self.assertEqual(self.tick({(d,'B','20:30')})['edited'],1)
        state=self.snapshot();self.assertEqual(len(state['members']),2)
        self.assertEqual(sum(o['state']=='ACTIVE' for o in state['opportunities']),1)
        edited=self.telegram.calls[-1]['payload'];self.assertEqual(edited['reply_markup'],{'inline_keyboard':[]})
        self.assertIn('còn AVAILABLE: 1',edited['text'])

    def test_partial_unknown_never_mutates_facts(self):
        self.tick(baseline='NOTIFY');before=self.snapshot()
        self.advance();r=self.tick(error=ScanError('UNKNOWN_STATUS',days_read=1,slots_read=14))
        self.assertEqual(r['status'],'PARTIAL');after=self.snapshot()
        self.assertEqual(before['slots'],after['slots']);self.assertEqual(before['opportunities'],after['opportunities'])
        self.assertEqual(len(self.telegram.calls),1);self.assertEqual(after['source']['last_error'],'UNKNOWN_STATUS')

    def test_complete_recovery_clears_error_without_resending(self):
        self.tick();self.advance();self.tick(error=ScanError('WEBSITE_UNAVAILABLE'));self.advance();self.tick()
        state=self.snapshot();self.assertIsNone(state['source']['last_error']);self.assertEqual(state['source']['last_status'],'COMPLETE')
        self.assertEqual(len(self.telegram.calls),0)

    def test_uncertain_send_is_not_blindly_retried(self):
        self.telegram.fail_next('sendMessage','TELEGRAM_DELIVERY_UNKNOWN',True)
        self.assertEqual(self.tick(baseline='NOTIFY')['status'],'PARTIAL')
        self.advance();self.tick();state=self.snapshot()
        self.assertEqual(state['jobs'][0]['status'],'UNCERTAIN');self.assertEqual(len(self.telegram.calls),1)

    def test_definite_send_failure_stays_failed_after_restart(self):
        self.telegram.fail_next('sendMessage','TELEGRAM_FORBIDDEN',False)
        self.assertEqual(self.tick(baseline='NOTIFY')['status'],'PARTIAL');self.advance()
        self.assertEqual(self.tick()['status'],'PARTIAL');self.assertEqual(len(self.telegram.calls),1)

    def test_edit_failure_does_not_change_website_facts(self):
        self.tick(baseline='NOTIFY');self.advance();self.telegram.fail_next('editMessageText','TELEGRAM_REJECTED',False)
        self.assertEqual(self.tick(set())['status'],'PARTIAL')
        state=self.snapshot();self.assertEqual(state['opportunities'][0]['state'],'INVALIDATED')
        self.assertIn('FAILED',{j['status'] for j in state['jobs']})

    def test_receipt_loss_after_telegram_success_becomes_uncertain(self):
        original=self.db.call
        def broken(command,payload):
            if command=='receipt': raise StorageError()
            return original(command,payload)
        with patch.object(self.db,'call',side_effect=broken):
            with self.assertRaises(StorageError): self.tick(baseline='NOTIFY')
        self.advance();r=self.tick();self.assertEqual(r['status'],'PARTIAL')
        self.assertEqual(self.snapshot()['jobs'][0]['status'],'UNCERTAIN');self.assertEqual(len(self.telegram.calls),1)

    def test_receipt_committed_but_response_lost_restart_does_not_resend(self):
        original=self.db.call
        def lost_response(command,payload):
            result=original(command,payload)
            if command=='receipt':raise StorageError()
            return result
        with patch.object(self.db,'call',side_effect=lost_response):
            with self.assertRaises(StorageError):self.tick(baseline='NOTIFY')
        self.db.restart();self.advance()
        self.assertEqual(self.tick()['sent'],0)
        self.assertEqual(self.snapshot()['jobs'][0]['status'],'SENT');self.assertEqual(len(self.telegram.calls),1)

    def test_process_restart_preserves_pending_claim_and_recovers_in_flight(self):
        self.tick();self.advance();self.tick(set());self.advance();self.db.clock(self.now)
        owner='11111111-1111-4111-8111-111111111111'
        lease=self.db.call('acquire',{'owner':owner,'destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')};s=self.db.call('snapshot',auth)
        p=plan(s,scan(self.now-timedelta(seconds=2)),load_calendar(now=self.now),now=self.now)
        self.db.call('commit',{**auth,**p});self.db.call('release',auth)
        self.db.restart()
        lease=self.db.call('acquire',{'owner':owner,'destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')}
        state=self.db.call('snapshot',auth);self.assertEqual(state['jobs'][0]['status'],'PENDING')
        self.assertIsNotNone(self.db.call('claim',{**auth,'job_id':p['jobs'][0]['id']})['job'])
        # A real process exit without release, followed by server-clock expiry.
        self.db.restart();self.advance(minutes=13);self.db.clock(self.now)
        successor=self.db.call('acquire',{'owner':'22222222-2222-4222-8222-222222222222','destination':'-1001'})
        other={k:successor[k] for k in ('owner','fence')}
        self.assertEqual(self.db.call('snapshot',other)['jobs'][0]['status'],'UNCERTAIN')
        with self.assertRaises(StorageError):self.db.call('receipt',{**auth,'job_id':p['jobs'][0]['id'],'status':'SENT','message_id':99,'error_code':None})
        self.db.call('release',other)

    def test_fixture_backend_identity_integrity_and_foreign_keys(self):
        import os
        expected='D1_LOCAL_WORKERD' if os.environ.get('MONITOR_TEST_STORAGE')=='workerd' else 'SQLITE_SHIM'
        self.assertEqual(self.db.backend,expected)
        self.tick();self.assertEqual(self.db.integrity(),{'foreign_key_errors':0,'integrity_ok':True})

    def test_concurrent_claim_only_one_winner_and_crash_recovery(self):
        self.tick();self.advance();self.tick(set());self.advance();self.db.clock(self.now)
        # Prepare without dispatch, then claim twice through the same actual API.
        lease=self.db.call('acquire',{'owner':'11111111-1111-4111-8111-111111111111','destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')};s=self.db.call('snapshot',auth)
        p=plan(s,scan(self.now-timedelta(seconds=2)),load_calendar(now=self.now),now=self.now)
        self.db.call('commit',{**auth,**p});jid=p['jobs'][0]['id']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.db.call('claim',{**auth,'job_id':jid}),range(2)))
        self.assertEqual(sum(r['job'] is not None for r in results),1)
        self.assertIsNone(self.db.call('claim',{**auth,'job_id':jid})['job'])
        self.db.call('release',auth)
        self.advance();self.tick();self.assertEqual(self.snapshot()['jobs'][0]['status'],'UNCERTAIN')

    def test_stale_revision_and_invalid_plan_roll_back(self):
        self.tick();self.advance();lease=self.db.call('acquire',{'owner':'11111111-1111-4111-8111-111111111111','destination':'-1001'})
        auth={k:lease[k] for k in ('owner','fence')};s=self.db.call('snapshot',auth)
        p=plan(s,scan(self.now-timedelta(seconds=2)),load_calendar(now=self.now),now=self.now)
        p['expected_revision']-=1
        with self.assertRaises(StorageError):self.db.call('commit',{**auth,**p})
        after=self.db.call('snapshot',auth);self.assertEqual(after['slots'],s['slots'])
        p['expected_revision']+=1;p['slots'].pop()
        with self.assertRaises(StorageError):self.db.call('commit',{**auth,**p})
        self.db.call('release',auth)

    def test_stale_lease_and_receipt_cannot_overwrite_successor(self):
        self.tick();a=self.db.call('acquire',{'owner':'11111111-1111-4111-8111-111111111111','destination':'-1001'})
        auth={k:a[k] for k in ('owner','fence')}
        self.db.clock(self.now+timedelta(minutes=13))
        b=self.db.call('acquire',{'owner':'22222222-2222-4222-8222-222222222222','destination':'-1001'})
        with self.assertRaises(StorageError):self.db.call('snapshot',auth)
        with self.assertRaises(StorageError):self.db.call('receipt',{**auth,'job_id':'a'*32,'status':'SENT','message_id':1,'error_code':None})
        self.db.call('release',{k:b[k] for k in ('owner','fence')})

    def test_pending_before_claim_can_resume_but_expired_slot_cannot_send(self):
        self.tick();self.advance();self.tick(set());self.advance();self.db.clock(self.now)
        a=self.db.call('acquire',{'owner':'11111111-1111-4111-8111-111111111111','destination':'-1001'})
        auth={k:a[k] for k in ('owner','fence')};s=self.db.call('snapshot',auth)
        p=plan(s,scan(self.now-timedelta(seconds=2)),load_calendar(now=self.now),now=self.now)
        self.db.call('commit',{**auth,**p});self.db.call('release',auth)
        self.advance();self.assertEqual(self.tick()['sent'],1)
        self.now=self.now.replace(hour=21)
        self.assertEqual(self.tick()['sent'],0)
        self.assertEqual(self.snapshot()['opportunities'][-1]['state'],'EXPIRED')

    def test_roll_forward_preserves_identity_and_marks_expiry_not_reserved(self):
        self.tick(baseline='NOTIFY');a=self.snapshot();self.now+=timedelta(days=1);self.tick()
        b=self.snapshot();old=next(o for o in b['opportunities'] if o['id']==a['opportunities'][0]['id'])
        self.assertEqual(old['state'],'EXPIRED');self.assertEqual(old['reason'],'OUT_OF_SCOPE')
        oldslot=next(s for s in b['slots'] if s['id']==old['slot_id']);self.assertEqual(oldslot['status'],'AVAILABLE');self.assertEqual(oldslot['in_scope'],0)

    def test_unverified_holidays_report_incomplete_without_inventing_opportunities(self):
        from monitor.shared.domain import HolidayCalendar
        self.now+=timedelta(days=2) # Monday, needs verified holiday classification
        with patch('monitor.runtime.load_calendar',return_value=HolidayCalendar()):
            result=self.tick()
        self.assertEqual(result['status'],'PARTIAL');self.assertEqual(result['eligibility_status'],'DATA_INCOMPLETE')
        self.assertEqual(result['sent'],0);self.assertEqual(len(self.snapshot()['opportunities']),0)

    def test_batch_chunking_all_members_persisted(self):
        rows=scan(days=10).slots;available={(s.day,s.court,s.start) for s in rows}
        r=self.tick(available,baseline='NOTIFY',days=10);self.assertLessEqual(r['sent'],2)
        state=self.snapshot();self.assertGreater(len(state['members']),24)
        self.assertEqual(len({m['opportunity_id'] for m in state['members']}),len(state['members']))
        self.assertTrue(all(len(j['text'])<=4096 for j in state['jobs']))


class PureAndPorts(unittest.TestCase):
    def test_exported_core_provenance_and_no_imports_from_windows(self):
        manifest=json.loads((ROOT/'CORE_PROVENANCE.json').read_text())
        for name,digest in manifest['outputs'].items():
            self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),digest)
        for file in (ROOT/'monitor').rglob('*.py'):
            self.assertNotIn('from poc03',file.read_text(encoding='utf-8'))

    def test_weekday_weekend_holiday_and_calendar_gap(self):
        calendar=load_calendar(now=T0)
        for d,start,expected in [(date(2026,11,2),'16:00',False),(date(2026,11,2),'20:30',True),
                                 (date(2026,11,3),'16:00',True),(date(2026,11,1),'18:30',True),
                                 (date(2028,1,3),'20:30',False)]:
            end={'16:00':'18:00','18:30':'20:30','20:30':'22:30'}[start]
            r=notification_eligibility(Slot(d,'A',start,end),calendar,now=T0,observed_at=T0)
            self.assertEqual(r['notification_eligibility']=='ELIGIBLE',expected)
            self.assertFalse(r['execution_allowed']);self.assertFalse(r['auto_booking_allowed'])

    def test_calendar_boundaries_and_missing_day_fail_safe(self):
        for d in [date(2026,2,28),date(2028,2,29),date(2026,4,30)]:
            with self.assertRaises(ValueError):MonitoringScope().resolve(anchor=d)
        self.assertEqual(MonitoringScope().resolve(anchor=date(2026,10,31)).expected_slots,434)
        self.assertEqual(MonitoringScope().resolve(anchor=date(2026,12,31)).end_date,date(2027,1,31))

    def test_storage_rejects_redirect_hosts_and_sanitizes_error(self):
        for url in ['http://storage.test','https://user:secret@storage.test','https://storage.test/?token=x']:
            with self.assertRaises(StorageError):D1Storage(url,'a'*32)
        def bad(*args):raise RuntimeError('RAW_TOKEN_SHOULD_NEVER_ESCAPE')
        db=D1Storage('https://storage.test','a'*32,transport=bad)
        with self.assertRaisesRegex(StorageError,'^STORAGE_UNAVAILABLE$'):db.call('snapshot',{})
        with self.assertRaises(StorageError):db.call('sql',{})

    def test_headless_context_and_browser_close_on_error(self):
        from monitor.collector import PublicCollector
        with patch.dict('os.environ',{'DEBUG':'','PWDEBUG':''}):
            for failed in [False,True]:
                factory=MagicMock();pw=factory.return_value.__enter__.return_value
                browser=pw.chromium.launch.return_value;context=browser.new_context.return_value
                with patch('monitor.collector.collect_scope_pages',side_effect=ScanError('READ_ERROR') if failed else None,return_value=scan()):
                    try:PublicCollector(playwright_factory=factory)(started_at=T0,clock=lambda:T0)
                    except ScanError:pass
                pw.chromium.launch.assert_called_once_with(headless=True)
                context.close.assert_called_once();browser.close.assert_called_once()

    def test_storage_identifies_application_without_weakening_authorization(self):
        opener=MagicMock()
        opener.open.return_value.read.return_value=b'{"ok":true}'
        with patch('monitor.storage.build_opener',return_value=opener):
            self.assertTrue(D1Storage('https://storage.test','a'*32).call('snapshot',{})['ok'])
        request=opener.open.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'),'BotDatSan-Monitor/1.0')
        self.assertEqual(request.get_header('Authorization'),'Bearer '+'a'*32)
        self.assertEqual(request.get_method(),'POST')
        self.assertEqual(request.full_url,'https://storage.test/v1/snapshot')

    def test_outside_operating_hours_does_not_touch_any_adapter(self):
        storage=MagicMock();collector=MagicMock();telegram=MagicMock()
        r=run_once(storage,collector,telegram,'-1001',clock=lambda:T0.replace(hour=6))
        self.assertEqual(r['status'],'NOT_RUN');storage.call.assert_not_called();collector.assert_not_called()

    def test_cli_safe_exit_codes_and_config_fail_closed(self):
        import io
        from monitor.runtime import main
        with patch('monitor.runtime.Path.read_text',side_effect=ValueError('PRIVATE_DATA')):
            with self.assertRaisesRegex(StorageError,'INVALID_CONFIGURATION'):
                run_once(MagicMock(),MagicMock(),MagicMock(),'-1001',clock=lambda:T0)
        with patch('sys.argv',['monitor.runtime','--enable-test-delivery']),patch.dict('os.environ',{'TELEGRAM_DESTINATION':'TEST'}),patch('monitor.runtime.D1Storage',side_effect=StorageError('SOURCE_BUSY')),patch('sys.stdout',new_callable=io.StringIO) as out:
            self.assertEqual(main(),2)
            self.assertEqual(json.loads(out.getvalue())['reason'],'SOURCE_BUSY')


if __name__=='__main__':unittest.main()
