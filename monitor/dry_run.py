"""Offline smoke of actual Worker code + SQLite shim, not Cloud LIVE evidence."""
from datetime import timedelta
from .runtime import run_once
from .shared.telegram import MockTelegramAdapter


def run():
    from tests.support import Worker, T0, scan
    storage=Worker();telegram=MockTelegramAdapter();now=T0+timedelta(seconds=2)
    try:
        storage.clock(now)
        first=run_once(storage,lambda **_:scan(),telegram,'-1001',clock=lambda:now,baseline_mode='NOTIFY')
        storage.restart()
        now+=timedelta(minutes=15);storage.clock(now)
        second=run_once(storage,lambda **_:scan(now-timedelta(seconds=2)),telegram,'-1001',clock=lambda:now)
        return {'status':'COMPLETE' if first['sent']==1 and second['sent']==0 else 'FAILED',
                'evidence':'OFFLINE_'+storage.backend+'_MOCK_TELEGRAM','cycles':2,
                'first_sent':first['sent'],'restart_sent':second['sent'],
                'execution_allowed':False,'auto_booking_allowed':False}
    finally:storage.close()
