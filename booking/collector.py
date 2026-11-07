"""PoC03/04 reader orchestration; sequential contexts, no session persistence."""
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .login import (LoginAttempt, check_debug_settings, open_login_page,
                    read_evidence, wait_for_evidence)
from .fields import _date_text, _times, _number, _reservation_status, _payment_status

JST = timezone(timedelta(hours=9))
EXTRACT = Path(__file__).with_name('extract.js').read_text(encoding='utf-8')
ORACLE = Path(__file__).with_name('oracle.js').read_text(encoding='utf-8')
DISPLAY = r'''() => {
  if(location.origin!=='https://rsv.shisetsu.city.katsushika.lg.jp')return null;
  const names=new Set();
  for(const e of document.querySelectorAll('td,span,font,b,strong,div,p')) {
    if(!e.getClientRects().length || getComputedStyle(e).visibility==='hidden'
       || e.querySelector('input,textarea,select,script,style'))continue;
    const t=(e.textContent||'').trim();
    if(t.length>300)continue;
    const m=t.match(/^(?:葛飾区公共施設予約システム\s*)?利用者[：:]\s*([^\r\n]+?)\s*様$/u);
    if(m && m[1].trim())names.add(m[1].trim());
  }
  return names.size===1?[...names][0]:null;
}'''

def stamp():
    return datetime.now(JST).isoformat(timespec='seconds')

def result(group, status='FAILED', code='READ_ERROR', **extra):
    return dict(group=group, status=status, code=code, observed_at=stamp(),
                display_name=None, rows=[], pages=0, source_count=0, **extra)

def summarize(snapshots, group):
    """Coverage is all source rows, before facility/date filtering. No 90-day cap."""
    out=result(group)
    normalized=[]; total=None; last=0
    try:
        for s in snapshots:
            a=s['auth'];pager=s['pagination'];summaries=pager['summaries']
            if (s['state']!='READY' or not s['header_valid'] or s['table_count']!=1
                or not a['trusted_origin'] or not a['logout_control_visible']
                or not a['reservation_heading_visible'] or not a['reservation_columns_visible']
                or any(a[k] for k in ['id_field_visible','password_field_visible','error_region_visible','verification_prompt_visible'])
                or s['issues'] or s['rejected_row_count'] or pager['summary_conflict'] or len(summaries)!=1):
                raise ValueError()
            n=summaries[0]; count=s['source_row_count']
            if total is None:total=n['total']
            if (type(total) is not int or total<0 or total>10000 or n['total']!=total
                or count!=len(s['rows']) or type(count) is not int
                or (total==0 and (n['first']!=0 or n['last']!=0 or count!=0 or len(snapshots)!=1
                                  or pager['next_candidate_count'] or pager['previous_candidate_count']))
                or (total>0 and (n['first']!=last+1 or n['last']-n['first']+1!=count or n['last']>total))):
                raise ValueError()
            for i,r in enumerate(s['rows'],1):
                if r['source_row_index']!=i:raise ValueError()
                d=_date_text(r['usage_date_text']).isoformat();start,end=_times(r['time_text'])
                number=_number(r['reservation_number']);status=_reservation_status(r['reservation_status_raw'])
                pay=_payment_status(r['payment_status_raw'])
                if r['facility']=='小菅西フットサル場' and r['court_label'] in ['フットサル場A','フットサル場B']:
                    normalized.append(dict(day=d,start=start,end=end,court=r['court_label'][-1],
                        reservation_number=number,reservation_status=status,
                        payment_status=pay['normalized'],payment_raw=pay['raw']))
            last=n['last'];out['pages']+=1;out['source_count']+=count
        if not snapshots:raise ValueError()
        # The verified website keeps 前へ/次へ candidates on its last/only page
        # (PoC04 E2E evidence). Counter coverage, not candidate presence, proves
        # exhaustion. Never click Next after last==total.
        if last!=total:
            out.update(status='PARTIAL',code='PAGINATION_INCOMPLETE');return out
        # Occurrence index preserves even indistinguishable rows without treating
        # reservation number as a unique booking. Sort first for stable identities.
        counts={}
        for r in sorted(normalized,key=lambda r:(r['day'],r['start'],r['end'],r['court'],r['reservation_number'] or '')):
            identity=[group,r['reservation_number'],r['day'],r['start'],r['end'],r['court']]
            key=json.dumps(identity,ensure_ascii=False,separators=(',',':'))
            counts[key]=counts.get(key,0)+1
            r['id']=hashlib.sha256((key+':'+str(counts[key])).encode()).hexdigest()
            out['rows'].append(r)
        out.update(status='COMPLETE',code='VERIFIED')
    except (KeyError,ValueError,TypeError):
        out.update(status='PARTIAL' if snapshots else 'FAILED',code='SOURCE_INCOMPLETE',rows=[])
    return out

