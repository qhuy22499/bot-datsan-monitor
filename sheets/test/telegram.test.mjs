import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWebhook, summaryReply, priorityMessage, sendReply, WebhookError, TelegramError} from '../src/telegram.mjs';

const secret = 'webhook_secret_for_unit_tests_only_123456';
const token = `123456789:${'unit_test_only_'.repeat(3)}`;
const chatId = '-1001234567890';
const spreadsheetId = 'unit_test_spreadsheet_only_not_real';
const env = {TG_WEBHOOK_SECRET: secret, TELEGRAM_TEST_CHAT_ID: chatId,
  TELEGRAM_BOT_USERNAME: 'BotDatSan_test_bot', TELEGRAM_BOT_TOKEN: token};
const update = (text = '/available', overrides = {}) => ({update_id: 12345, message: {
  message_id: 8, chat: {id: Number(chatId), type: 'supergroup'},
  from: {id: 777, is_bot: false, first_name: 'not-persisted'}, text,
  ...overrides,
}});
const request = (body = update(), headers = {}, options = {}) => new Request('https://worker.invalid/telegram', {
  method: 'POST', headers: {'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json', ...headers},
  body: JSON.stringify(body), ...options,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {status,
  headers: {'Content-Type': 'application/json'}});
const confirmed = () => json({ok: true, result: {message_id: 55, chat: {id: Number(chatId)}}});
const errorCode = (Class, code, options = {}) => error => {
  assert.ok(error instanceof Class);
  assert.equal(error.message, code);
  assert.equal(error.code, code);
  for (const [name, value] of Object.entries(options)) assert.equal(error[name], value);
  assert.equal(JSON.stringify(error).includes(token), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
  return true;
};

test('valid TEST group command accepts every member and stores only update/chat routing IDs', async () => {
  assert.deepEqual(await parseWebhook(request(), env), {updateId: 12345, chatId, command:'available'});
  assert.deepEqual(await parseWebhook(request(update('/available', {from: {id: 999, is_bot: false}})), env),
    {updateId: 12345, chatId, command:'available'});
  assert.deepEqual(await parseWebhook(request(update('/available@bOtDaTsAn_TeSt_BoT')), env),
    {updateId: 12345, chatId, command:'available'});
  assert.deepEqual(await parseWebhook(request(update('  /available  ')), env), {updateId: 12345, chatId, command:'available'});
});

test('replayed valid payload normalizes to same persistent dedup key without generating identity', async () => {
  const first = await parseWebhook(request(), env);
  const repeated = await parseWebhook(request(), env);
  assert.deepEqual(repeated, first);
  assert.deepEqual(Object.keys(first), ['updateId', 'chatId', 'command']);
  assert.equal(JSON.stringify(first).includes('777'), false);
  assert.equal(JSON.stringify(first).includes('not-persisted'), false);
});

test('wrong/missing webhook secret is rejected before body parsing or command routing', async () => {
  for (const supplied of ['', 'wrong_but_well_formed_1234567890123456', 'contains spaces', secret + 'x']) {
    const input = new Request('https://worker.invalid/telegram', {method: 'POST',
      headers: {'X-Telegram-Bot-Api-Secret-Token': supplied}, body: 'not-json'});
    await assert.rejects(parseWebhook(input, env), errorCode(WebhookError, 'WEBHOOK_AUTH_REJECTED', {httpStatus: 403}));
  }
});

test('configuration guard requires strong secret, negative numeric TEST chat and explicit bot username', async () => {
  for (const overrides of [{TG_WEBHOOK_SECRET: 'short'}, {TG_WEBHOOK_SECRET: 'x'.repeat(257)},
    {TG_WEBHOOK_SECRET: 'contains invalid characters '.repeat(3)}, {TELEGRAM_TEST_CHAT_ID: '100123'},
    {TELEGRAM_TEST_CHAT_ID: '@publicchannel'}, {TELEGRAM_TEST_CHAT_ID: '-9007199254740992'},
    {TELEGRAM_BOT_USERNAME: ''}]) {
    await assert.rejects(parseWebhook(request(), {...env, ...overrides}), error => {
      assert.ok(error instanceof WebhookError);
      assert.equal(error.httpStatus, 503);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('other chat, private chat, channel and string chat IDs are rejected', async () => {
  for (const chat of [{id: -1009876543210, type: 'supergroup'}, {id: 777, type: 'private'},
    {id: Number(chatId), type: 'channel'}, {id: chatId, type: 'supergroup'}]) {
    await assert.rejects(parseWebhook(request(update('/available', {chat})), env),
      errorCode(WebhookError, 'WEBHOOK_CHAT_REJECTED', {httpStatus: 403}));
  }
});

test('unrecognized command, target another bot, bot sender, edited update and callback are ignored', async () => {
  for (const body of [update('/available@Another_bot'), update('/available argument'), update('/AVAILABLE'),
    update('/start'), update('/available', {from: {is_bot: true}}),
    {update_id: 123, edited_message: update().message}, {update_id: 123, callback_query: {id: 'opaque'}}]) {
    assert.equal(await parseWebhook(request(body), env), null);
  }
});

test('malformed JSON/update, excess declared/body bytes and invalid UTF8 are rejected safely', async () => {
  for (const body of ['invalid', '[]', '{}', '{"update_id":-1}', '{"update_id":"1"}']) {
    const input = request({}, {}, {body});
    await assert.rejects(parseWebhook(input, env), error => {
      assert.ok(error instanceof WebhookError);
      assert.equal(error.httpStatus, 400);
      return true;
    });
  }
  for (const input of [request(update(), {'Content-Length': '32769'}),
    request(update('/available', {padding: 'x'.repeat(32768)})),
    request({}, {}, {body: new Uint8Array([0xff, 0xfe])})]) {
    await assert.rejects(parseWebhook(input, env), error => {
      assert.ok(error instanceof WebhookError);
      assert.equal(error.httpStatus, 400);
      return true;
    });
  }
  await assert.rejects(parseWebhook(new Request('https://worker.invalid/telegram'), env),
    errorCode(WebhookError, 'WEBHOOK_METHOD_NOT_ALLOWED', {httpStatus: 405}));
});

test('updated reply is short, uses JST observation separately from sync, contains link not slot list', () => {
  const text = summaryReply({status: 'UPDATED', total: 33, observedAt: '2026-11-05T10:37:00Z',
    updatedAt: '2026-11-05T10:50:00Z', stale: true,
    slots: Array.from({length: 100}, () => ({private: 'must-not-render'}))}, spreadsheetId);
  assert.ok(text.includes('Tổng cộng: 33 slot AVAILABLE'));
  assert.ok(text.includes('Quan sát: 05/11/2026 19:37 JST'));
  assert.ok(text.includes('Google Sheets: Đã cập nhật 05/11/2026 19:50 JST'));
  assert.ok(text.includes('Dữ liệu đã cũ hơn 5 phút'));
  assert.ok(text.includes(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`));
  assert.ok(text.length < 1200);
  assert.equal(text.includes('must-not-render'), false);
  assert.equal(text.includes(chatId), false);
  assert.equal(text.includes('đặt sân thành công'), false);
});

test('valid zero is distinguishable from source failure with unverified total', () => {
  const zero = summaryReply({status: 'UPDATED', total: 0, stale: false,
    observedAt: '2026-11-05T15:01:00Z', updatedAt: '06/11/2026 00:02 JST'}, spreadsheetId);
  assert.ok(zero.includes('Tổng cộng: 0 slot AVAILABLE'));
  assert.ok(zero.includes('06/11/2026 00:01 JST'));
  assert.ok(zero.includes('Dữ liệu nguồn còn mới trong 5 phút'));
  const failure = summaryReply({status: 'FAILED'}, spreadsheetId);
  assert.ok(failure.includes('Tổng số slot: Chưa thể xác minh'));
  assert.equal(failure.includes('Tổng cộng: 0'), false);
  assert.equal(failure.includes('Đã cập nhật'), false);
});

test('FAILED/UNCERTAIN/TIMEOUT always warn, never imply confirmed Sheets update or booking', () => {
  for (const status of ['FAILED', 'UNCERTAIN', 'TIMEOUT']) {
    const text = summaryReply({status, total: 33, observedAt: '2026-11-05T10:37:00Z', stale: true}, spreadsheetId);
    assert.ok(text.includes('⚠️ Không thể xác nhận cập nhật Google Sheets.'));
    assert.ok(text.includes('Bạn vẫn có thể mở bản dữ liệu trước đó'));
    assert.ok(text.includes('Dữ liệu trên Sheets có thể đã cũ.'));
    assert.equal(text.includes('Đã cập nhật'), false);
    assert.equal(text.includes('đặt thành công'), false);
  }
  const skipped = summaryReply({status: 'SKIPPED', total: 7, stale: false,
    updatedAt: '05/11/2026 19:37:07 JST', sourceWarning: 'LATEST_SCAN_FAILED'}, spreadsheetId);
  assert.ok(skipped.includes('Không cần ghi lại'));
  assert.ok(skipped.includes('COMPLETE đã xác minh'));
  assert.equal(skipped.includes('LATEST_SCAN_FAILED'), false);
});

test('Telegram send returns a confirmed message receipt and never adds a keyboard or parse mode', async () => {
  const calls = [];
  const result = await sendReply(env, chatId, 'Short summary', {fetcher: async (url, options) => {
    calls.push({url, ...options}); return confirmed();
  }});
  assert.deepEqual(result, {messageId: 55});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].body), {chat_id: chatId, text: 'Short summary',
    link_preview_options: {is_disabled: true}});
});

test('destination/token/text/pre-aborted guard blocks before any send', async () => {
  let calls = 0;
  const fetcher = async () => {calls += 1; return confirmed();};
  await assert.rejects(sendReply(env, '-10099999999', 'test', {fetcher}),
    errorCode(TelegramError, 'TELEGRAM_DESTINATION_REJECTED', {ambiguous: false}));
  await assert.rejects(sendReply({...env, TELEGRAM_BOT_TOKEN: 'invalid'}, chatId, 'test', {fetcher}),
    errorCode(TelegramError, 'TELEGRAM_TOKEN_CONFIG_INVALID', {ambiguous: false}));
  await assert.rejects(sendReply(env, chatId, 'x'.repeat(4097), {fetcher}),
    errorCode(TelegramError, 'TELEGRAM_TEXT_INVALID', {ambiguous: false}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sendReply(env, chatId, 'test', {fetcher, signal: controller.signal}),
    errorCode(TelegramError, 'TELEGRAM_SEND_CANCELLED', {ambiguous: false}));
  assert.equal(calls, 0);
});

test('Telegram 4xx is definite, 5xx/408 uncertain, error descriptions and token URLs never leak', async () => {
  for (const status of [400, 401, 403, 429, 408, 500, 502, 503]) {
    let calls = 0;
    await assert.rejects(sendReply(env, chatId, 'test', {fetcher: async () => {
      calls += 1;
      return json({ok: false, error_code: status, description: token + secret}, status);
    }}), errorCode(TelegramError, 'TELEGRAM_SEND_REJECTED', {
      ambiguous: status >= 500 || status === 408, httpStatus: status,
    }));
    assert.equal(calls, 1);
  }
});

test('malformed, missing/wrong-chat receipt or lost response remains UNCERTAIN without retry', async () => {
  for (const response of [() => new Response('not-json'), () => json({ok: true}),
    () => json({ok: true, result: {message_id: 0, chat: {id: Number(chatId)}}}),
    () => json({ok: true, result: {message_id: 55, chat: {id: -1009999}}}),
    () => {throw new Error(`lost response https://api.telegram.org/bot${token}/sendMessage`);}]) {
    let calls = 0;
    await assert.rejects(sendReply(env, chatId, 'test', {fetcher: async () => {calls += 1; return response();}}),
      errorCode(TelegramError, 'TELEGRAM_SEND_UNCONFIRMED', {ambiguous: true}));
    assert.equal(calls, 1);
  }
});

test('Telegram redirect does not forward token and API ok:false rejection is recorded safely', async () => {
  let calls = 0;
  await assert.rejects(sendReply(env, chatId, 'test', {fetcher: async (_, options) => {
    calls += 1; assert.equal(options.redirect, 'manual');
    return new Response(null, {status: 302, headers: {Location: 'https://attacker.invalid'}});
  }}), errorCode(TelegramError, 'TELEGRAM_SEND_REJECTED', {ambiguous: false, httpStatus: 302}));
  assert.equal(calls, 1);
  await assert.rejects(sendReply(env, chatId, 'test', {fetcher: async () =>
    json({ok: false, error_code: 403, description: token})}),
  errorCode(TelegramError, 'TELEGRAM_SEND_REJECTED', {ambiguous: false, httpStatus: 403}));
});

test('cancelled send and stalled response body return UNCERTAIN without waiting indefinitely', async () => {
  for (const stalledBody of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(sendReply(env, chatId, 'test', {signal: controller.signal, fetcher: async () => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return stalledBody ? new Response(new ReadableStream({start(stream) {
        stream.enqueue(new TextEncoder().encode('{"ok":'));
      }})) : new Promise(() => {});
    }}), errorCode(TelegramError, 'TELEGRAM_SEND_TIMEOUT', {ambiguous: true}));
    assert.equal(calls, 1);
  }
});

test('unexpected successful HTTP status on send remains UNCERTAIN without resend', async () => {
  for (const status of [201,202,204]) {
    let calls=0;
    await assert.rejects(sendReply(env,chatId,'test',{fetcher:async()=>{
      calls++;return new Response(null,{status});
    }}),errorCode(TelegramError,'TELEGRAM_SEND_REJECTED',{ambiguous:true,httpStatus:status}));
    assert.equal(calls,1);
  }
});

test('priority command routes explicitly with the same group/secret/username guards', async () => {
  for (const text of ['/priority','/priority@BotDatSan_test_bot'])
    assert.deepEqual(await parseWebhook(request(update(text)),env),{updateId:12345,chatId,command:'priority'});
  for (const text of ['/priority@Another_bot','/priority extra','/PRIORITY'])
    assert.equal(await parseWebhook(request(update(text)),env),null);
  await assert.rejects(parseWebhook(request(update('/priority',{chat:{id:-9,type:'supergroup'}})),env),
    errorCode(WebhookError,'WEBHOOK_CHAT_REJECTED',{httpStatus:403}));
});

const priorityData = rows => ({status:'READ',rows,observedAt:'2026-11-05T19:00:00+09:00',stale:false});
const priorityRow = (priority,{day='2026-11-07',date='07/11/2026',weekday='T7',court='A',start='18:30',end='20:30'}={}) =>
  ({priority,day,date,weekday,court,start,end});

test('priority message groups all three categories, excludes ordinary hours and sorts each group',()=>{
  const message=priorityMessage(priorityData([
    priorityRow('Ưu tiên 1',{court:'B'}),priorityRow('Thông thường',{start:'08:00',end:'10:00'}),
    priorityRow('Chỉ thông báo',{start:'16:00',end:'18:00'}),
    priorityRow('Ưu tiên 2',{start:'20:30',end:'22:30'}),priorityRow('Ưu tiên 1'),
  ]),spreadsheetId);
  assert.equal(message.total,4);assert.equal(message.unverifiedTotal,0);assert.equal(message.shown,4);
  assert.match(message.text,/⭐ ƯU TIÊN 1 \(2\)/);assert.match(message.text,/⭐ ƯU TIÊN 2 \(1\)/);
  assert.match(message.text,/🔔 CHỈ THÔNG BÁO \(1\)/);assert.match(message.text,/T7 07\/11\/2026/);
  assert.ok(message.text.indexOf('Sân A · 18:30')<message.text.indexOf('Sân B · 18:30'));
  assert.doesNotMatch(message.text,/08:00|Thông thường|đặt sân thành công/);
});

test('trusted empty, unreadable D1 and missing holiday coverage remain different results',()=>{
  const empty=priorityMessage(priorityData([priorityRow('Thông thường')]),spreadsheetId);
  assert.equal(empty.total,0);assert.match(empty.text,/Hiện chưa có sân trống phù hợp/);
  const failed=priorityMessage({status:'FAILED',code:'D1_UNAVAILABLE'},spreadsheetId);
  assert.equal(failed.total,null);assert.doesNotMatch(failed.text,/Hiện chưa có|Tổng: 0/);
  const unknown=priorityMessage(priorityData([priorityRow('Chưa xác minh ngày lễ')]),spreadsheetId);
  assert.equal(unknown.total,0);assert.equal(unknown.unverifiedTotal,1);
  assert.match(unknown.text,/CẦN XÁC MINH NGÀY LỄ/);assert.match(unknown.text,/Sân A/);
  assert.doesNotMatch(unknown.text,/Hiện chưa có sân trống phù hợp/);
});

test('priority warns for stale data and prior COMPLETE after monitor failure without pretending a new scan',()=>{
  for(const sourceWarning of ['LATEST_SCAN_FAILED','LATEST_SCAN_PARTIAL']) {
    const message=priorityMessage({...priorityData([priorityRow('Ưu tiên 1')]),stale:true,sourceWarning},spreadsheetId);
    assert.match(message.text,/Quan sát: 05\/11\/2026 19:00 JST/);
    assert.match(message.text,/Dữ liệu đã cũ/);assert.match(message.text,/snapshot COMPLETE/);
    assert.match(message.text,/FAILED\/PARTIAL/);assert.equal(message.total,1);
  }
});

test('long priority list stays in one bounded message with every group count and Sheets fallback',()=>{
  const labels=['Ưu tiên 1','Ưu tiên 2','Chỉ thông báo','Chưa xác minh ngày lễ'];
  const rows=Array.from({length:600},(_,n)=>priorityRow(labels[n%4],{court:n%2?'B':'A'}));
  const message=priorityMessage({...priorityData(rows),stale:true,sourceWarning:'LATEST_SCAN_FAILED'},spreadsheetId);
  assert.ok(message.text.length<=4096);assert.equal(message.total,450);assert.equal(message.unverifiedTotal,150);
  assert.equal(message.truncated,true);assert.ok(message.shown>0 && message.shown<600);
  for(const heading of ['ƯU TIÊN 1','ƯU TIÊN 2','CHỈ THÔNG BÁO','CẦN XÁC MINH NGÀY LỄ'])
    assert.ok(message.text.includes(heading));
  assert.match(message.text,/Tổng: 450 khung giờ/);assert.match(message.text,/Danh sách rút gọn/);
  assert.ok(message.text.includes(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`));
});
