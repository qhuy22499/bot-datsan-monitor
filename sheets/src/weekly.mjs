import {BOOKED_SQL,projectBooked,readBooked} from './booked.mjs';
import {weekBounds,bookingsMessage} from './bookings-message.mjs';
import {sendReply,TelegramError} from './telegram.mjs';
const fault=code=>{const e=new Error(code);e.code=code;throw e;};
export const WEEKLY_SQL=BOOKED_SQL+`,
 (SELECT json_group_array(json_object('group',group_alias,'status',status,'observedAt',observed_at)) FROM booking_attempts WHERE run_id=?) AS attempts_json,
 (SELECT started_at FROM booking_runs WHERE id=?) AS run_started,
 (SELECT expires FROM booking_lease WHERE id=1) AS lease_expires`;
export function scheduledMonday(trigger,now){
  if(typeof trigger!=='string'||!/^cfbooking-\d{13}$/.test(trigger))return null;
  const at=Number(trigger.slice(10)); // cfbooking- is ten characters.
  const utc=new Date(at),jst=new Date(at+32400000),current=new Date(now+32400000);
  if(!Number.isSafeInteger(at)||at>now||utc.getUTCHours()!==23||utc.getUTCMinutes()!==30
    ||utc.getUTCSeconds()!==0||utc.getUTCMilliseconds()!==0||jst.getUTCDay()!==1
    ||current.toISOString().slice(0,10)!==jst.toISOString().slice(0,10))return null;
  return {at,week:weekBounds(at)};
}
export async function verifySignature(trigger,signature,secret){
  if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(secret)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.match(/../g),v=>parseInt(v,16));
  return crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode('BOOKING_CRON_V1:'+trigger));
}
export async function readWeekly(db,trigger,now){
  const scheduled=scheduledMonday(trigger,now);if(!scheduled)fault('NOT_VERIFIED_MONDAY_TRIGGER');
  let row;
  try{row=await db.withSession('first-primary').prepare(WEEKLY_SQL).bind(trigger,trigger).first();}
  catch{fault('WEEKLY_SOURCE_UNAVAILABLE');}
  try{
    const groups=JSON.parse(row.groups_json),rows=JSON.parse(row.rows_json),attempts=JSON.parse(row.attempts_json);
    if(!Array.isArray(groups)||groups.length!==3||!Array.isArray(attempts)||attempts.length!==3
      ||new Set(attempts.map(a=>a.group)).size!==3||new Set(groups.map(g=>g.group)).size!==3
      ||!Number.isFinite(Date.parse(row.run_started))||Date.parse(row.run_started)<scheduled.at
      ||Date.parse(row.run_started)>now||!Number.isSafeInteger(row.lease_expires)||row.lease_expires>now)fault('BOOKING_RUN_NOT_FINISHED');
    for(const g of groups){
      const a=attempts.find(a=>a.group===g.group);
      if(!['A','B','C'].includes(g.group)||!a||!['COMPLETE','PARTIAL','FAILED'].includes(a.status)
        ||g.status!==a.status||a.observedAt!==g.lastAttempt
        ||!Number.isFinite(Date.parse(a.observedAt))||Date.parse(a.observedAt)<Date.parse(row.run_started)||Date.parse(a.observedAt)>now)fault('BOOKING_RUN_NOT_FINISHED');
    }
    if(!groups.some(g=>g.lastSuccess))return {status:'UNVERIFIED',groups};
    return {status:'READ',...projectBooked({groups,rows},now)};
  }catch(e){if(e?.code)throw e;fault('WEEKLY_SOURCE_INVALID');}
}
export class WeeklyNotifications{
  constructor({store,env,clock=Date.now,read=readWeekly,send=sendReply}){Object.assign(this,{store,env,clock,read,send});}
  async deliver(input,{test=false}={}){
    const now=this.clock();let data,id;
    if(test){
      id='WEEKLY_BOOKINGS_TEST:LIVE_V1';
      try{data={status:'READ',...await readBooked(this.env.DB,now)};}catch{data={status:'UNVERIFIED'};}
    }else{
      if(!input||Object.keys(input).sort().join(',')!=='sheets_status,signature,trigger_id'
        ||!['UPDATED','SKIPPED','FAILED','UNCERTAIN','UNCONFIRMED','TIMEOUT'].includes(input.sheets_status)
        ||!scheduledMonday(input.trigger_id,now)
        ||!await verifySignature(input.trigger_id,input.signature,this.env.BOOKING_CRON_SIGNING_SECRET))return {status:'REJECTED',code:'NOT_VERIFIED_MONDAY_TRIGGER'};
      id='WEEKLY_BOOKINGS:'+weekBounds(now).start;
      const existing=this.store.weekly(id);
      if(existing&&existing.state!=='PENDING')return {status:existing.state,duplicate:true,messageId:existing.messageId??null};
      try{data=await this.read(this.env.DB,input.trigger_id,now);}catch(e){return {status:'REJECTED',code:e.code||'WEEKLY_SOURCE_INVALID'};}
    }
    const message=bookingsMessage(data,this.env.GOOGLE_SPREADSHEET_ID,{now,test,sheetWarning:!test&&!['UPDATED','SKIPPED'].includes(input.sheets_status)});
    this.store.weeklyIntent(id,{total:message.total,days:message.days,week:message.week.start});
    if(!this.store.weeklyClaim(id)){
      const old=this.store.weekly(id);return {status:old.state,duplicate:true,messageId:old.messageId??null};
    }
    try{
      const reply=await this.send(this.env,this.env.TELEGRAM_TEST_CHAT_ID,message.text,{signal:AbortSignal.timeout(10000)});
      this.store.weeklyFinish(id,'SENT',{messageId:reply.messageId,total:message.total,days:message.days});
      return {status:'SENT',messageId:reply.messageId,total:message.total,days:message.days};
    }catch(e){
      const state=e instanceof TelegramError&&!e.ambiguous?'FAILED':'UNCERTAIN';
      this.store.weeklyFinish(id,state,{code:e instanceof TelegramError?e.code:'TELEGRAM_DELIVERY_UNKNOWN'});
      return {status:state,code:e instanceof TelegramError?e.code:'TELEGRAM_DELIVERY_UNKNOWN'};
    }
  }
}