def read_pages(page, group):
    snapshots=[]
    for _ in range(100):
        s=page.evaluate(EXTRACT);snapshots.append(s)
        try:
            oracle=page.evaluate(ORACLE)
            expected=[(r['reservation_number'],_date_text(r['usage_date_text']).isoformat(),*_times(r['time_text']),
                       r['facility'],r['court_label'][-1] if r['court_label'] in ['フットサル場A','フットサル場B'] else 'OTHER_COURT',r['payment_status_raw']) for r in s['rows']]
            actual=[(r['reservation_number'],r['usage_date'],r['start_time'],r['end_time'],r['facility'],r['court'],r['payment_raw']) for r in oracle['rows']]
            if (oracle['state']!='READY' or oracle['source_row_count']!=s['source_row_count']
                or oracle['counters']!=s['pagination']['summaries'] or expected!=actual):
                raise ValueError()
        except Exception:
            s['issues'].append('DOM_ORACLE_MISMATCH');break
        p=s.get('pagination',{});ns=p.get('summaries',[])
        if s.get('state')!='READY' or len(ns)!=1 or s.get('issues'):break
        n=ns[0]
        if n['last']==n['total']:break
        # These exact text labels are already detected by the PoC03 extractor.
        # Never click a guessed URL, row action or reservation transaction.
        if p.get('next_candidate_count')!=1:break
        next_link=page.get_by_role('link',name=re.compile(r'^(次へ|次のページ)$'))
        if next_link.count()!=1 or not next_link.is_visible():break
        before=n.copy()
        next_link.click(timeout=30000)
        try:
            page.wait_for_function('before => { const s = '+EXTRACT+'; const n=s.pagination?.summaries; return s.state==="READY" && n?.length===1 && n[0].first!==before.first; }',
                                   arg=before,timeout=30000)
        except Exception:break
    out=summarize(snapshots,group)
    name=page.evaluate(DISPLAY)
    if isinstance(name,str) and 0<len(name)<=200 and not any(ord(c)<32 for c in name):out['display_name']=name
    return out

def collect(page, group, credentials):
    check_debug_settings()
    username,password=credentials
    if not username or not password:return result(group,code='CREDENTIALS_MISSING')
    try:
        open_login_page(page);before=read_evidence(page)
        def valid(e):
            return e['trusted_origin'] and e['id_field_visible'] and e['password_field_visible'] and not any(e[k] for k in ['logout_control_visible','verification_prompt_visible','error_region_visible'])
        if before['verification_prompt_visible']:return result(group,code='MANUAL_ACTION_REQUIRED')
        if not valid(before):return result(group,code='LOGIN_SAFETY_CHECK_FAILED')
        page.get_by_label('登録番号(ID)（半角）：',exact=True).fill(username)
        page.get_by_label('パスワード（半角）：',exact=True).fill(password)
        username=password=''
        if not valid(read_evidence(page)):return result(group,code='LOGIN_SAFETY_CHECK_FAILED')
        attempt=LoginAttempt()
        try:attempt.submit_once(page.get_by_role('link',name='ログイン',exact=True))
        except Exception:pass  # Submission may have reached server. Never resubmit.
        after=wait_for_evidence(page,before)
        if after['verification_prompt_visible']:return result(group,code='MANUAL_ACTION_REQUIRED')
        if after['error_region_visible']:return result(group,code='LOGIN_FAILED')
        if (not after['trusted_origin'] or not after['logout_control_visible'] or after['id_field_visible']
            or after['password_field_visible']):return result(group,code='LOGIN_UNVERIFIED')
        return read_pages(page,group)
    except Exception:
        # Playwright exceptions can contain the submitted password. Never emit.
        return result(group,code='WEBSITE_OR_READ_ERROR')

def credentials_from_env(group):
    return tuple(os.environ.pop(f'BOOKING_GROUP_{group}_{p}','') for p in ['LOGIN_ID','PASSWORD'])
