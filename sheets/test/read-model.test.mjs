import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync, constants as sqlite} from 'node:sqlite';
import {READ_SQL, SLOT_TIMES, ReadModelError, readAvailability, projectAvailability} from '../src/read-model.mjs';

const SCAN_ID = 'a'.repeat(32);
const NOW = Date.parse('2026-11-05T07:02:00+09:00');
function fixture({start = '2026-11-05', days = 1, available = () => true} = {}) {
  const scan = {
    id: SCAN_ID, startedAt: `${start}T07:00:00+09:00`,
    finishedAt: `${start}T07:01:00+09:00`, status: 'COMPLETE', reason: 'VERIFIED',
    windowStart: start,
    windowEnd: new Date(Date.parse(start) + (days - 1) * 86400000).toISOString().slice(0, 10),
    days, cells: days * 14,
  };
  const slots = [];
  for (let n = 0; n < days; n++) {
    const day = new Date(Date.parse(start) + n * 86400000).toISOString().slice(0, 10);
    for (const court of ['A', 'B']) for (const [startTime, end] of SLOT_TIMES) {
      const slot = {id: `${day}:${court}:${startTime}:${end}`, day, court, start: startTime, end,
        observed_at: `${start}T07:00:30+09:00`, in_scope: 1, scan_id: SCAN_ID};
      slot.status = available(slot) ? 'AVAILABLE' : 'GENERAL_RESERVED';
      slots.push(slot);
    }
  }
  return {source: {revision: 1, lastScan: SCAN_ID, lastStatus: 'COMPLETE', lastSuccess: scan.finishedAt}, scan, slots};
}
function record(snapshot) {
  const {source, scan, slots} = snapshot;
  return {source_revision: source.revision, source_last_scan: source.lastScan,
    source_last_status: source.lastStatus, source_last_success: source.lastSuccess,
    scan_id: scan.id, started_at: scan.startedAt, finished_at: scan.finishedAt,
    scan_status: scan.status, scan_reason: scan.reason, window_start: scan.windowStart,
    window_end: scan.windowEnd, days: scan.days, cells: scan.cells, slots_json: JSON.stringify(slots)};
}
function mockDb(records) {
  const calls = [];
  return {calls, prepare(sql) {
    calls.push(sql);
    // Reject every non-SELECT SQL token. All other D1 methods deliberately
    // throw, so a future accidental write cannot quietly pass this fixture.
    assert.equal(sql, READ_SQL);
    assert.match(sql, /^SELECT\b/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|PRAGMA|ATTACH|DETACH)\b/i);
    assert(!sql.includes(';'));
    return {async all() { return {success: true, results: records}; },
      run() { throw new Error('MUTATION_FORBIDDEN'); }};
  }, batch() { throw new Error('MUTATION_FORBIDDEN'); }, exec() { throw new Error('MUTATION_FORBIDDEN'); }};
}

test('one fixed SELECT reads one consistent complete snapshot without mutation; all seven periods are included', async () => {
  const db = mockDb([record(fixture({days: 31}))]);
  const result = await readAvailability(db, NOW);
  assert.equal(db.calls.length, 1);
  assert.equal(result.total, 434);
  assert.equal(result.windowEnd, '2026-12-05');
  assert.deepEqual(result.rows.slice(0, 4).map(row => `${row.start}-${row.court}`),
    ['08:00-A', '08:00-B', '10:00-A', '10:00-B']);
  assert.equal(result.stale, false);
  assert.equal(result.observedAt, '2026-11-05T07:00:30+09:00');
  assert.equal(result.lastCompleteAt, '2026-11-05T07:01:00+09:00');
  assert.equal(result.scanId, SCAN_ID);
  assert.equal(result.sourceWarning, null);
  assert.equal(projectAvailability(result.snapshot, NOW).contentKey, result.contentKey);
});

test('verified zero AVAILABLE is distinct from missing COMPLETE scan or failed D1', async () => {
  const db = mockDb([record(fixture({available: () => false}))]);
  assert.equal((await readAvailability(db, NOW)).total, 0);
  await assert.rejects(readAvailability(mockDb([]), NOW), {code: 'NO_COMPLETE_SCAN'});
  for (const dbError of [new Error('private SQL/key'), {success: false, results: []}]) {
    const bad = {prepare() {return {async all() {
      if (dbError instanceof Error) throw dbError;
      return dbError;
    }};}};
    await assert.rejects(readAvailability(bad, NOW), error =>
      error instanceof ReadModelError && error.code === 'D1_UNAVAILABLE' && !error.message.includes('private'));
  }
});

