import copy
import unittest
from pathlib import Path
from booking.collector import summarize, DISPLAY, read_pages
from booking.login import LoginAttempt
from tests.support import Worker,T0

def row(day='2026-11-08',start='18:30',end='20:30',court='B'):
    return dict(source_row_index=1,reservation_number='12345',facility='小菅西フットサル場',court_label='フットサル場'+court,
                usage_date_text=day,time_text=start+'～'+end,reservation_status_raw=None,payment_status_raw='支払前')

def snapshot(rows,first=1,total=None,last=None):
    total=len(rows) if total is None else total
    return dict(state='READY',header_valid=True,table_count=1,issues=[],rejected_row_count=0,source_row_count=len(rows),
       auth=dict(trusted_origin=True,logout_control_visible=True,reservation_heading_visible=True,reservation_columns_visible=True,
                 id_field_visible=False,password_field_visible=False,error_region_visible=False,verification_prompt_visible=False),
       rows=[dict(r,source_row_index=i) for i,r in enumerate(rows,1)],
       pagination=dict(summaries=[dict(total=total,first=first if total else 0,last=(first+len(rows)-1 if total else 0) if last is None else last)],
                       next_candidate_count=0,previous_candidate_count=0,summary_conflict=False))

class Fields(unittest.TestCase):
    def test_confirmed_unpaid_and_same_number_multiple_days_slots(self):
        s=snapshot([row(),row('2026-11-15'),row(start='20:30',end='22:30')]);r=summarize([s],'A')
        self.assertEqual(r['status'],'COMPLETE');self.assertEqual(len({r['id'] for r in r['rows']}),3)
        self.assertTrue(all(r['reservation_status']=='CONFIRMED' and r['payment_status']=='UNPAID' for r in r['rows']))
    def test_no_90_day_truncation_and_other_facility(self):
        r=row('2027-12-31');other=dict(row(),facility='OTHER_FACILITY')
        read=summarize([snapshot([r,other])],'C');self.assertEqual(read['source_count'],2);self.assertEqual(len(read['rows']),1)
    def test_explicit_empty_requires_counter_and_no_pager(self):
        s=snapshot([]);self.assertEqual(summarize([s],'A')['status'],'COMPLETE')
        s['pagination']['next_candidate_count']=1;self.assertNotEqual(summarize([s],'A')['status'],'COMPLETE')
    def test_contiguous_pages_and_incomplete_ranges(self):
        a=snapshot([row()],total=2);a['pagination']['next_candidate_count']=1
        b=snapshot([row('2026-11-15')],first=2,total=2)
        self.assertEqual(summarize([a,b],'A')['status'],'COMPLETE')
        self.assertEqual(summarize([a],'A')['status'],'PARTIAL')
        b['pagination']['summaries'][0]['first']=1
        self.assertNotEqual(summarize([a,b],'A')['status'],'COMPLETE')
    def test_last_page_counter_proves_coverage_even_with_pager_candidates(self):
        s=snapshot([row(),row('2026-11-15')]);s['pagination'].update(next_candidate_count=1,previous_candidate_count=1)
        r=summarize([s],'A');self.assertEqual(r['status'],'COMPLETE');self.assertEqual(len(r['rows']),2)
    def test_bad_fields_and_session_do_not_become_zero(self):
        for field,value in [('time_text','25:00–26:00'),('usage_date_text','2026-02-30')]:
            r=row();r[field]=value;self.assertNotEqual(summarize([snapshot([r])],'A')['status'],'COMPLETE')
        s=snapshot([row()]);s['auth']['logout_control_visible']=False
        self.assertNotEqual(summarize([s],'A')['status'],'COMPLETE')
    def test_duplicate_rows_preserve_multiplicity_stable(self):
        s=snapshot([row(),row()]);a=summarize([s],'A');b=summarize([s],'A')
        self.assertEqual(a,b);self.assertEqual(len({r['id'] for r in a['rows']}),2)
        self.assertNotEqual(a['rows'][0]['id'],summarize([s],'B')['rows'][0]['id'])
    def test_one_login_attempt_even_timeout(self):
        class Link:
            def click(self,**kw):raise TimeoutError()
        a=LoginAttempt()
        with self.assertRaises(TimeoutError):a.submit_once(Link())
        with self.assertRaises(Exception):a.submit_once(Link())
        self.assertTrue(a.attempted)

class HeaderDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def test_fullwidth_preserved_ambiguous_and_no_id_fallback(self):
        ctx=self.browser.new_context();page=ctx.new_page()
        try:
            page.route('https://rsv.shisetsu.city.katsushika.lg.jp/**',lambda route:route.fulfill(content_type='text/html; charset=utf-8',body='<span>葛飾区公共施設予約システム利用者：ＭＯＫＯ　ＦＣ様</span>'))
            page.goto('https://rsv.shisetsu.city.katsushika.lg.jp/test')
            self.assertEqual(page.evaluate(DISPLAY),'ＭＯＫＯ　ＦＣ')
            page.set_content('<span>利用者：別名様</span><span>利用者：ＭＯＫＯ　ＦＣ様</span>');self.assertIsNone(page.evaluate(DISPLAY))
            page.set_content('<input id="userId" value="never-display-this">');self.assertIsNone(page.evaluate(DISPLAY))
        finally:ctx.close()
    def test_actual_extract_oracle_paginated_dom_and_empty(self):
        ctx=self.browser.new_context();page=ctx.new_page()
        header='<tr><th>予約番号</th><th>利用日</th><th>時間</th><th>館</th><th>施設</th><th>支払状況</th></tr>'
        def tr(day):return f'<tr><td>12345</td><td>{day}</td><td>18:30～20:30</td><td>小菅西フットサル場</td><td>フットサル場B</td><td>支払前</td></tr>'
        html='<a>ログアウト</a><h1>予約一覧</h1><span>利用者：ＦＣ　テスト様</span><p id="counter">2件中 1～1件表示</p><table>'+header+'<tbody id="rows">'+tr('2026-11-08')+'</tbody></table>'
        html+='<a id="next" href="#">次へ</a><script>document.getElementById("next").onclick=()=>{document.getElementById("rows").innerHTML='+__import__('json').dumps(tr('2026-11-15'))+';document.getElementById("counter").textContent="2件中 2～2件表示";document.getElementById("next").remove();return false;};</script>'
        try:
            page.route('https://rsv.shisetsu.city.katsushika.lg.jp/**',lambda route:route.fulfill(content_type='text/html; charset=utf-8',body=html))
            page.goto('https://rsv.shisetsu.city.katsushika.lg.jp/test')
            r=read_pages(page,'A');self.assertEqual(r['status'],'COMPLETE');self.assertEqual(r['pages'],2);self.assertEqual(len(r['rows']),2)
            self.assertEqual(r['display_name'],'ＦＣ　テスト')
            page.set_content('<a>ログアウト</a><h1>予約一覧</h1><p>0件中 0～0件表示</p><table>'+header+'</table>')
            r=read_pages(page,'B');self.assertEqual(r['status'],'COMPLETE');self.assertEqual(r['source_count'],0)
        finally:ctx.close()

