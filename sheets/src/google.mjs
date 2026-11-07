// Google credentials and access tokens remain private, in memory only.
// Contract: https://developers.google.com/identity/protocols/oauth2/service-account
// Atomic replace: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets/';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const HEADER_ROW_INDEX = 8;
const MAX_ROWS = 20000;
const MAX_RESPONSE_BYTES = 2000000;
// PEM delimiters are format syntax, not stored key material.
const PEM_BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const PEM_END = ['-----END', 'PRIVATE KEY-----'].join(' ');

export class GoogleError extends Error {
  constructor(code, {ambiguous = false, httpStatus = null} = {}) {
    super(code);
    this.name = 'GoogleError';
    this.code = code;
    this.ambiguous = ambiguous;
    this.httpStatus = httpStatus;
  }
}

const fail = (code, options) => new GoogleError(code, options);
const base64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Promise.race also bounds misbehaving network mocks/late response bodies. In
// production AbortController cancels the fetch; a timed-out write stays uncertain.
function deadline(external) {
  const controller = new AbortController();
  let timer;
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => { controller.abort(); reject(fail('GOOGLE_TIMEOUT')); };
    timer = setTimeout(listener, 15000);
    if (external?.aborted) listener();
    else external?.addEventListener('abort', listener, {once: true});
  });
  // A cancelled deadline can precede the first awaited operation.
  cancelled.catch(() => {});
  return {
    signal: controller.signal,
    run: promise => Promise.race([promise, cancelled]),
    close() {
      clearTimeout(timer);
      external?.removeEventListener('abort', listener);
    },
  };
}

