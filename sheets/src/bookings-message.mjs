import {jstStamp} from './coordinator.mjs';
export function weekBounds(now,offset=0){
  if(!Number.isSafeInteger(now)||now<=0||![0,1].includes(offset))throw new Error('INVALID_WEEK');
  const today=new Date(now+32400000).toISOString().slice(0,10);
  const start=new Date(today+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7+offset*7);
  return {start:start.toISOString().slice(0,10),end:new Date(start.getTime()+6*86400000).toISOString().slice(0,10)};
}
const date=s=>`${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}`;
const weekdays=['CN','T2','T3','T4','T5','T6','T7'];
// JS string.length counts UTF-16 units, the transport's Telegram contract.
export function bookingsMessage(data,spreadsheetId,{now=Date.now(),offset=0,sheetWarning=false,test=false}={}){
  if(typeof spreadsheetId!=='string'||!/^[A-Za-z0-9_-]{20,150}$/.test(spreadsheetId))throw new Error('INVALID_SPREADSHEET');
  const week=weekBounds(now,offset),link=`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#range=BOOKED!A1:E`;
  const title=[...(test?['[TEST — LỊCH TỪ D1, KHÔNG PHẢI TIN THỨ HAI TỰ ĐỘNG]']:[]),`⚽ LỊCH SÂN TUẦN ${date(week.start)} – ${date(week.end)}`];
  const valid=data?.status==='READ'&&Array.isArray(data.rows)&&Array.isArray(data.groups);
  const rows=valid?data.rows.filter(r=>r.day>=week.start&&r.day<=week.end)
    .sort((a,b)=>a.day.localeCompare(b.day)||a.start.localeCompare(b.start)||a.court.localeCompare(b.court)||a.group.localeCompare(b.group)):[];
  const days=valid?new Set(rows.map(r=>r.day)).size:null;
  const reliable=valid&&data.groups.every(g=>g.status==='COMPLETE'&&g.lastSuccess);
  const render=n=>{
    const lines=[...title,''];
    if(!valid){
      lines.push('⚠️ Không thể xác minh lịch sân từ D1. Không thể kết luận đội không có Booking.');
      if(Array.isArray(data?.groups))for(const g of data.groups)lines.push(`⚠️ Group ${g.group}: ${g.status} · Chưa có quan sát thành công`);
    }
    else if(!rows.length)lines.push(reliable?'Hiện chưa có lịch sân còn hiệu lực trong tuần này.':'⚠️ Chưa đủ dữ liệu để kết luận tuần này không có lịch sân.');
    else lines.push(...rows.slice(0,n).map(r=>`${weekdays[new Date(r.day+'T00:00:00Z').getUTCDay()]} ${date(r.day)} · ${r.start}–${r.end} · Sân ${r.court} · Group ${r.group}`));
    if(n<rows.length)lines.push(`… Còn ${rows.length-n} Booking; xem đầy đủ tại BOOKED.`);
    if(valid){
      lines.push('',`📅 Tổng: ${days} ngày có sân còn lại${reliable?'':' đã quan sát; CHƯA ĐẦY ĐỦ'}`);
      for(const g of data.groups){
        lines.push(`${g.status==='COMPLETE'?'✅':'⚠️'} Group ${g.group}: ${g.status} · ${g.lastSuccess?jstStamp(Date.parse(g.lastSuccess)):'Chưa có quan sát thành công'}`);
      }
      if(data.sourceWarning)lines.push('⚠️ Group lỗi/chưa xác minh ở lần gần nhất; giữ lịch đã xác minh trước đó, không coi là 0 lịch.');
      if(data.stale)lines.push('⚠️ Có dữ liệu cũ; thời điểm trên là quan sát thực tế, không phải thời điểm trả lời.');
    }
    if(sheetWarning)lines.push('⚠️ Chưa xác nhận cập nhật BOOKED; lịch trong tin lấy trực tiếp từ D1.');
    lines.push('','🔗 Xem đầy đủ: '+link);
    return lines.join('\n');
  };
  let shown=rows.length,text=render(shown);
  if(text.length>4000){
    let low=0,high=rows.length;
    while(low<high){const middle=Math.ceil((low+high)/2);if(render(middle).length<=4000)low=middle;else high=middle-1;}
    shown=low;text=render(shown);
  }
  if(text.length>4096)throw new Error('BOOKINGS_TEXT_TOO_LONG');
  return {text,total:valid?rows.length:null,days,shown,hidden:rows.length-shown,week,complete:reliable};
}