test('actual existing SQL schema runs the read with SQLite authorizer restricted to read operations and leaves every byte unchanged', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../worker/migrations/0001_monitor.sql', import.meta.url), 'utf8'));
    const snapshot = fixture({days: 3});
    const scan = snapshot.scan;
    database.prepare('INSERT INTO scans VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      scan.id, scan.startedAt, scan.finishedAt, scan.status, scan.reason,
      scan.windowStart, scan.windowEnd, scan.days, scan.cells, 1);
    const insert = database.prepare('INSERT INTO slots VALUES(?,?,?,?,?,?,?,?,?)');
    for (const slot of snapshot.slots) insert.run(slot.id, slot.day, slot.court,
      slot.start, slot.end, slot.status, slot.observed_at, slot.in_scope, slot.scan_id);
    // An old, out-of-scope observation is not part of the active Cartesian grid.
    insert.run('2026-11-04:A:08:00:10:00', '2026-11-04', 'A', '08:00', '10:00',
      'UNKNOWN', '2026-11-04T07:00:30+09:00', 0, scan.id);
    database.prepare('INSERT INTO scans VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      'b'.repeat(32), '2026-11-05T07:01:10+09:00', '2026-11-05T07:01:20+09:00',
      'PARTIAL', 'SOURCE_INCOMPLETE', null, null, 1, 14, 2);
    database.prepare('UPDATE source SET revision=1,last_scan=?,last_status=?,last_success=? WHERE id=1')
      .run('b'.repeat(32), 'PARTIAL', scan.finishedAt);
    const before = database.serialize();
    const actions = [];
    database.setAuthorizer(action => {
      actions.push(action);
      return [sqlite.SQLITE_READ, sqlite.SQLITE_SELECT, sqlite.SQLITE_FUNCTION].includes(action)
        ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY;
    });
    const db = {prepare(sql) {
      assert.equal(sql, READ_SQL);
      return {async all() { return {success: true, results: database.prepare(sql).all()}; }};
    }};
    const result = await readAvailability(db, NOW);
    assert.equal(result.total, 42);
    assert.equal(result.sourceWarning, 'LATEST_SCAN_PARTIAL');
    assert.equal(result.windowEnd, '2026-11-07');
    assert(actions.includes(sqlite.SQLITE_READ));
    assert(actions.every(action => [sqlite.SQLITE_READ, sqlite.SQLITE_SELECT, sqlite.SQLITE_FUNCTION].includes(action)));
    assert.throws(() => database.prepare('UPDATE source SET revision=revision+1'), /not authorized/i);
    // Serialization performs an internal PRAGMA in Node; remove the read-only
    // authorizer only after both the production SELECT and denied write proof.
    database.setAuthorizer(null);
    assert.deepEqual(database.serialize(), before);
  } finally { database.close(); }
});

test('previous complete source survives a later FAILED or PARTIAL scan with explicit warning', async () => {
  for (const status of ['FAILED', 'PARTIAL']) {
    const snapshot = fixture();
    snapshot.source.lastStatus = status;
    snapshot.source.lastScan = 'b'.repeat(32);
    const result = await readAvailability(mockDb([record(snapshot)]), NOW);
    assert.equal(result.total, 14);
    assert.equal(result.sourceWarning, `LATEST_SCAN_${status}`);
    assert.equal(result.lastCompleteAt, snapshot.scan.finishedAt);
  }
});

test('stale source is allowed, five-minute boundary is exact, clock filtering changes without new scan', () => {
  const snapshot = fixture({days: 2});
  const observed = Date.parse(snapshot.slots[0].observed_at);
  assert.equal(projectAvailability(snapshot, observed + 300000).stale, false);
  assert.equal(projectAvailability(snapshot, observed + 300001).stale, true);
  const before = projectAvailability(snapshot, Date.parse('2026-11-05T07:59:59+09:00'));
  const after = projectAvailability(snapshot, Date.parse('2026-11-05T08:00:00+09:00'));
  assert.equal(before.total, 28);
  assert.equal(after.total, 26);
  assert(after.rows.some(row => row.day === '2026-11-06' && row.start === '08:00'));
  assert(after.rows.every(row => row.day !== '2026-11-05' || row.start > '08:00'));
  assert.notEqual(after.contentKey, before.contentKey);
  assert.equal(after.scanId, before.scanId);
});

test('JST midnight removes yesterday without extending ALL_BOOKABLE window or writing new observations', () => {
  const snapshot = fixture({start: '2026-12-31', days: 2});
  const result = projectAvailability(snapshot, Date.parse('2026-12-31T15:00:00Z'));
  assert.equal(result.total, 14);
  assert(result.rows.every(row => row.day === '2027-01-01'));
  assert.equal(result.windowEnd, '2027-01-01');
  const expired = projectAvailability(snapshot, Date.parse('2027-01-02T00:00:00+09:00'));
  assert.equal(expired.total, 0);
  assert.equal(expired.sourceWarning, 'SOURCE_WINDOW_EXPIRED');
});