async function limitedJSON(response, limit, guard) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw fail('GOOGLE_RESPONSE_INVALID');
  if (!response.body) throw fail('GOOGLE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      const {done, value} = await guard.run(reader.read());
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw fail('GOOGLE_RESPONSE_INVALID');
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!plain(parsed)) throw fail('GOOGLE_RESPONSE_INVALID');
    return parsed;
  } catch (error) {
    if (error instanceof GoogleError) throw error;
    throw fail('GOOGLE_RESPONSE_INVALID');
  } finally {
    // Do not wait for a stalled response stream during cancellation.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class GoogleSheets {
  #account;
  #spreadsheetId;
  #fetcher;
  #clock;
  #key;
  #token;
  #title;
  #header;
  #creation;

  constructor({serviceAccountJson, spreadsheetId, fetcher = globalThis.fetch, clock = Date.now, tabTitle="AVAILABLE", headerRowIndex=8, creationStore=null}) {
    try {
      if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length > 20000) throw 0;
      const account = JSON.parse(serviceAccountJson);
      if (!plain(account) || account.type !== 'service_account'
          || typeof account.client_email !== 'string'
          || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(account.client_email)
          || account.token_uri !== TOKEN_URL
          || (account.universe_domain && account.universe_domain !== 'googleapis.com')
          || typeof account.private_key !== 'string'
          || !account.private_key.startsWith(PEM_BEGIN + '\n')
          || !account.private_key.trimEnd().endsWith(PEM_END)
          || (account.private_key_id && !/^[A-Za-z0-9_-]{1,100}$/.test(account.private_key_id))
          || typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,150}$/.test(spreadsheetId)
          || typeof fetcher !== 'function' || typeof clock !== 'function') throw 0;
      if(!['AVAILABLE','BOOKED'].includes(tabTitle) || headerRowIndex!==(tabTitle==='BOOKED'?11:8)
          || (tabTitle==='BOOKED' && !creationStore))throw 0;
      this.#title=tabTitle;this.#header=headerRowIndex;this.#creation=creationStore;
      this.#account = account;
      this.#spreadsheetId = spreadsheetId;
      // Workers' native fetch rejects a GoogleSheets instance as its receiver.
      // Invoke the injected function as a standalone function, as on the web.
      this.#fetcher = (...args) => fetcher(...args);
      this.#clock = clock;
    } catch {
      throw fail('GOOGLE_CONFIG_INVALID');
    }
  }

  async #accessToken(guard) {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw fail('GOOGLE_CLOCK_INVALID');
    if (this.#token && this.#token.expires > now + 60000) return this.#token.value;
    try {
      if (!this.#key) {
        const pem = this.#account.private_key.replace(PEM_BEGIN, '')
          .replace(PEM_END, '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pem)) throw 0;
        const bytes = Uint8Array.from(atob(pem), character => character.charCodeAt(0));
        this.#key = await guard.run(crypto.subtle.importKey('pkcs8', bytes,
          {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']));
      }
      const iat = Math.floor(now / 1000);
      const header = {alg: 'RS256', typ: 'JWT'};
      if (this.#account.private_key_id) header.kid = this.#account.private_key_id;
      const claim = {iss: this.#account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600};
      const unsigned = `${encode(header)}.${encode(claim)}`;
      const signed = await guard.run(crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.#key,
        new TextEncoder().encode(unsigned)));
      const assertion = `${unsigned}.${base64url(new Uint8Array(signed))}`;
      const response = await guard.run(this.#fetcher(TOKEN_URL, {
        method: 'POST', redirect: 'manual', signal: guard.signal,
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}),
      }));
      if (response.status !== 200) {
        throw fail('GOOGLE_AUTH_REJECTED', {httpStatus: response.status});
      }
      const result = await limitedJSON(response, 16000, guard);
      if (typeof result.access_token !== 'string' || !/^[A-Za-z0-9._~-]{10,8192}$/.test(result.access_token)
          || result.token_type?.toLowerCase() !== 'bearer'
          || !Number.isSafeInteger(result.expires_in) || result.expires_in < 60 || result.expires_in > 3600) {
        throw fail('GOOGLE_AUTH_RESPONSE_INVALID');
      }
      this.#token = {value: result.access_token, expires: now + result.expires_in * 1000};
      return result.access_token;
    } catch (error) {
      if (error instanceof GoogleError) throw error;
      throw fail('GOOGLE_AUTH_FAILED');
    }
  }

  async #request(url, {body, guard, write = false}) {
    // No fetch is started after the shared deadline has expired.
    if (guard.signal.aborted) throw fail('GOOGLE_TIMEOUT');
    const token = await this.#accessToken(guard);
    if (guard.signal.aborted) throw fail('GOOGLE_TIMEOUT');
    let attempted = false;
    try {
      attempted = true;
      const response = await guard.run(this.#fetcher(url, {
        method: write ? 'POST' : 'GET', redirect: 'manual', signal: guard.signal,
        headers: {Authorization: `Bearer ${token}`, ...(write ? {'Content-Type': 'application/json'} : {})},
        ...(write ? {body: JSON.stringify(body)} : {}),
      }));
      if (response.status !== 200) {
        throw fail('GOOGLE_API_REJECTED', {
          httpStatus: response.status,
          ambiguous: write && (response.status >= 500 || response.status === 408
            || (response.status >= 200 && response.status < 300)),
        });
      }
      return await limitedJSON(response, MAX_RESPONSE_BYTES, guard);
    } catch (error) {
      if (error instanceof GoogleError) {
        if (write && attempted && error.httpStatus === null) error.ambiguous = true;
        throw error;
      }
      throw fail('GOOGLE_API_UNAVAILABLE', {ambiguous: write && attempted});
    }
  }

  async #ensureBooked(guard) {
    const url=new URL(SHEETS_ROOT+this.#spreadsheetId);
    url.searchParams.set('fields','spreadsheetId,sheets(properties(sheetId,title))');
    const data=await this.#request(url.toString(),{guard});
    if(data.spreadsheetId!==this.#spreadsheetId||!Array.isArray(data.sheets))throw fail('GOOGLE_TAB_INVALID');
    const tabs=data.sheets.filter(s=>s.properties?.title==='BOOKED');
    const intent=await this.#creation.read();
    if(tabs.length===1){
      if(intent&&tabs[0].properties.sheetId!==intent.sheetId)throw fail('GOOGLE_TAB_CREATE_UNRESOLVED',{ambiguous:true});
      await this.#creation.write(null);return;
    }
    if(tabs.length||intent)throw fail('GOOGLE_TAB_CREATE_UNRESOLVED',{ambiguous:true});
    let sheetId;
    do {sheetId=crypto.getRandomValues(new Uint32Array(1))[0]%2000000000;}
    while(data.sheets.some(s=>s.properties?.sheetId===sheetId));
    await this.#creation.write({sheetId}); // Durable before Google: no blind addSheet retry.
    try{
      const created=await this.#request(SHEETS_ROOT+this.#spreadsheetId+':batchUpdate',{
        guard,write:true,body:{requests:[{addSheet:{properties:{sheetId,title:'BOOKED',gridProperties:{rowCount:1000,columnCount:5}}}}]}});
      if(created.spreadsheetId!==this.#spreadsheetId||created.replies?.[0]?.addSheet?.properties?.sheetId!==sheetId)
        throw fail('GOOGLE_TAB_CREATE_UNRESOLVED',{ambiguous:true});
      await this.#creation.write(null);
    }catch(error){
      if(error instanceof GoogleError&&!error.ambiguous)await this.#creation.write(null);
      throw error;
    }
  }

  async readTab({signal} = {}) {
    const guard = deadline(signal);
    try {
      const url = new URL(SHEETS_ROOT + this.#spreadsheetId);
      if(this.#title==='BOOKED')await this.#ensureBooked(guard);
      url.searchParams.set('ranges', "'"+this.#title+"'!A:E");
      url.searchParams.set('fields', 'spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue))))');
      const data = await this.#request(url.toString(), {guard});
      if (data.spreadsheetId !== this.#spreadsheetId || !Array.isArray(data.sheets) || data.sheets.length !== 1) {
        throw fail('GOOGLE_TAB_INVALID');
      }
      const sheet = data.sheets[0];
      const properties = sheet?.properties;
      const dimensions = properties?.gridProperties;
      if (properties?.title !== this.#title || !integer(properties.sheetId)
          || !integer(dimensions?.rowCount) || dimensions.rowCount < this.#header + 1 || dimensions.rowCount > MAX_ROWS
          || !integer(dimensions?.columnCount) || dimensions.columnCount < 5) throw fail('GOOGLE_TAB_INVALID');
      const blocks = sheet.data || [];
      if (!Array.isArray(blocks) || blocks.length > 1) throw fail('GOOGLE_TAB_INVALID');
      const grid = blocks[0] || {};
      if ((grid.startRow || 0) !== 0 || (grid.startColumn || 0) !== 0
          || (grid.rowData && !Array.isArray(grid.rowData))
          || (grid.rowData?.length || 0) > dimensions.rowCount) throw fail('GOOGLE_TAB_INVALID');
      const values = (grid.rowData || []).map(row => {
        if (!plain(row) || (row.values && (!Array.isArray(row.values) || row.values.length > 5))) throw fail('GOOGLE_TAB_INVALID');
        return Array.from({length: 5}, (_, index) => {
          const value = row.values?.[index]?.userEnteredValue;
          if (value === undefined) return '';
          if (!plain(value)) throw fail('GOOGLE_TAB_INVALID');
          const raw = value.stringValue ?? value.numberValue ?? value.boolValue ?? value.formulaValue;
          if (!['string', 'number', 'boolean'].includes(typeof raw)) throw fail('GOOGLE_TAB_INVALID');
          return String(raw);
        });
      });
      while (values.length && values.at(-1).every(value => !value)) values.pop();
      return {sheetId: properties.sheetId, rowCount: dimensions.rowCount,
        columnCount: dimensions.columnCount, title: this.#title, values};
    } finally { guard.close(); }
  }

  async replaceTab({sheetId, rowCount, columnCount, values, signal}) {
    // All five columns belong to Bot DatSan. Values beyond the new list are
    // cleared with a userEnteredValue-only field mask, preserving cell styles.
    if (!integer(sheetId) || !integer(rowCount) || rowCount < this.#header + 1 || rowCount > MAX_ROWS
        || !integer(columnCount) || columnCount < 5 || !Array.isArray(values)
        || values.length < this.#header + 1 || values.length > MAX_ROWS
        || !values.every(row => Array.isArray(row) && row.length <= 5
          && row.every(value => typeof value === 'string' && value.length <= 10000))) {
      throw fail('GOOGLE_VALUES_INVALID');
    }
    const guard = deadline(signal);
    try {
      const endRowIndex = Math.max(rowCount, values.length);
      const dataEnd = Math.max(this.#header + 1, values.length);
      const requests = [];
      if (values.length > rowCount) requests.push({updateSheetProperties: {
        properties: {sheetId, gridProperties: {rowCount: values.length}}, fields: 'gridProperties.rowCount',
      }});
      requests.push({updateCells: {
        range: {sheetId, startRowIndex: 0, endRowIndex, startColumnIndex: 0, endColumnIndex: 5},
        rows: values.map(row => ({values: Array.from({length: 5}, (_, index) => ({
          userEnteredValue: {stringValue: row[index] || ''},
        }))})), fields: 'userEnteredValue',
      }});
      requests.push({updateSheetProperties: {
        properties: {sheetId, gridProperties: {frozenRowCount: this.#header + 1}},
        fields: 'gridProperties.frozenRowCount',
      }});
      requests.push({repeatCell: {
        range: {sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5},
        cell: {userEnteredFormat: {textFormat: {bold: true, fontSize: 14},
          backgroundColor: {red: 0.9, green: 0.96, blue: 0.91}}},
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.backgroundColor',
      }});
      requests.push({repeatCell: {
        range: {sheetId, startRowIndex: this.#header, endRowIndex: this.#header + 1,
          startColumnIndex: 0, endColumnIndex: 5},
        cell: {userEnteredFormat: {textFormat: {bold: true},
          backgroundColor: {red: 0.85, green: 0.92, blue: 0.97}}},
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
      }});
      requests.push({setBasicFilter: {filter: {range: {
        sheetId, startRowIndex: this.#header, endRowIndex: dataEnd, startColumnIndex: 0, endColumnIndex: 5,
      }}}});
      // Set readable mobile widths, without affecting column F onward or any
      // other formatting (number formats, borders, custom views, tab identity).
      for (const [startIndex, endIndex, pixelSize] of (this.#title==='BOOKED'
        ? [[0,1,160],[1,2,130],[2,3,48],[3,4,70],[4,5,200]]
        : [[0, 1, 48], [1, 2, 108], [2, 3, 48], [3, 4, 120], [4, 5, 180]])) {
        requests.push({updateDimensionProperties: {
          range: {sheetId, dimension: 'COLUMNS', startIndex, endIndex},
          properties: {pixelSize}, fields: 'pixelSize',
        }});
      }
      const response = await this.#request(SHEETS_ROOT + this.#spreadsheetId + ':batchUpdate', {
        write: true, guard, body: {requests, includeSpreadsheetInResponse: false},
      });
      if (response.spreadsheetId !== this.#spreadsheetId || !Array.isArray(response.replies)
          || response.replies.length !== requests.length || !response.replies.every(plain)) {
        throw fail('GOOGLE_WRITE_UNCONFIRMED', {ambiguous: true});
      }
      return {status: 'UPDATED', updatedCells: values.length * 5};
    } finally { guard.close(); }
  }
}
