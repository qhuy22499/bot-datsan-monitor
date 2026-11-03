"""Real headless Chromium against intercepted HTML; zero website traffic."""
from datetime import timedelta
import unittest
from unittest.mock import patch
from playwright.sync_api import sync_playwright
from monitor.shared.collector import collect_scope_pages, ORIGIN
from monitor.shared.scope import ResolvedScope
from monitor.shared.domain import ScanError
from .support import T0

HTML='''<!doctype html><meta charset="utf-8"><script>
let index=0;
function show(){
 const d=new Date(Date.UTC(2026,9,31+index));
 let html='<p>小菅西フットサル場</p><table class="akitablelist"><tr><th>'+d.getUTCFullYear()+'年'+(d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日</th></tr>';
 for(const court of ['Ａ','Ｂ']){
  html+='<tr><th>フットサル場'+court+'</th>';
  for(let n=0;n<7;n++)html+='<td><img src="/'+(index===1 && n===0?'lw_212.gif':'lw_emptybs.gif')+'"></td>';
  html+='</tr>';
 }
 document.body.innerHTML=html+'</table><a href="#" onclick="index++;show();return false">次の日</a>';
}
</script><body onload="show()"></body>'''


class CollectorDom(unittest.TestCase):
    def setUp(self):
        self.playwright=sync_playwright().start()
        self.browser=self.playwright.chromium.launch(headless=True)
        self.context=self.browser.new_context(timezone_id='Asia/Tokyo')
        self.context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body=HTML))
        self.page=self.context.new_page();self.page.goto(ORIGIN+'/fixture')
        self.scope=ResolvedScope('FIXED_DAYS',T0.date(),T0.date()+timedelta(days=2),3,42,'OFFLINE_FIXTURE',True)

    def tearDown(self):
        self.context.close();self.browser.close();self.playwright.stop()

    def test_dynamic_three_day_grid_exact_navigation_and_event_mapping(self):
        with patch('monitor.shared.collector.open_availability_page',lambda page:None):
            result=collect_scope_pages(self.page,scope=self.scope,started_at=T0,clock=lambda:T0)
        self.assertEqual(result.days_read,3);self.assertEqual(result.slots_read,42)
        self.assertEqual(sum(s.status=='EVENT_RESERVED' for s in result.slots),2)
        self.assertEqual(len(set((s.day,s.court,s.start) for s in result.slots)),42)

    def test_midnight_rollover_refuses_complete(self):
        with patch('monitor.shared.collector.open_availability_page',lambda page:None):
            with self.assertRaisesRegex(ScanError,'SCAN_WINDOW_CHANGED'):
                collect_scope_pages(self.page,scope=self.scope,started_at=T0,clock=lambda:T0+timedelta(days=1))


if __name__=='__main__':unittest.main()
