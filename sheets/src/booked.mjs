// Independent BOOKED read model: SELECT only, no monitoring tables/mutations.
import {jstStamp} from './coordinator.mjs';
export const BOOKED_SQL=`SELECT
 (SELECT json_group_array(json_object('group',group_alias,'displayName',display_name,'lastSuccess',last_success_at,'lastAttempt',last_attempt_at,'status',sync_status,'code',code)) FROM booking_groups) AS groups_json,
 (SELECT json_group_array(json_object('id',id,'group',group_alias,'day',day,'start',start,'end',end,'court',court,'observedAt',observed_at)) FROM bookings WHERE listed=1 AND reservation_status='CONFIRMED') AS rows_json`;
const weekdays=['CN','T2','T3','T4','T5','T6','T7'];
const date=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const validStamp=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(s)&&Number.isFinite(Date.parse(s));
const fail=()=>{const e=new Error('BOOKED_SOURCE_INVALID');e.code='BOOKED_SOURCE_INVALID';throw e;};
export function projectBooked(snapshot,now){
  const {groups,rows}=snapshot;
  if(!Array.isArray(groups)||groups.length!==3||new Set(groups.map(g=>g.group)).size!==3||!Array.isArray(rows)||rows.length>3000)fail();
  const local=new Date(now+32400000).toISOString();const today=local.slice(0,10),time=local.slice(11,16);
  if(!Number.isSafeInteger(now)||now<=0)fail();
  for(const g of groups)if(!'ABC'.includes(g.group)||g.group.length!==1||!['COMPLETE','PARTIAL','FAILED'].includes(g.status)
    ||(g.lastSuccess!==null&&!validStamp(g.lastSuccess))||(g.lastAttempt!==null&&!validStamp(g.lastAttempt))
    ||(g.displayName!==null&&(typeof g.displayName!=='string'||g.displayName.length>200||/[\x00-\x1f\x7f]/.test(g.displayName))))fail();
  if(!groups.some(g=>g.lastSuccess!==null))fail(); // Never erase an existing Sheet without any verified source.
  const ids=new Set();
  for(const r of rows){
    const g=groups.find(g=>g.group===r.group);
    if(!g||!g.lastSuccess||!date(r.day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start)
      ||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.end)||r.end<=r.start||!['A','B'].includes(r.court)
      ||!validStamp(r.observedAt)||r.observedAt!==g.lastSuccess||ids.has(r.id))fail();
    ids.add(r.id);
  }
  const current=rows.filter(r=>r.day>today||(r.day===today&&r.end>time))
    .sort((a,b)=>a.day.localeCompare(b.day)||a.start.localeCompare(b.start)||a.court.localeCompare(b.court)||a.group.localeCompare(b.group));
  const monday=new Date(today+'T00:00:00Z');monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  const sunday=new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+6);
  // Weekly count includes already-ended confirmed days this week, even though
  // those individual rows are omitted from the future/ongoing display table.
  const count=new Set(rows.filter(r=>r.day>=monday.toISOString().slice(0,10)&&r.day<=sunday.toISOString().slice(0,10)).map(r=>r.day)).size;
  const complete=groups.every(g=>g.status==='COMPLETE'&&g.lastSuccess);
  const observed=groups.filter(g=>g.lastSuccess).map(g=>g.lastSuccess).sort()[0];
  return {snapshot,rows:current,groups:groups.slice().sort((a,b)=>a.group.localeCompare(b.group)),total:current.length,
    observedAt:observed,stale:groups.some(g=>g.lastSuccess?.slice(0,10)!==today),sourceWarning:!complete,
    weeklyDays:count,complete};
}
export async function readBooked(db,now){
  try{
    const row=await db.withSession('first-primary').prepare(BOOKED_SQL).first();
    if(!row)fail();return projectBooked({groups:JSON.parse(row.groups_json),rows:JSON.parse(row.rows_json)},now);
  }catch{fail();}
}
export function bookedValues(data,updatedAt){
  const warning=[data.sourceWarning?'Dữ liệu chưa đầy đủ; giữ lịch đã xác minh của Group lỗi.':'Cả ba Group đã đọc COMPLETE.',
    data.stale?'Có Group chưa quan sát thành công trong ngày JST hiện tại.':'',
    data.groups.some(g=>!g.displayName)?'Thiếu tên hiển thị đã xác minh; không thay bằng login ID.':'',
    'Ngưỡng freshness Booking chưa chốt; không xác nhận điều kiện đặt tự động.'].filter(Boolean).join(' ');
  return [
    ['Bot DatSan — Lịch sân đã đặt'],['Nguồn','Cloudflare D1 / 小菅西フットサル場'],
    ['Quan sát thành công sớm nhất (JST)',jstStamp(Date.parse(data.observedAt))],
    ['Cập nhật Google Sheets (JST)',updatedAt],
    ...data.groups.map(g=>['Group '+g.group,g.status,g.lastSuccess?jstStamp(Date.parse(g.lastSuccess)):'Chưa có quan sát thành công',g.displayName||'Chưa xác minh tên']),
    ['Tổng Booking đang diễn ra / sắp tới',String(data.total)],
    ['Số ngày đã đặt tuần này / 3',`${data.weeklyDays}/3${data.complete?' — theo snapshot COMPLETE':' — ít nhất; CHƯA ĐẦY ĐỦ'}`],
    ['Trạng thái',warning],[],
    ['Ngày','Khung giờ','Sân','Group','Tên tài khoản'],
    ...data.rows.map(r=>[`${weekdays[new Date(r.day+'T00:00:00Z').getUTCDay()]} ${r.day.slice(8,10)}/${r.day.slice(5,7)}/${r.day.slice(0,4)}`,
      `${r.start}–${r.end}`,r.court,r.group,data.groups.find(g=>g.group===r.group).displayName||'Chưa xác minh']),
  ];
}
