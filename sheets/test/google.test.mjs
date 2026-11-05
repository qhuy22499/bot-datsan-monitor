import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleSheets, GoogleError, HEADER_ROW_INDEX} from '../src/google.mjs';

// The only RSA private key used by tests is ephemeral and generated in RAM.
const key = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
const delimiter = action => [`-----${action}`, 'PRIVATE KEY-----'].join(' ');
const pem = `${delimiter('BEGIN')}\n${btoa(String.fromCharCode(...der))}\n${delimiter('END')}\n`;
const account = {type: 'service_account', client_email: 'test-only@example.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token', private_key_id: 'generated-test-key', private_key: pem};
const spreadsheetId = 'unit_test_spreadsheet_only_not_real';
const access = 'unit-test-access-token-not-real';
const now = Date.parse('2026-11-05T00:10:00Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), {status,
  headers: {'Content-Type': 'application/json'}});
const document = (rows = [['previous title'], ['old value']], override = {}) => ({spreadsheetId, sheets: [{
  properties: {sheetId: 12, title: 'AVAILABLE', gridProperties: {rowCount: 1000, columnCount: 26}},
  data: [{rowData: rows.map(row => ({values: row.map(stringValue => ({userEnteredValue: {stringValue}}))}))}],
  ...override,
}]});
const values = () => [['Bot DatSan — Danh sách sân trống'], ['D1'], ['Observed'], ['Updated'],
  ['Range'], ['Count'], ['Warning'], [], ['Thứ', 'Ngày', 'Sân', 'Khung giờ', 'Ưu tiên'],
  ['T2', '16/11/2026', 'A', '20:30–22:30', 'Ưu tiên 1']];
const replaceArgs = () => ({sheetId: 12, rowCount: 1000, columnCount: 26, values: values()});

function fixture(handler, options = {}) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({url: String(url), ...init});
    if (String(url) === account.token_uri) return json({access_token: access, token_type: 'Bearer', expires_in: 3600});
    if (handler) return handler(String(url), init, requests);
    if (init.method === 'GET') return json(document());
    const body = JSON.parse(init.body);
    return json({spreadsheetId, replies: body.requests.map(() => ({}))});
  };
  return {adapter: new GoogleSheets({serviceAccountJson: JSON.stringify(account), spreadsheetId,
    fetcher, clock: () => now, ...options}), requests};
}
const rejectsCode = (promise, code, ambiguous = false, httpStatus = null) => assert.rejects(promise, error => {
  assert.ok(error instanceof GoogleError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.ambiguous, ambiguous);
  assert.equal(error.httpStatus, httpStatus);
  assert.equal(error.stack.includes(access), false);
  assert.equal(JSON.stringify(error).includes('PRIVATE KEY'), false);
  return true;
});