class BookingIntegration(unittest.TestCase):
    def setUp(self):
        self.w=Worker();self.owner='11111111-1111-4111-8111-111111111111'
        a=self.w.call('booking_acquire',{'owner':self.owner});self.auth={'owner':self.owner,'fence':a['fence']}
        self.run=0
    def tearDown(self):self.w.close()
    def apply(self,group,rows,status='COMPLETE',name='ＴＥＳＴ　ＦＣ'):
        self.run+=1;run=str(self.run);at=self.w.at.isoformat(timespec='seconds')
        read=summarize([snapshot(rows)],group);read.update(display_name=name,observed_at=at)
        if status!='COMPLETE':read.update(status=status,code='SOURCE_INCOMPLETE',rows=[])
        p={**self.auth,'run_id':run,'group':group}
        self.assertTrue(self.w.call('booking_begin',{**p,'started_at':at})['accepted'])
        self.assertFalse(self.w.call('booking_begin',{**p,'started_at':at})['accepted'])
        self.w.call('booking_result',{**p,'result':read})
        self.assertTrue(self.w.call('booking_result',{**p,'result':read})['duplicate'])
        return self.w.call('booking_snapshot',self.auth)
    def test_partial_keeps_history_other_groups_and_complete_zero(self):
        self.apply('A',[row()]);self.apply('B',[row('2026-11-15')]);s=self.apply('C',[row('2026-11-22')])
        self.assertEqual(len(s['rows']),3)
        s=self.apply('B',[],'FAILED',None);self.assertEqual(len(s['rows']),3)
        self.assertEqual(s['groups'][1]['sync_status'],'FAILED');self.assertEqual(s['groups'][1]['display_name'],'ＴＥＳＴ　ＦＣ')
        s=self.apply('A',[]);self.assertEqual(len(s['rows']),2)
        self.assertEqual({r['group_alias'] for r in s['rows']},{'B','C'})
        self.assertEqual(self.w.integrity(),{'integrity_ok':True,'foreign_key_errors':0})
    def test_restart_once_only_and_fencing(self):
        s=self.apply('A',[row(),row('2026-11-15')]);self.w.restart()
        self.assertEqual(len(self.w.call('booking_snapshot',self.auth)['rows']),2)
        self.assertFalse(self.w.call('booking_begin',{**self.auth,'run_id':'1','group':'A','started_at':self.w.at.isoformat(timespec='seconds')})['accepted'])
        self.w.call('booking_release',self.auth)
        b=self.w.call('booking_acquire',{'owner':'22222222-2222-4222-8222-222222222222'})
        self.assertGreater(b['fence'],self.auth['fence'])
        with self.assertRaises(Exception):self.w.call('booking_snapshot',self.auth)
    def test_monitor_lease_and_v2_independent(self):
        monitor=self.w.call('acquire',{'owner':self.owner,'destination':'-1001'})
        self.apply('A',[row()]);s=self.w.call('snapshot',{'owner':self.owner,'fence':monitor['fence']})
        self.assertEqual(s['source']['revision'],0);self.assertEqual(s['slots'],[])

class SheetsPort(unittest.TestCase):
    def test_sync_uses_application_user_agent_and_fixed_authenticated_endpoint(self):
        import io,json,os
        from unittest.mock import patch
        from booking.runtime import sync_booked
        class Opener:
            def open(self,req,timeout):
                self.req=req
                return io.BytesIO(json.dumps({'status':'SKIPPED','total':11,'updatedAt':'confirmed'}).encode())
        port=Opener()
        with patch.dict(os.environ,{'BOOKED_SYNC_URL':'https://bot-datsan-sheets.phanquanghuy484.workers.dev/booked/sync','BOOKED_SYNC_SECRET':'offline_test_only_booked_sync'}):
            self.assertEqual(sync_booked(opener=port)['status'],'SKIPPED')
        self.assertEqual(port.req.get_header('User-agent'),'BotDatSan-Monitor/1.0')
        self.assertEqual(port.req.method,'POST');self.assertEqual(port.req.data,b'{}')
    def test_sheets_only_recovery_does_not_construct_storage_or_browser(self):
        import os
        from unittest.mock import patch
        from booking.runtime import main
        with patch.dict(os.environ,{'BOOKING_SHEETS_ONLY':'true'}),patch('booking.runtime.BookingStorage',side_effect=AssertionError('NO_D1_MUTATION')),patch('booking.runtime.sync_booked',return_value={'status':'SKIPPED'}),patch('builtins.print'):
            self.assertEqual(main(),0)

if __name__=='__main__':unittest.main()
