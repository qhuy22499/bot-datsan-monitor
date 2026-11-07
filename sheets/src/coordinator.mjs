import {GoogleError} from './google.mjs';
import {projectAvailability} from './read-model.mjs';

export const SYNC_BUDGET_MS = 15000;
const JST_OFFSET = 9 * 3600000;

export function jstStamp(ms) {
  const value = new Date(ms + JST_OFFSET).toISOString();
  return `${value.slice(8,10)}/${value.slice(5,7)}/${value.slice(0,4)} ${value.slice(11,19)} JST`;
}

export function sheetValues(data, updatedAt) {
  const warnings = [
    data.stale ? '⚠ Dữ liệu đã cũ hơn 5 phút. Kiểm tra website trước khi đặt.' : 'Dữ liệu còn mới (không quá 5 phút).',
    data.sourceWarning ? 'Lượt quét gần nhất chưa cung cấp dữ liệu mới đầy đủ; đang dùng COMPLETE đã xác minh.' : '',
    data.calendarWarning ? 'Chưa đủ lịch lễ để xác định mọi mức ưu tiên.' : '',
  ].filter(Boolean).join(' ');
  const date = iso => `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`;
  return [
    ['Bot DatSan — Danh sách sân trống'],
    ['Nguồn', 'Cloudflare D1 / 小菅西フットサル場'],
    ['Quan sát website (JST)', jstStamp(Date.parse(data.observedAt))],
    ['Cập nhật Google Sheets (JST)', updatedAt],
    ['Phạm vi COMPLETE', `${date(data.windowStart)} → ${date(data.windowEnd)}`],
    ['Tổng số slot AVAILABLE', String(data.total)],
    ['Trạng thái dữ liệu', warnings], [],
    ['Thứ', 'Ngày', 'Sân', 'Khung giờ', 'Ưu tiên'],
    ...data.rows.map(r => [r.weekday, r.date, r.court, `${r.start}–${r.end}`, r.priority]),
  ];
}

export function normalizeValues(values) {
  const rows = values.map(row => Array.from({length:5},(_,i)=>String(row[i] ?? '')));
  while (rows.length && rows.at(-1).every(v=>!v)) rows.pop();
  return rows;
}
const fingerprint = values => JSON.stringify(normalizeValues(values));
const semantic = values => fingerprint(values.map((row,i)=>i===3 ? ['Cập nhật Google Sheets (JST)', ''] : row));
const failure = (code,status='FAILED',data={}) => ({status,code,...data});
const metadata = data => ({total:data.total, observedAt:data.observedAt, stale:data.stale,
  sourceWarning:data.sourceWarning, updatedAt:null});

async function stage(promise,signal,{write=false}={}) {
  let listener;
  const interrupted=new Promise((_,reject)=>{
    listener=()=>reject(new GoogleError('GOOGLE_TIMEOUT',{ambiguous:write}));
    if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});
  });
  try{return await Promise.race([promise,interrupted]);}
  finally{signal.removeEventListener('abort',listener);}
}

function bounded(promise, deadlineAt, clock) {
  const ms = deadlineAt-clock();
  if (ms<=0) return Promise.resolve(failure('SYNC_TIMEOUT','TIMEOUT'));
  let timer;
  const expired = new Promise(resolve=>{timer=setTimeout(()=>resolve(failure('SYNC_TIMEOUT','TIMEOUT')),ms);});
  return Promise.race([promise,expired]).finally(()=>clearTimeout(timer));
}

// This class is ONLY instantiated inside one named Durable Object. The promise
// coalesces callers within that globally unique object; durable WRITING state
// protects against restart/eviction. It is not a stand-alone memory lock.
export class SyncCoordinator {
  constructor({store, readSource, google, clock=Date.now, render=sheetValues, project=projectAvailability}) {
    this.store=store;this.readSource=readSource;this.google=google;this.clock=clock;
    this.inFlight=null;this.render=render;this.project=project;
  }

