"""Bounded READ_ONLY group synchronization. No artifacts/trace/session exports."""
import json
import os
import sys
import uuid
from urllib.request import Request, build_opener
from monitor.storage import D1Storage, NoRedirect
from .collector import collect, credentials_from_env, stamp, result

class BookingStorage(D1Storage):
    COMMANDS=frozenset({'booking_acquire','booking_begin','booking_result','booking_snapshot','booking_release'})

def main():
    report={'kind':'BOOKING_SYNC','execution_allowed':False,'auto_booking_allowed':False,'groups':{}}
    storage=BookingStorage(os.environ.get('MONITOR_API_URL',''),os.environ.get('MONITOR_API_SECRET',''))
    owner=str(uuid.uuid4());lease=storage.call('booking_acquire',{'owner':owner})
    fence={'owner':owner,'fence':lease['fence']}
    run=os.environ.get('BOOKING_TRIGGER_ID') or 'manual-'+os.environ.get('GITHUB_RUN_ID',uuid.uuid4().hex)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True)
            try:
                for group in 'ABC':
                    permit=storage.call('booking_begin',{**fence,'run_id':run,'group':group,'started_at':stamp()})
                    if not permit['accepted']:
                        report['groups'][group]={'status':'NOT_RETRIED','code':'ATTEMPT_ALREADY_RECORDED'};continue
                    ctx=None
                    try:
                        ctx=browser.new_context(timezone_id='Asia/Tokyo',accept_downloads=False,service_workers='block')
                        ctx.set_default_timeout(30000);ctx.set_default_navigation_timeout(30000)
                        read=collect(ctx.new_page(),group,credentials_from_env(group))
                    except Exception:read=result(group,code='READ_ERROR')
                    finally:
                        if ctx is not None:
                            try:ctx.close()
                            except Exception:pass
                    storage.call('booking_result',{**fence,'run_id':run,'group':group,'result':read})
                    report['groups'][group]={'status':read['status'],'code':read['code'],'bookings':len(read['rows']),
                        'source_count':read['source_count'],'pages':read['pages'],'display_name_verified':read['display_name'] is not None}
            finally:browser.close()
    finally:storage.call('booking_release',fence)
    # D1 results are already durable. Failure below NEVER causes relogin/replay.
    try:
        url=os.environ['BOOKED_SYNC_URL'];secret=os.environ['BOOKED_SYNC_SECRET']
        if url!='https://bot-datsan-sheets.phanquanghuy484.workers.dev/booked/sync':raise ValueError()
        req=Request(url,data=b'{}',method='POST',headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
        with build_opener(NoRedirect()).open(req,timeout=25) as response:
            sync=json.loads(response.read(10000))
        report['sheets']={k:sync.get(k) for k in ['status','code','total','updatedAt']}
    except Exception:report['sheets']={'status':'UNCONFIRMED','code':'BOOKED_SYNC_NOT_CONFIRMED'}
    print(json.dumps(report,ensure_ascii=True),flush=True)
    return 0 if all(g.get('status')=='COMPLETE' for g in report['groups'].values()) and report['sheets']['status'] in ['UPDATED','SKIPPED'] else 2

if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        print(json.dumps({'kind':'BOOKING_SYNC','status':'STOPPED','code':'BOOKING_RUNTIME_STOPPED_NO_RETRY','execution_allowed':False,'auto_booking_allowed':False}),flush=True)
        sys.exit(2)
