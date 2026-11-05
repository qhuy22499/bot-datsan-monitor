// Webhook authentication and a single, receipt-aware reply. No getUpdates,
// webhook registration, token persistence or retry policy lives in this module.
const MAX_WEBHOOK_BYTES = 32768;
const API_ROOT = 'https://api.telegram.org';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export class WebhookError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.name = 'WebhookError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class TelegramError extends Error {
  constructor(code, {ambiguous = false, httpStatus = null} = {}) {
    super(code);
    this.name = 'TelegramError';
    this.code = code;
    this.ambiguous = ambiguous;
    this.httpStatus = httpStatus;
  }
}

function testChatId(env) {
  const value = env?.TELEGRAM_TEST_CHAT_ID;
  if (typeof value !== 'string' || !/^-[1-9]\d{0,15}$/.test(value)
      || !Number.isSafeInteger(Number(value))) throw new WebhookError('TELEGRAM_CHAT_CONFIG_INVALID', 503);
  return value;
}

async function equalSecret(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const first = new Uint8Array(a);
  const second = new Uint8Array(b);
  // Both SHA-256 digests have fixed length; compare every byte, without an
  // early exit based on the first differing character or secret length.
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= first[index] ^ second[index];
  return difference === 0;
}

async function webhookJSON(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_WEBHOOK_BYTES)) {
    throw new WebhookError('WEBHOOK_BODY_TOO_LARGE', 400);
  }
  if (!request.body) throw new WebhookError('WEBHOOK_BODY_INVALID', 400);
  const reader = request.body.getReader();
  let count = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_WEBHOOK_BYTES) throw new WebhookError('WEBHOOK_BODY_TOO_LARGE', 400);
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!plain(parsed) || !Number.isSafeInteger(parsed.update_id) || parsed.update_id < 0) {
      throw new WebhookError('WEBHOOK_UPDATE_INVALID', 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError('WEBHOOK_BODY_INVALID', 400);
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function parseWebhook(request, env) {
  if (request.method !== 'POST') throw new WebhookError('WEBHOOK_METHOD_NOT_ALLOWED', 405);
  const configuredSecret = env?.TG_WEBHOOK_SECRET;
  if (typeof configuredSecret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(configuredSecret)) {
    throw new WebhookError('WEBHOOK_SECRET_CONFIG_INVALID', 503);
  }
  const providedSecret = request.headers.get(SECRET_HEADER) || '';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(providedSecret)
      || !await equalSecret(configuredSecret, providedSecret)) {
    throw new WebhookError('WEBHOOK_AUTH_REJECTED', 403);
  }
  const allowedChat = testChatId(env);
  const username = env?.TELEGRAM_BOT_USERNAME;
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new WebhookError('TELEGRAM_USERNAME_CONFIG_INVALID', 503);
  }
  const update = await webhookJSON(request);
  // Only new group messages are commands. Edited messages, callbacks and
  // channel posts do not enter the Sheets sync workflow.
  const message = update.message;
  if (!plain(message)) return null;
  if (!Number.isSafeInteger(message.chat?.id) || String(message.chat.id) !== allowedChat
      || !['group', 'supergroup'].includes(message.chat.type)) {
    throw new WebhookError('WEBHOOK_CHAT_REJECTED', 403);
  }
  if (message.from?.is_bot === true || typeof message.text !== 'string' || message.text.length > 100) return null;
  const command = message.text.trim().match(/^\/available(?:@([A-Za-z0-9_]{5,32}))?$/);
  if (!command || (command[1] && command[1].toLowerCase() !== username.toLowerCase())) return null;
  // Persist only the routing/dedup identifiers, never member identity or text.
  return {updateId: update.update_id, chatId: allowedChat};
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Tokyo', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')} JST`;
  }
  // Sheet row 4 already stores a display timestamp, not a new observation.
  return /^\d{2}\/\d{2}\/\d{4} ?\d{2}:\d{2}(?::\d{2})? JST$/.test(value) ? value : null;
}

export function summaryReply(result, spreadsheetId) {
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,150}$/.test(spreadsheetId)) {
    throw new TelegramError('TELEGRAM_SPREADSHEET_CONFIG_INVALID');
  }
  const data = plain(result) ? result : {};
  const status = ['UPDATED', 'SKIPPED', 'UNCERTAIN', 'FAILED', 'TIMEOUT'].includes(data.status) ? data.status : 'FAILED';
  const lines = ['⚽ Bot DatSan — Danh sách sân trống', ''];
  if (Number.isSafeInteger(data.total) && data.total >= 0) lines.push(`Tổng cộng: ${data.total} slot AVAILABLE`);
  else lines.push('Tổng số slot: Chưa thể xác minh');
  lines.push(`Quan sát: ${timestamp(data.observedAt) || 'Chưa thể xác minh'}`);
  if (status === 'UPDATED') lines.push(`Google Sheets: Đã cập nhật${timestamp(data.updatedAt) ? ` ${timestamp(data.updatedAt)}` : ''}`);
  else if (status === 'SKIPPED') lines.push(`Google Sheets: Không cần ghi lại${timestamp(data.updatedAt) ? ` · Cập nhật ${timestamp(data.updatedAt)}` : ''}`);
  else lines.push('', '⚠️ Không thể xác nhận cập nhật Google Sheets.',
    'Bạn vẫn có thể mở bản dữ liệu trước đó nếu file đã được tạo thành công.',
    'Dữ liệu trên Sheets có thể đã cũ.');
  if (data.stale === true) lines.push('', '⚠️ Dữ liệu đã cũ hơn 5 phút. Vui lòng kiểm tra website trước khi đặt.');
  else if (data.stale === false) lines.push('Dữ liệu nguồn còn mới trong 5 phút.');
  else lines.push('Độ mới dữ liệu: Chưa thể xác minh.');
  if (data.sourceWarning) lines.push('⚠️ Lượt kiểm tra gần nhất có cảnh báo; đang dùng lần quan sát COMPLETE đã xác minh.');
  lines.push('', 'Vui lòng kiểm tra lại website trước khi đặt.', '', 'Xem danh sách:',
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#range=AVAILABLE!A1:E`);
  return lines.join('\n');
}