test('all seven weekday labels, month/year transition, holidays and substitute holidays retain every AVAILABLE row', () => {
  const snapshot = fixture({start: '2026-12-28', days: 7});
  const result = projectAvailability(snapshot, Date.parse('2026-12-28T07:02:00+09:00'));
  assert.deepEqual([...new Map(result.rows.map(row => [row.day, row.weekday])).values()],
    ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']);
  assert.equal(result.rows.find(row => row.day === '2027-01-01').date, '01/01/2027');
  assert.equal(result.rows.find(row => row.day === '2027-01-01' && row.start === '18:30').priority, 'Ưu tiên 1');
  assert.equal(result.rows.find(row => row.day === '2026-12-28' && row.start === '18:30').priority, 'Thông thường');
  assert.equal(result.rows.find(row => row.day === '2026-12-28' && row.start === '20:30').priority, 'Ưu tiên 1');
  assert.equal(result.rows.find(row => row.day === '2027-01-02' && row.start === '20:30').priority, 'Ưu tiên 2');
  assert.equal(result.rows.find(row => row.day === '2027-01-02' && row.start === '16:00').priority, 'Chỉ thông báo');
  const national = projectAvailability(fixture({start: '2026-11-23'}), Date.parse('2026-11-23T07:02:00+09:00'));
  assert.equal(national.rows.find(row => row.start === '18:30').priority, 'Ưu tiên 1');
  const notYetVerified = projectAvailability(fixture({start: '2026-09-22'}), Date.parse('2026-09-22T07:02:00+09:00'));
  assert.equal(notYetVerified.rows.find(row => row.start === '18:30').priority, 'Chưa xác minh ngày lễ');
  const futureSubstitute = projectAvailability(fixture({start: '2027-03-22'}), Date.parse('2027-03-22T07:02:00+09:00'));
  assert.equal(futureSubstitute.rows.find(row => row.start === '18:30').priority, 'Ưu tiên 1');
});

test('uncovered holiday year is explicitly unknown; weekend remains known and morning rows remain ordinary', () => {
  const result = projectAvailability(fixture({start: '2028-01-03', days: 7}), Date.parse('2028-01-03T07:02:00+09:00'));
  assert.equal(result.calendarWarning, 'HOLIDAY_CALENDAR_UNVERIFIED');
  assert.equal(result.rows.find(row => row.day === '2028-01-03' && row.start === '20:30').priority, 'Chưa xác minh ngày lễ');
  assert.equal(result.rows.find(row => row.day === '2028-01-03' && row.start === '08:00').priority, 'Thông thường');
  assert.equal(result.rows.find(row => row.day === '2028-01-08' && row.start === '18:30').priority, 'Ưu tiên 1');
});

test('UNKNOWN, missing/duplicate/mixed rows, invalid dates/times and inconsistent metadata fail closed', () => {
  const cases = [
    s => {s.slots[0].status = 'UNKNOWN';},
    s => {s.slots[0].status = 'NOT_REAL';},
    s => {s.slots.pop();},
    s => {s.slots[0] = {...s.slots[1]};},
    s => {s.slots[0].scan_id = 'b'.repeat(32);},
    s => {s.slots[0].in_scope = 0;},
    s => {s.slots[0].day = '2026-11-04';},
    s => {s.slots[0].court = 'C';},
    s => {s.slots[0].start = '18:00';},
    s => {s.slots[0].observed_at = '2026-11-05T07:01:01+09:00';},
    s => {s.slots[0].observed_at = '2026-11-05T06:59:59+09:00';},
    s => {s.scan.days = 2;},
    s => {s.scan.cells = 13;},
    s => {s.scan.status = 'FAILED';},
    s => {s.scan.reason = 'SOURCE_INCOMPLETE';},
    s => {s.scan.windowEnd = '2026-11-31';},
    s => {s.source.lastSuccess = '2026-11-04T07:01:00+09:00';},
    s => {s.source.lastScan = 'b'.repeat(32);},
    s => {s.source.lastStatus = null;},
    s => {s.source.revision = 0;},
  ];
  for (const mutate of cases) {
    const snapshot = fixture(); mutate(snapshot);
    assert.throws(() => projectAvailability(snapshot, NOW), ReadModelError);
  }
  assert.throws(() => projectAvailability(fixture(), Date.parse('2026-11-05T06:59:00+09:00')), ReadModelError);
  assert.throws(() => projectAvailability(fixture(), NaN), {code: 'INVALID_CLOCK'});
});

test('SQL keeps last COMPLETE, filters only in_scope, and never takes a failed range or appends fixed days', () => {
  assert.match(READ_SQL, /WHERE status = 'COMPLETE'\s+ORDER BY finished_at DESC, id DESC LIMIT 1/);
  assert.match(READ_SQL, /WHERE v\.in_scope = 1/);
  assert.doesNotMatch(READ_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|PRAGMA|ATTACH|DETACH)\b/i);
  assert.doesNotMatch(READ_SQL, /(?:\+\s*(?:30|31)|CURRENT_DATE|CURRENT_TIMESTAMP)/);
  assert.equal((READ_SQL.match(/\bSELECT\b/g) || []).length, 3);
});
