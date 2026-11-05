import {readAvailability} from './read-model.mjs';
import {GoogleSheets} from './google.mjs';
import {SyncCoordinator,SYNC_BUDGET_MS} from './coordinator.mjs';
import {CoordinatorStore} from './store.mjs';
import {parseWebhook,summaryReply,sendReply,WebhookError,TelegramError} from './telegram.mjs';

export const SHEETS_CRON='10 0-13,22-23 * * *';
const safeJSON=(value,status=200)=>Response.json(value,{status});
const safety={execution_allowed:false,auto_booking_allowed:false};
const singleton=env=>env.SHEETS_COORDINATOR.get(env.SHEETS_COORDINATOR.idFromName('AVAILABLE-v1'));

export function validScheduledEvent(controller,nowMs) {
  const at=controller.scheduledTime;
  if (controller.cron!==SHEETS_CRON || !Number.isSafeInteger(nowMs) || nowMs<=0
      || !Number.isSafeInteger(at) || at<=0 || at>nowMs
      || new Date(at).getUTCMinutes()!==10)return false;
  const minute=ms=>{
    const day=new Date(ms+9*3600000);
    return day.getUTCHours()*60+day.getUTCMinutes();
  };
  return minute(at)>=430 && minute(at)<=1330 && minute(nowMs)>=430 && minute(nowMs)<=1330;
}

// No public manual-sync endpoint. Only Telegram's authenticated webhook may
// reach the singleton; scheduled() invokes it via an internal binding.
export default {
  async fetch(request,env) {
    const receivedAt=Date.now();
    if (env.TELEGRAM_WEBHOOK_ENABLED!=='true'
        || new URL(request.url).pathname!=='/telegram/webhook' || request.method!=='POST')
      return new Response('Not Found',{status:404});
    try {
      const update=await parseWebhook(request,env);
      if(!update)return safeJSON({ok:true,ignored:true});
      const response=await singleton(env).fetch(new Request('https://coordinator.internal/accept',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...update,receivedAt})}));
      if(!response.ok)return safeJSON({ok:false,code:'INBOX_UNAVAILABLE'},503);
      // accept waits for persistence only; Sheets/Telegram processing is async.
      return safeJSON({ok:true});
    }catch(error){
      if(error instanceof WebhookError)return safeJSON({ok:false,code:error.code},error.httpStatus);
      return safeJSON({ok:false,code:'INBOX_UNAVAILABLE'},503);
    }
  },
  async scheduled(controller,env) {
    controller.noRetry?.();
    if(env.SHEETS_SCHEDULE_ENABLED!=='true' || !validScheduledEvent(controller,Date.now()))return;
    try {
      const response=await singleton(env).fetch(new Request('https://coordinator.internal/sync',{method:'POST'}));
      const result=await response.json();
      console.log(JSON.stringify({kind:'SHEETS_SCHEDULED_SYNC',status:result.status,code:result.code,...safety}));
    }catch{
      console.log(JSON.stringify({kind:'SHEETS_SCHEDULED_SYNC',status:'FAILED',code:'COORDINATOR_UNAVAILABLE',...safety}));
    }
  },
};

export class SheetsCoordinator {
  constructor(ctx,env) {
    this.ctx=ctx;this.env=env;this.activeUpdates=new Map();
    this.ready=ctx.blockConcurrencyWhile(async()=>{
      this.store=new CoordinatorStore(ctx.storage.sql);
      this.store.recover();
      const deadline=this.store.pendingDeadline({pendingOnly:true});
      if(deadline!==null)await ctx.storage.setAlarm(Math.max(Date.now()+1,deadline));
    });
    this.coordinator=null;
  }

  engine() {
    if(!this.coordinator)this.coordinator=new SyncCoordinator({store:this.store,
      readSource:()=>readAvailability(this.env.DB,Date.now()),
      google:new GoogleSheets({serviceAccountJson:this.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        spreadsheetId:this.env.GOOGLE_SPREADSHEET_ID})});
    return this.coordinator;
  }

  async fetch(request) {
    await this.ready;
    const path=new URL(request.url).pathname;
    if(request.method!=='POST')return new Response('Not Found',{status:404});
    if(path==='/sync') {
      try{return safeJSON(await this.engine().sync());}
      catch{return safeJSON({status:'FAILED',code:'CONFIGURATION_INVALID'});}
    }
    if(path!=='/accept')return new Response('Not Found',{status:404});
    try {
      const input=await request.json();
      // Defense in depth even though only authenticated outer handler calls us.
      if(input.chatId!==this.env.TELEGRAM_TEST_CHAT_ID || !Number.isSafeInteger(input.updateId) || input.updateId<0)
        return safeJSON({ok:false},403);
      const now=Date.now();
      const receivedAt=input.receivedAt ?? now;
      if(!Number.isSafeInteger(receivedAt) || receivedAt>now || receivedAt<=0)return safeJSON({ok:false},400);
      const accepted=this.store.accept({...input,receivedAt,deadlineAt:receivedAt+SYNC_BUDGET_MS});
      if(accepted.record.state==='PENDING') {
        const deadline=this.store.pendingDeadline({pendingOnly:true});
        // Durable alarm is fallback for an accepted inbox record interrupted
        // before waitUntil starts; it never retries a Telegram send attempt.
        await this.ctx.storage.setAlarm(Math.max(now+1,deadline));
        this.ctx.waitUntil(this.processUpdate(input.updateId));
      }
      return safeJSON({ok:true,duplicate:!accepted.accepted});
    }catch{return safeJSON({ok:false,code:'INBOX_UNAVAILABLE'},503);}
  }

  processUpdate(id) {
    if(this.activeUpdates.has(id))return this.activeUpdates.get(id);
    const operation=this.processOnce(id);
    this.activeUpdates.set(id,operation);
    operation.finally(()=>this.activeUpdates.delete(id)).catch(()=>{});
    return operation;
  }

  async processOnce(id) {
    const record=this.store.claimUpdate(id);
    if(!record)return;
    let result;
    try {result=await this.engine().sync({deadlineAt:record.deadlineAt});}
    catch {result={status:'FAILED',code:'CONFIGURATION_INVALID'};}
    if(!this.store.claimReply(id))return;
    try {
      const reply=await sendReply(this.env,record.chatId,summaryReply(result,this.env.GOOGLE_SPREADSHEET_ID),{
        signal:AbortSignal.timeout(10000)});
      this.store.finishUpdate(id,'SENT',{messageId:reply.messageId,result});
    }catch(error){
      const known=error instanceof TelegramError;
      this.store.finishUpdate(id,known&&!error.ambiguous?'FAILED':'UNCERTAIN',{
        code:known?error.code:'TELEGRAM_DELIVERY_UNKNOWN',result});
    }
  }

  async alarm() {
    await this.ready;
    try {
      // Resume only persisted PENDING work. Never retry SENDING/UNCERTAIN.
      await Promise.all(this.store.pending(20).map(r=>this.processUpdate(r.updateId)));
      const deadline=this.store.pendingDeadline({pendingOnly:true});
      if(deadline!==null)await this.ctx.storage.setAlarm(Math.max(Date.now()+1,deadline));
    }catch{
      // DO platform alarm retries must not become an implicit network retry.
      console.log(JSON.stringify({kind:'SHEETS_INBOX_RECOVERY',status:'FAILED',code:'INBOX_RECOVERY_FAILED',...safety}));
    }
  }
}
