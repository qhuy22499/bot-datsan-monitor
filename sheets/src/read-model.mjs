import holidayCalendar from '../../monitor/shared/data/jp_holidays_2026_2027.json' with { type: 'json' };

// A single statement gives source, COMPLETE scan and current slots one D1
// snapshot. There is deliberately no SQL/identifier input from callers and no
// business-database mutation, lock, migration or Storage Worker API here.
export const READ_SQL = `SELECT
  s.revision AS source_revision, s.last_scan AS source_last_scan,
  s.last_status AS source_last_status, s.last_success AS source_last_success,
  c.id AS scan_id, c.started_at, c.finished_at, c.status AS scan_status,
  c.reason AS scan_reason, c.window_start, c.window_end, c.days, c.cells,
  (SELECT json_group_array(json_object(
    'id', v.id, 'day', v.day, 'court', v.court, 'start', v.start, 'end', v.end,
    'status', v.status, 'observed_at', v.observed_at,
    'in_scope', v.in_scope, 'scan_id', v.scan_id
  )) FROM slots AS v WHERE v.in_scope = 1) AS slots_json
FROM source AS s
JOIN scans AS c ON c.id = (
  SELECT id FROM scans WHERE status = 'COMPLETE'
  ORDER BY finished_at DESC, id DESC LIMIT 1
)
WHERE s.id = 1`;