export async function sendReply(env, chatId, text, {signal, fetcher = globalThis.fetch} = {}) {
  let allowedChat;
  try { allowedChat = testChatId(env); } catch { throw new TelegramError('TELEGRAM_CHAT_CONFIG_INVALID'); }
  if (String(chatId) !== allowedChat) throw new TelegramError('TELEGRAM_DESTINATION_REJECTED');
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !/^\d{5,16}:[A-Za-z0-9_-]{30,200}$/.test(token)) {
    throw new TelegramError('TELEGRAM_TOKEN_CONFIG_INVALID');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new TelegramError('TELEGRAM_TEXT_INVALID');
  if (signal?.aborted) throw new TelegramError('TELEGRAM_SEND_CANCELLED');
  const controller = new AbortController();
  let timer;
  let listener;
  let attempted = false;
  const cancelled = new Promise((_, reject) => {
    listener = () => {controller.abort(); reject(new TelegramError('TELEGRAM_SEND_TIMEOUT', {ambiguous: attempted}));};
    timer = setTimeout(listener, 15000);
    signal?.addEventListener('abort', listener, {once: true});
  });
  cancelled.catch(() => {});
  try {
    attempted = true;
    const response = await Promise.race([fetcher(`${API_ROOT}/bot${token}/sendMessage`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chat_id: allowedChat, text, link_preview_options: {is_disabled: true}}),
    }), cancelled]);
    if (response.status !== 200) throw new TelegramError('TELEGRAM_SEND_REJECTED', {
      httpStatus: response.status, ambiguous: response.status >= 500 || response.status === 408
        || (response.status >= 200 && response.status < 300),
    });
    if (Number(response.headers.get('content-length') || 0) > 65536 || !response.body) {
      throw new TelegramError('TELEGRAM_SEND_UNCONFIRMED', {ambiguous: true});
    }
    const reader = response.body.getReader();
    let count = 0;
    const chunks = [];
    let data;
    try {
      while (true) {
        const {done, value} = await Promise.race([reader.read(), cancelled]);
        if (done) break;
        count += value.byteLength;
        if (count > 65536) throw new TelegramError('TELEGRAM_SEND_UNCONFIRMED', {ambiguous: true});
        chunks.push(value);
      }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      data = JSON.parse(new TextDecoder().decode(bytes));
    } finally { reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (data?.ok === false && Number.isInteger(data.error_code) && data.error_code >= 400 && data.error_code < 500) {
      throw new TelegramError('TELEGRAM_SEND_REJECTED', {httpStatus: data.error_code});
    }
    if (data?.ok !== true || !Number.isSafeInteger(data.result?.message_id) || data.result.message_id <= 0
        || String(data.result?.chat?.id) !== allowedChat) {
      throw new TelegramError('TELEGRAM_SEND_UNCONFIRMED', {ambiguous: true});
    }
    return {messageId: data.result.message_id};
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError('TELEGRAM_SEND_UNCONFIRMED', {ambiguous: attempted});
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', listener);
  }
}