  sync({deadlineAt=this.clock()+SYNC_BUDGET_MS}={}) {
    if (deadlineAt<=this.clock()) return Promise.resolve(failure('SYNC_TIMEOUT','TIMEOUT'));
    if (!this.inFlight) {
      const operation=this.perform(deadlineAt);
      this.inFlight=operation;
      operation.finally(()=>{if(this.inFlight===operation)this.inFlight=null;this.render=render;this.project=project;}).catch(()=>{});
    }
    return bounded(this.inFlight,deadlineAt,this.clock);
  }

  async perform(deadlineAt) {
    let data, writeAttempted=false;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,deadlineAt-this.clock()));
    const check=()=>{
      if(controller.signal.aborted || this.clock()>=deadlineAt)throw new GoogleError('GOOGLE_TIMEOUT');
    };
    try {
      // Failure here must leave the existing spreadsheet and sync receipt intact.
      data=await stage(this.readSource(),controller.signal);check();
      const tab=await stage(this.google.readTab({signal:controller.signal}),controller.signal);check();
      // Time can advance while Google is read: re-filter begun slots/staleness
      // even when scan_id did not change. This never rereads the website.
      if(data.snapshot)data=this.project(data.snapshot,this.clock());
      const view=metadata(data);
      const previous=this.store.readSync();
      if (['WRITING','UNCERTAIN'].includes(previous.phase)) {
        if (!Array.isArray(previous.attemptedValues)
            || fingerprint(tab.values)!==fingerprint(previous.attemptedValues))
          return failure('GOOGLE_WRITE_UNRESOLVED','UNCERTAIN',view);
        // A read-back matches the ENTIRE attempted replacement, including timestamp.
        // Only now may a future replacement proceed; never blindly repeat a write.
        this.store.writeSync({phase:'IDLE',lastSuccessAt:previous.updatedAt,
          lastContentKey:semantic(tab.values),reconciled:true});
      }
      const updatedAt=jstStamp(this.clock());
      const values=this.render(data,updatedAt);
      if (semantic(tab.values)===semantic(values)) {
        const confirmedAt=tab.values[3]?.[1] || null;
        this.store.writeSync({phase:'IDLE',lastSuccessAt:confirmedAt,lastContentKey:semantic(values)});
        return {status:'SKIPPED',...view,updatedAt:confirmedAt};
      }
      check();
      // Durable write-ahead intent BEFORE issuing the sole atomic Google write.
      this.store.writeSync({phase:'WRITING',attemptedValues:values,
        attemptedKey:semantic(values),updatedAt});
      writeAttempted=true;
      await stage(this.google.replaceTab({...tab,values,signal:controller.signal}),controller.signal,{write:true});
      // Even if the 15-second waiter timed out, a confirmed response can be
      // persisted safely. It is never converted into another Google write.
      this.store.writeSync({phase:'IDLE',lastSuccessAt:updatedAt,lastContentKey:semantic(values)});
      return {status:'UPDATED',...view,updatedAt};
    } catch(error) {
      const isGoogle=error instanceof GoogleError;
      const code=isGoogle ? error.code : (
        typeof error?.code==='string' && /^[A-Z0-9_]{3,60}$/.test(error.code) ? error.code : 'SYNC_FAILED');
      if (writeAttempted) {
        // A lost receipt/unknown exception after write intent is ambiguous too.
        const uncertain=!isGoogle || error.ambiguous;
        const previous=this.store.readSync();
        this.store.writeSync({...previous,phase:uncertain?'UNCERTAIN':'FAILED',code});
        return failure(code,uncertain?'UNCERTAIN':'FAILED',data?metadata(data):{});
      }
      return failure(code,isGoogle&&error.ambiguous?'UNCERTAIN':code==='GOOGLE_TIMEOUT'?'TIMEOUT':'FAILED',data?metadata(data):{});
    } finally {clearTimeout(timer);}
  }
}
