// Trigger only. No Playwright, Telegram, storage mutation, or public dispatch API.
export const CRON = '7,37 0-14,22-23 * * *';
export const DISPATCH_URL = 'https://api.github.com/repos/qhuy22499/bot-datsan-monitor/actions/workflows/monitor.yml/dispatches';

const jstHour = ms => new Date(ms + 9 * 3600000).getUTCHours();
const validTime = ms => Number.isSafeInteger(ms) && ms > 0 && !Number.isNaN(new Date(ms).getTime());

export async function dispatchScheduled(controller, env, {
  fetcher = globalThis.fetch, clock = Date.now, correlationId,
} = {}) {
  // A failed/ambiguous GitHub POST must not be retried blindly by the platform.
  controller.noRetry?.();
  const now = clock(), at = controller.scheduledTime;
  if (!validTime(now) || !validTime(at) || at > now || controller.cron !== CRON)
    return {status: 'FAILED', reason: 'INVALID_SCHEDULE_EVENT'};
  if (jstHour(now) < 7 || jstHour(at) < 7)
    return {status: 'SKIPPED', reason: 'OUTSIDE_VERIFIED_OPERATING_HOURS'};
  const minute = new Date(at).getUTCMinutes();
  if (minute !== 7 && minute !== 37)
    return {status: 'FAILED', reason: 'INVALID_SCHEDULE_MINUTE'};
  if (typeof env.GITHUB_DISPATCH_TOKEN !== 'string' || !/^github_pat_[A-Za-z0-9_]{40,250}$/.test(env.GITHUB_DISPATCH_TOKEN))
    return {status: 'FAILED', reason: 'GITHUB_CREDENTIAL_MISSING'};
  const triggerId = correlationId ?? `cfcron-${at}`;
  if (!/^cfcron-\d{13}(?:-[a-f0-9]{8})?$/.test(triggerId))
    return {status: 'FAILED', reason: 'INVALID_CORRELATION_ID'};
  const started = performance.now();
  try {
    const response = await fetcher(DISPATCH_URL, {
      // Workers supports follow/manual, not redirect:error. Never follow a
      // redirect carrying Authorization; reject 3xx below instead.
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: {'Authorization': `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
        'User-Agent': 'BotDatSan-Cloudflare-Cron/1.0', 'X-GitHub-Api-Version': '2026-03-10'},
      body: JSON.stringify({ref: 'main', inputs: {
        confirm_test_delivery: true, telegram_transport_test: false,
        dispatch_source: 'cloudflare_cron', trigger_id: triggerId,
      }}),
    });
    const elapsed_ms = Math.round(performance.now() - started);
    // Do not read/log raw API descriptions, headers, request bodies, or tokens.
    if (response.status === 204)
      return {status: 'DISPATCH_ACCEPTED', trigger_id: triggerId, http: 204, elapsed_ms};
    if (response.status >= 500 || (response.status >= 200 && response.status < 300))
      return {status: 'UNCERTAIN', reason: 'GITHUB_DISPATCH_RESULT_UNCERTAIN', trigger_id: triggerId, http: response.status, elapsed_ms};
    return {status: 'FAILED', reason: 'GITHUB_DISPATCH_REJECTED', trigger_id: triggerId, http: response.status, elapsed_ms};
  } catch {
    return {status: 'UNCERTAIN', reason: 'GITHUB_DISPATCH_TRANSPORT_UNKNOWN', trigger_id: triggerId,
      elapsed_ms: Math.round(performance.now() - started)};
  }
}

export function createScheduledHandler(options = {}) {
  let busy = false;
  return async (controller, env) => {
    controller.noRetry?.();
    if (busy) return {status: 'SKIPPED', reason: 'INVOCATION_ALREADY_RUNNING'};
    busy = true;
    try { return await dispatchScheduled(controller, env, options); }
    finally { busy = false; }
  };
}

const handle = createScheduledHandler();
export default {
  async fetch() { return new Response('Not Found', {status: 404}); },
  async scheduled(controller, env) {
    const result = await handle(controller, env);
    console.log(JSON.stringify({...result, execution_allowed: false, auto_booking_allowed: false}));
    if (result.status === 'FAILED' || result.status === 'UNCERTAIN')
      throw new Error(result.reason); // Fixed code only; no raw upstream exception.
  },
};
