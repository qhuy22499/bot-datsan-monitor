from datetime import datetime,timezone
import os,unittest
from unittest.mock import patch
from booking.runtime import weekly_candidate,send_weekly,main

class WeeklyRuntime(unittest.TestCase):
    def test_sunday_utc_monday_jst_and_other_days_manual_sheets_only(self):
        monday=datetime.fromisoformat('2026-11-09T08:35:00+09:00');at=datetime.fromisoformat('2026-11-09T08:30:00+09:00')
        trigger='cfbooking-'+str(int(at.timestamp()*1000));sig='a'*64
        self.assertEqual(at.astimezone(timezone.utc).weekday(),6)
        self.assertTrue(weekly_candidate(trigger,sig,now=monday))
        self.assertFalse(weekly_candidate(trigger,sig,now=monday,sheets_only=True))
        self.assertFalse(weekly_candidate(trigger,'',now=monday))
        self.assertFalse(weekly_candidate('manual-1',sig,now=monday))
        for days in range(1,7):
            from datetime import timedelta
            other=at+timedelta(days=days)
            self.assertFalse(weekly_candidate('cfbooking-'+str(int(other.timestamp()*1000)),sig,now=other))
    def test_manual_does_not_call_weekly_network(self):
        class NoNetwork:
            def open(self,*a,**kw):raise AssertionError('NO_SEND')
        self.assertEqual(send_weekly('manual-1',{'status':'FAILED'},opener=NoNetwork())['status'],'SKIPPED')
    def test_sheets_only_does_not_enter_weekly_path(self):
        with patch.dict(os.environ,{'BOOKING_SHEETS_ONLY':'true'}),patch('booking.runtime.sync_booked',return_value={'status':'SKIPPED'}),patch('booking.runtime.send_weekly',side_effect=AssertionError('NO_WEEKLY')),patch('builtins.print'):
            self.assertEqual(main(),0)
    def test_proof_read_from_event_not_step_env_and_fixed_authenticated_payload(self):
        import io,json,tempfile
        from pathlib import Path
        class Opener:
            def open(self,request,timeout):
                self.request=request
                return io.BytesIO(b'{"status":"SENT","messageId":88}')
        opener=Opener()
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'event.json';path.write_text(json.dumps({'inputs':{'trigger_signature':'a'*64}}),encoding='utf-8')
            with patch.dict(os.environ,{'GITHUB_EVENT_PATH':str(path),'BOOKED_SYNC_SECRET':'offline_test_only_weekly_auth'}),patch('booking.runtime.weekly_candidate',return_value=True):
                out=send_weekly('cfbooking-1234567890000',{'status':'FAILED'},opener=opener)
        self.assertEqual(out['status'],'SENT')
        payload=json.loads(opener.request.data)
        self.assertEqual(set(payload),{'trigger_id','signature','sheets_status'})
        self.assertEqual(payload['signature'],'a'*64);self.assertEqual(payload['sheets_status'],'FAILED')
        self.assertTrue(opener.request.full_url.endswith('/booked/weekly'))

if __name__=='__main__':unittest.main()