test('RS256 JWT requests only Sheets scope from fixed OAuth endpoint; credential stays private', async () => {
  const {adapter, requests} = fixture();
  await adapter.readTab();
  const auth = requests[0];
  assert.equal(auth.url, 'https://oauth2.googleapis.com/token');
  assert.equal(auth.redirect, 'manual');
  assert.equal(auth.headers.Authorization, undefined);
  const form = new URLSearchParams(auth.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, body, signature] = form.get('assertion').split('.');
  const decode = text => JSON.parse(Buffer.from(text, 'base64url').toString());
  assert.deepEqual(decode(header), {alg: 'RS256', typ: 'JWT', kid: 'generated-test-key'});
  assert.deepEqual(decode(body), {iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets', aud: account.token_uri,
    iat: now / 1000, exp: now / 1000 + 3600});
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${body}`)), true);
  assert.deepEqual(Object.keys(adapter), []);
  assert.equal(JSON.stringify(adapter).includes('private_key'), false);
});

test('configuration rejects arbitrary token hosts, key shape, spreadsheet paths without fetching', () => {
  for (const changes of [{token_uri: 'https://attacker.example/token'}, {type: 'authorized_user'},
    {client_email: 'attacker@example.com'}, {universe_domain: 'attacker.example'}, {private_key: 'not-pem'}]) {
    assert.throws(() => new GoogleSheets({serviceAccountJson: JSON.stringify({...account, ...changes}),
      spreadsheetId}), {code: 'GOOGLE_CONFIG_INVALID'});
  }
  for (const id of ['../different-file', 'https://attacker.example/id', '', 'x?query=escape']) {
    assert.throws(() => new GoogleSheets({serviceAccountJson: JSON.stringify(account), spreadsheetId: id}),
      {code: 'GOOGLE_CONFIG_INVALID'});
  }
});

test('read existing AVAILABLE tab only, exact file, restricted grid fields and padded values', async () => {
  const {adapter, requests} = fixture();
  assert.deepEqual(await adapter.readTab(), {sheetId: 12, rowCount: 1000, columnCount: 26,
    title: 'AVAILABLE', values: [['previous title', '', '', '', ''], ['old value', '', '', '', '']]});
  const request = requests[1];
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://sheets.googleapis.com');
  assert.equal(url.pathname, `/v4/spreadsheets/${spreadsheetId}`);
  assert.equal(url.searchParams.get('ranges'), "'AVAILABLE'!A:E");
  assert.ok(url.searchParams.get('fields').includes('userEnteredValue'));
  assert.equal(request.headers.Authorization, `Bearer ${access}`);
  assert.equal(request.redirect, 'manual');
  assert.equal(requests.length, 2);
});

test('missing, ambiguous, renamed or malformed tab is rejected, never creates a tab', async () => {
  const cases = [{spreadsheetId, sheets: []}, {spreadsheetId, sheets: [document().sheets[0], document().sheets[0]]},
    document([], {properties: {...document().sheets[0].properties, title: 'ALL_SLOTS'}}),
    document([], {data: [{startRow: 3, rowData: []}]}), {spreadsheetId: 'different-file', sheets: []}];
  for (const response of cases) {
    const {adapter, requests} = fixture(() => json(response));
    await rejectsCode(adapter.readTab(), 'GOOGLE_TAB_INVALID');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, 'GET');
  }
});

test('REPLACE is one atomic batch, clears old A:E rows, preserves tab and unrelated formats', async () => {
  const {adapter, requests} = fixture();
  assert.deepEqual(await adapter.replaceTab(replaceArgs()), {status: 'UPDATED', updatedCells: 50});
  assert.equal(requests.length, 2);
  const request = requests[1];
  assert.equal(request.url, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`);
  const body = JSON.parse(request.body);
  const update = body.requests.find(item => item.updateCells).updateCells;
  assert.deepEqual(update.range, {sheetId: 12, startRowIndex: 0, endRowIndex: 1000,
    startColumnIndex: 0, endColumnIndex: 5});
  assert.equal(update.fields, 'userEnteredValue');
  assert.equal(update.rows.length, 10);
  assert.equal(body.includeSpreadsheetInResponse, false);
  assert.equal(body.requests.some(item => item.deleteSheet || item.addSheet || item.deleteDimension || item.appendCells), false);
  for (const item of body.requests) assert.equal(JSON.stringify(item).includes('ALL_SLOTS'), false);
  const frozen = body.requests.find(item => item.updateSheetProperties).updateSheetProperties;
  assert.equal(frozen.properties.gridProperties.frozenRowCount, HEADER_ROW_INDEX + 1);
  const filter = body.requests.find(item => item.setBasicFilter).setBasicFilter.filter.range;
  assert.equal(filter.startRowIndex, HEADER_ROW_INDEX);
  assert.equal(filter.endRowIndex, 10);
  for (const item of body.requests.filter(item => item.repeatCell)) {
    assert.notEqual(item.repeatCell.fields, 'userEnteredFormat');
    assert.equal(item.repeatCell.fields.includes('numberFormat'), false);
    assert.equal(item.repeatCell.fields.includes('borders'), false);
  }
});

test('zero slots clears former rows and retains title/header; no append or tab deletion', async () => {
  const {adapter, requests} = fixture();
  await adapter.replaceTab({...replaceArgs(), values: values().slice(0, 9)});
  const requestsBody = JSON.parse(requests[1].body).requests;
  const change = requestsBody.find(item => item.updateCells).updateCells;
  assert.equal(change.rows.length, 9);
  assert.equal(change.range.endRowIndex, 1000);
  assert.equal(change.fields, 'userEnteredValue');
  assert.equal(requestsBody.find(item => item.setBasicFilter).setBasicFilter.filter.range.endRowIndex, 9);
});

test('growing beyond current grid expands rows inside the same atomic batch', async () => {
  const {adapter, requests} = fixture();
  await adapter.replaceTab({...replaceArgs(), rowCount: 9});
  const body = JSON.parse(requests[1].body);
  assert.deepEqual(body.requests[0], {updateSheetProperties: {
    properties: {sheetId: 12, gridProperties: {rowCount: 10}}, fields: 'gridProperties.rowCount'}});
  assert.equal(body.requests[1].updateCells.range.endRowIndex, 10);
});

test('all values are literal stringValue, including formula-looking input and Vietnamese weekdays', async () => {
  const {adapter, requests} = fixture();
  const input = values();
  input[9] = ['CN', '08/11/2026', 'B', '=IMPORTXML("https://invalid.example")', '+not-a-formula'];
  await adapter.replaceTab({...replaceArgs(), values: input});
  const cellValues = JSON.parse(requests[1].body).requests.find(item => item.updateCells).updateCells.rows[9].values;
  assert.deepEqual(cellValues.map(item => item.userEnteredValue.stringValue), input[9]);
  assert.equal(JSON.stringify(cellValues).includes('formulaValue'), false);
});

test('invalid write dimensions or values fail before OAuth and before Google writes', async () => {
  for (const args of [{sheetId: -1}, {rowCount: 0}, {columnCount: 4}, {values: []},
    {values: [['formula'], ...values(), [1]]}, {values: [...values(), ['a', 'b', 'c', 'd', 'e', 'f']]}]) {
    const {adapter, requests} = fixture();
    await rejectsCode(adapter.replaceTab({...replaceArgs(), ...args}), 'GOOGLE_VALUES_INVALID');
    assert.equal(requests.length, 0);
  }
});