export const SLOT_TIMES = Object.freeze([
  ['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '14:00'],
  ['14:00', '16:00'], ['16:00', '18:00'], ['18:30', '20:30'], ['20:30', '22:30'],
].map(Object.freeze));
const VERIFIED_STATES = new Set([
  'AVAILABLE', 'GENERAL_RESERVED', 'EVENT_RESERVED', 'TOURNAMENT_RESERVED',
  'OTHER_RESERVED', 'COMMUNITY_RESERVED', 'CLOSED', 'MAINTENANCE', 'BAD_WEATHER',
  'OUTSIDE_ACCEPTANCE_PERIOD', 'UNSELECTABLE', 'UNBOOKABLE_TIME',
]);
const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;
const MAX_AGE_MS = 5 * 60000;
const WEEKDAYS = Object.freeze(['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class ReadModelError extends Error {
  constructor(code) { super(code); this.name = 'ReadModelError'; this.code = code; }
}
const need = (valid, code = 'SOURCE_INVALID') => {
  if (!valid) throw new ReadModelError(code);
};
function dateMs(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const ms = Date.parse(`${value}T00:00:00Z`);
  need(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value);
  return ms;
}
function stampMs(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value));
  const ms = Date.parse(value);
  need(Number.isFinite(ms)
    && `${new Date(ms + JST_MS).toISOString().slice(0, 19)}+09:00` === value);
  return ms;
}
function validateSnapshot(snapshot, nowMs) {
  need(Number.isSafeInteger(nowMs) && nowMs > 0 && Number.isFinite(new Date(nowMs).getTime()), 'INVALID_CLOCK');
  need(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
  const {source, scan, slots} = snapshot;
  need(source && scan && Array.isArray(slots));
  need(Number.isSafeInteger(source.revision) && source.revision >= 1);
  need(['COMPLETE', 'PARTIAL', 'FAILED'].includes(source.lastStatus));
  need(typeof scan.id === 'string' && /^[a-f0-9]{32}$/.test(scan.id));
  need(scan.status === 'COMPLETE' && scan.reason === 'VERIFIED', 'SOURCE_NOT_COMPLETE');
  const start = dateMs(scan.windowStart), end = dateMs(scan.windowEnd);
  const started = stampMs(scan.startedAt), finished = stampMs(scan.finishedAt);
  need(Number.isSafeInteger(scan.days) && scan.days >= 1 && scan.days <= 366
    && end >= start && (end - start) / DAY_MS + 1 === scan.days
    && scan.cells === scan.days * 14 && slots.length === scan.cells, 'SOURCE_INCOMPLETE');
  need(scan.startedAt.slice(0, 10) === scan.windowStart
    && scan.finishedAt.slice(0, 10) === scan.windowStart
    && started <= finished && finished <= nowMs);
  need(source.lastSuccess === scan.finishedAt);
  need(typeof source.lastScan === 'string' && /^[a-f0-9]{32}$/.test(source.lastScan));
  if (source.lastStatus === 'COMPLETE') need(source.lastScan === scan.id);
  const actual = new Set();
  let oldestObserved = finished;
  for (const slot of slots) {
    need(slot && typeof slot === 'object' && !Array.isArray(slot));
    dateMs(slot.day);
    need(slot.day >= scan.windowStart && slot.day <= scan.windowEnd
      && ['A', 'B'].includes(slot.court)
      && SLOT_TIMES.some(([startTime, endTime]) => slot.start === startTime && slot.end === endTime)
      && slot.in_scope === 1 && slot.scan_id === scan.id, 'SOURCE_INCOMPLETE');
    need(VERIFIED_STATES.has(slot.status), 'SOURCE_UNKNOWN_STATUS');
    const id = `${slot.day}:${slot.court}:${slot.start}:${slot.end}`;
    need(slot.id === id && !actual.has(id), 'SOURCE_DUPLICATE_SLOT');
    actual.add(id);
    const observed = stampMs(slot.observed_at);
    need(observed >= started && observed <= finished, 'SOURCE_OBSERVATION_INVALID');
    oldestObserved = Math.min(oldestObserved, observed);
  }
  // Validate the Cartesian product, rather than trusting only an aggregate
  // count: exactly seven periods on each court for every scanned day.
  for (let at = start; at <= end; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    for (const court of ['A', 'B']) for (const [startTime, endTime] of SLOT_TIMES)
      need(actual.has(`${day}:${court}:${startTime}:${endTime}`), 'SOURCE_INCOMPLETE');
  }
  return oldestObserved;
}

function holidayStatus(day, today) {
  // Reuse the reviewed Cabinet Office snapshot, including substitute/national
  // holidays. An uncovered weekday is unknown, never silently a normal day.
  const known = holidayCalendar.schema_version === 'poc10-holiday-snapshot-v1'
    && holidayCalendar.source === 'CABINET_OFFICE_JAPAN'
    && holidayCalendar.source_url === 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html'
    && holidayCalendar.verified_on <= today
    && holidayCalendar.start_date <= day && day <= holidayCalendar.end_date
    && Array.isArray(holidayCalendar.holidays);
  return known ? holidayCalendar.holidays.includes(day) : null;
}
function priority(day, start, today) {
  const weekday = new Date(dateMs(day)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const holiday = holidayStatus(day, today);
  if (!weekend && holiday === null && ['16:00', '18:30', '20:30'].includes(start))
    return 'Chưa xác minh ngày lễ';
  if (weekend || holiday === true) {
    if (start === '18:30') return 'Ưu tiên 1';
    if (start === '20:30') return 'Ưu tiên 2';
    if (start === '16:00') return 'Chỉ thông báo';
  } else if (start === '20:30') return 'Ưu tiên 1';
  return 'Thông thường';
}

export function projectAvailability(snapshot, nowMs) {
  const oldestObserved = validateSnapshot(snapshot, nowMs);
  const {source, scan} = snapshot;
  const jstNow = new Date(nowMs + JST_MS).toISOString();
  const today = jstNow.slice(0, 10), time = jstNow.slice(11, 16);
  const rows = snapshot.slots
    .filter(slot => slot.status === 'AVAILABLE'
      && slot.day >= today && slot.day <= scan.windowEnd
      && (slot.day !== today || slot.start > time))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start)
      || a.court.localeCompare(b.court))
    .map(slot => ({
      day: slot.day, court: slot.court, start: slot.start, end: slot.end,
      weekday: WEEKDAYS[new Date(dateMs(slot.day)).getUTCDay()],
      date: `${slot.day.slice(8, 10)}/${slot.day.slice(5, 7)}/${slot.day.slice(0, 4)}`,
      priority: priority(slot.day, slot.start, today),
    }));
  const sourceWarning = source.lastStatus === 'COMPLETE'
    ? (today > scan.windowEnd ? 'SOURCE_WINDOW_EXPIRED' : null)
    : `LATEST_SCAN_${source.lastStatus}`;
  const result = {
    rows,
    observedAt: `${new Date(oldestObserved + JST_MS).toISOString().slice(0, 19)}+09:00`,
    lastCompleteAt: scan.finishedAt,
    windowStart: scan.windowStart, windowEnd: scan.windowEnd,
    stale: nowMs - oldestObserved > MAX_AGE_MS,
    sourceWarning,
    total: rows.length, scanId: scan.id,
    calendarWarning: rows.some(row => row.priority === 'Chưa xác minh ngày lễ')
      ? 'HOLIDAY_CALENDAR_UNVERIFIED' : null,
  };
  // This is a comparison key, not an authentication token. Include observation
  // and warning state, and the clock-filtered rows; scan_id alone is insufficient.
  result.contentKey = JSON.stringify(result);
  return result;
}

export async function readAvailability(db, nowMs) {
  let values;
  try {
    need(db && typeof db.prepare === 'function', 'D1_UNAVAILABLE');
    const response = await db.prepare(READ_SQL).all();
    need(response?.success === true && Array.isArray(response.results), 'D1_UNAVAILABLE');
    values = response.results;
  } catch {
    throw new ReadModelError('D1_UNAVAILABLE');
  }
  need(values.length === 1, values.length ? 'SOURCE_INVALID' : 'NO_COMPLETE_SCAN');
  const record = values[0];
  need(record && typeof record === 'object');
  let slots;
  try { slots = JSON.parse(record.slots_json); }
  catch { throw new ReadModelError('SOURCE_INVALID'); }
  need(own(record, 'source_revision'));
  const snapshot = {
    source: {
      revision: record.source_revision, lastScan: record.source_last_scan,
      lastStatus: record.source_last_status, lastSuccess: record.source_last_success,
    },
    scan: {
      id: record.scan_id, startedAt: record.started_at, finishedAt: record.finished_at,
      status: record.scan_status, reason: record.scan_reason,
      windowStart: record.window_start, windowEnd: record.window_end,
      days: record.days, cells: record.cells,
    },
    slots,
  };
  return {...projectAvailability(snapshot, nowMs), snapshot};
}