test('token cached privately and refreshed near expiry without storing credentials anywhere', async () => {
  let clock = now;
  const {adapter, requests} = fixture(null, {clock: () => clock});
  await adapter.readTab();
  await adapter.readTab();
  assert.equal(requests.filter(item => item.url === account.token_uri).length, 1);
  clock += 3600000;
  await adapter.readTab();
  assert.equal(requests.filter(item => item.url === account.token_uri).length, 2);
});

test('403/429 are definite rejection; 408/5xx write outcomes remain UNCERTAIN without retry', async () => {
  for (const status of [400, 401, 403, 429, 408, 500, 503]) {
    const {adapter, requests} = fixture(() => json({error: {message: access + pem}}, status));
    await rejectsCode(adapter.replaceTab(replaceArgs()), 'GOOGLE_API_REJECTED',
      status === 408 || status >= 500, status);
    assert.equal(requests.length, 2);
  }
});

test('Google redirects never forward bearer credentials, writes do not retry', async () => {
  const {adapter, requests} = fixture(() => new Response(null, {status: 302,
    headers: {Location: 'https://attacker.example'}}));
  await rejectsCode(adapter.replaceTab(replaceArgs()), 'GOOGLE_API_REJECTED', false, 302);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].redirect, 'manual');
  assert.ok(requests.every(item => !item.url.includes('attacker.example')));
});

test('lost write response and malformed success stay UNCERTAIN, reads are ordinary failure', async () => {
  for (const handler of [() => {throw new Error(`network failed ${access}`);},
    () => new Response('invalid'), () => json({spreadsheetId, replies: []})]) {
    const {adapter, requests} = fixture(handler);
    await assert.rejects(adapter.replaceTab(replaceArgs()), error => {
      assert.ok(error instanceof GoogleError);
      assert.equal(error.ambiguous, true);
      assert.equal(error.message.includes(access), false);
      return true;
    });
    assert.equal(requests.length, 2);
  }
  const {adapter} = fixture(() => {throw new Error(`failed ${access}`);});
  await rejectsCode(adapter.readTab(), 'GOOGLE_API_UNAVAILABLE');
});

test('pre-cancelled work never starts OAuth or Sheets request', async () => {
  const controller = new AbortController();
  controller.abort();
  const {adapter, requests} = fixture();
  await rejectsCode(adapter.replaceTab({...replaceArgs(), signal: controller.signal}), 'GOOGLE_TIMEOUT');
  assert.equal(requests.length, 0);
});

test('aborted in-flight Google write stays UNCERTAIN and returns without awaiting network forever', async () => {
  const controller = new AbortController();
  const {adapter, requests} = fixture(() => {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  });
  await rejectsCode(adapter.replaceTab({...replaceArgs(), signal: controller.signal}), 'GOOGLE_TIMEOUT', true);
  assert.equal(requests.length, 2);
});

test('aborted response body is bounded and does not expose body content', async () => {
  const controller = new AbortController();
  const {adapter} = fixture(() => {
    const body = new ReadableStream({start(stream) {
      stream.enqueue(new TextEncoder().encode('{"private":"not-finished'));
      queueMicrotask(() => controller.abort());
    }});
    return new Response(body);
  });
  await rejectsCode(adapter.readTab({signal: controller.signal}), 'GOOGLE_TIMEOUT');
});

test('auth failure and malformed OAuth response are safe definite failures before any Sheets write', async () => {
  for (const response of [() => json({error_description: access + pem}, 403),
    () => json({access_token: 'short', expires_in: 3600, token_type: 'Bearer'})]) {
    const calls = [];
    const {adapter} = fixture(null, {fetcher: async url => {calls.push(url); return response();}});
    await assert.rejects(adapter.replaceTab(replaceArgs()), error => {
      assert.ok(error instanceof GoogleError);
      assert.equal(error.ambiguous, false);
      assert.equal(error.message.includes(access), false);
      assert.equal(error.message.includes('PRIVATE KEY'), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('unexpected successful HTTP status on a write is UNCERTAIN, never retried', async () => {
  for (const status of [201,202,204]) {
    let calls=0;
    const {adapter}=fixture(()=>{calls++;return new Response(null,{status});});
    await rejectsCode(adapter.replaceTab(replaceArgs()),'GOOGLE_API_REJECTED',true,status);
    assert.equal(calls,1);
  }
});

test('Workers native-style fetch is invoked without the adapter as receiver', async () => {
  const calls=[];
  const fetcher=async function(url,init){
    assert.equal(this,undefined,'native Workers fetch rejects a foreign receiver');
    calls.push(String(url));
    if(String(url)===account.token_uri)return json({access_token:access,token_type:'Bearer',expires_in:3600});
    if(init.method==='GET')return json(document());
    return json({spreadsheetId,replies:JSON.parse(init.body).requests.map(()=>({}))});
  };
  const {adapter}=fixture(null,{fetcher});
  await adapter.readTab();
  assert.equal((await adapter.replaceTab(replaceArgs())).status,'UPDATED');
  assert.equal(calls.length,3);
});
