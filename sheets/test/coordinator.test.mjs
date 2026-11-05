import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CoordinatorStore} from '../src/store.mjs';
import {GoogleError} from '../src/google.mjs';
import {SyncCoordinator, SYNC_BUDGET_MS, sheetValues, normalizeValues} from '../src/coordinator.mjs';
import {projectAvailability, SLOT_TIMES} from '../src/read-model.mjs';

const NOW = Date.parse('2026-11-05T07:02:00+09:00');
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const row = (court = 'A', start = '20:30') => ({day: '2026-11-05', court, start,
  end: start === '08:00' ? '10:00' : '22:30', weekday: 'T5', date: '05/11/2026', priority: 'Ưu tiên 1'});
function data(rows = [row()]) {
  return {rows, total: rows.length, observedAt: '2026-11-05T07:00:30+09:00',
    lastCompleteAt: '2026-11-05T07:01:00+09:00', windowStart: '2026-11-05',
    windowEnd: '2026-12-05', stale: false, sourceWarning: null, calendarWarning: null,
    scanId: 'a'.repeat(32)};
}
function snapshot() {
  const id = 'a'.repeat(32), day = '2026-11-05';
  const scan = {id, startedAt: `${day}T07:00:00+09:00`, finishedAt: `${day}T07:01:00+09:00`,
    status: 'COMPLETE', reason: 'VERIFIED', windowStart: day, windowEnd: day, days: 1, cells: 14};
  const slots = [];
  for (const court of ['A', 'B']) for (const [start, end] of SLOT_TIMES)
    slots.push({id: `${day}:${court}:${start}:${end}`, day, court, start, end,
      status: 'AVAILABLE', observed_at: `${day}T07:00:30+09:00`, in_scope: 1, scan_id: id});
  return {scan, slots, source: {revision: 1, lastScan: id, lastStatus: 'COMPLETE', lastSuccess: scan.finishedAt}};
}
function setup({source = data(), clock = () => NOW} = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(text, ...args) {
    const statement = db.prepare(text);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return {toArray: () => rows};
  }};
  const store = new CoordinatorStore(sql);
  const google = {
    values: [], reads: 0, writes: [],
    async readTab() {this.reads++; return {sheetId: 0, rowCount: 100, columnCount: 5, values: clone(this.values)};},
    async replaceTab(request) {
      assert.equal(store.readSync().phase, 'WRITING', 'durable intent precedes Google write');
      this.writes.push(clone({...request, signal: undefined}));
      this.values = clone(request.values);
    },
  };
  let sourceReads = 0;
  const readSource = async () => {sourceReads++; return clone(source);};
  const create = (overrides = {}) => new SyncCoordinator({store, readSource, google, clock, ...overrides});
  return {db, sql, store, google, create, source, get sourceReads() {return sourceReads;}};
}

test('simultaneous scheduled/command waiters coalesce into one source read and atomic write; restart skips a confirmed receipt', async () => {
  const f = setup();
  const started = deferred(), complete = deferred();
  const realWrite = f.google.replaceTab;
  f.google.replaceTab = async function(request) {started.resolve(); await complete.promise; return realWrite.call(this, request);};
  try {
    const coordinator = f.create();
    const requests = [coordinator.sync(), coordinator.sync(), coordinator.sync()];
    await started.promise;
    assert.equal(f.sourceReads, 1);
    assert.equal(f.google.reads, 1);
    assert.equal(f.store.readSync().phase, 'WRITING');
    complete.resolve();
    const results = await Promise.all(requests);
    assert(results.every(result => result.status === 'UPDATED'));
    assert.equal(f.google.writes.length, 1);
    assert.equal(f.store.readSync().phase, 'IDLE');
    const restarted = f.create({store: new CoordinatorStore(f.sql)});
    assert.equal((await restarted.sync()).status, 'SKIPPED');
    assert.equal(f.google.writes.length, 1);
  } finally {complete.resolve(); f.db.close();}
});

test('replacement shrinks data and a trusted fresh zero clears old rows rather than retaining/appending them', async () => {
  const f = setup({source: data([row('A'), row('B')])});
  try {
    let current = f.source;
    const coordinator = f.create({readSource: async () => clone(current)});
    assert.equal((await coordinator.sync()).status, 'UPDATED');
    assert.equal(f.google.values.length, 11);
    current = data([row('B')]);
    assert.equal((await coordinator.sync()).status, 'UPDATED');
    assert.equal(f.google.values.length, 10);
    assert.equal(f.google.values[9][2], 'B');
    current = data([]);
    const result = await coordinator.sync();
    assert.equal(result.status, 'UPDATED');
    assert.equal(result.total, 0);
    assert.equal(f.google.values.length, 9);
    assert.deepEqual(f.google.values[5], ['Tổng số slot AVAILABLE', '0']);
    assert.equal((await coordinator.sync()).status, 'SKIPPED');
    assert.equal(f.google.writes.length, 3);
  } finally {f.db.close();}
});

test('semantic comparison ignores only update timestamp and normalizes trailing empty cells/rows', async () => {
  let now = NOW;
  const f = setup({clock: () => now});
  try {
    const coordinator = f.create();
    const first = await coordinator.sync();
    f.google.values = normalizeValues(f.google.values).map(value => [...value, '', '']);
    f.google.values.push(['', '', '']);
    now += 1000;
    const second = await coordinator.sync();
    assert.equal(second.status, 'SKIPPED');
    assert.equal(second.updatedAt, first.updatedAt);
    assert.equal(f.google.writes.length, 1);
    assert.equal(f.store.readSync().lastSuccessAt, first.updatedAt);
  } finally {f.db.close();}
});

test('same scan ID is reprojected after time advances: stale-warning transition and started slots both require replacement', async () => {
  let now = NOW;
  const raw = snapshot();
  const source = {...projectAvailability(raw, now), snapshot: raw};
  const f = setup({source, clock: () => now});
  try {
    const coordinator = f.create();
    assert.equal((await coordinator.sync()).status, 'UPDATED');
    assert.equal(f.google.values.length, 23);
    assert.match(f.google.values[6][1], /còn mới/);
    now = Date.parse('2026-11-05T07:05:31+09:00');
    const stale = await coordinator.sync();
    assert.equal(stale.status, 'UPDATED');
    assert.equal(stale.stale, true);
    assert.match(f.google.values[6][1], /đã cũ hơn 5 phút/);
    now = Date.parse('2026-11-05T08:00:00+09:00');
    const begun = await coordinator.sync();
    assert.equal(begun.status, 'UPDATED');
    assert.equal(begun.total, 12);
    assert.equal(f.google.values.length, 21);
    assert(f.google.values.slice(9).every(value => value[3] !== '08:00–10:00'));
    assert.equal(source.scanId, raw.scan.id);
    assert.equal(f.google.writes.length, 3);
  } finally {f.db.close();}
});

test('D1 failure preserves previous spreadsheet and durable success state with no Google request', async () => {
  const f = setup();
  try {
    await f.create().sync();
    const state = f.store.readSync(), before = clone(f.google.values);
    const coordinator = f.create({readSource: async () => {throw Object.assign(new Error('private SQL'), {code: 'D1_UNAVAILABLE'});}});
    const result = await coordinator.sync();
    assert.deepEqual(result, {status: 'FAILED', code: 'D1_UNAVAILABLE'});
    assert.deepEqual(f.store.readSync(), state);
    assert.deepEqual(f.google.values, before);
    assert.equal(f.google.reads, 1);
    assert.equal(f.google.writes.length, 1);
    assert(!JSON.stringify(result).includes('private SQL'));
  } finally {f.db.close();}
});

test('Google read failure leaves receipt untouched; a definite write rejection records FAILED without claiming success', async () => {
  const f = setup();
  try {
    const old = {phase: 'IDLE', lastSuccessAt: 'previous'};
    f.store.writeSync(old);
    const readFailed = f.create({google: {async readTab() {throw new GoogleError('GOOGLE_FORBIDDEN');}}});
    assert.equal((await readFailed.sync()).status, 'FAILED');
    assert.deepEqual(f.store.readSync(), old);
    f.google.replaceTab = async () => {throw new GoogleError('GOOGLE_FORBIDDEN', {httpStatus: 403});};
    const result = await f.create().sync();
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'GOOGLE_FORBIDDEN');
    assert.equal(f.store.readSync().phase, 'FAILED');
    assert.equal(f.store.readSync().lastSuccessAt, undefined);
    assert.deepEqual(f.google.values, []);
  } finally {f.db.close();}
});

test('ambiguous Google write persists UNCERTAIN across restart; mismatching read-back never resends', async () => {
  const f = setup();
  let writeCalls = 0;
  try {
    f.google.replaceTab = async () => {writeCalls++; throw new GoogleError('GOOGLE_WRITE_UNKNOWN', {ambiguous: true});};
    const first = await f.create().sync();
    assert.equal(first.status, 'UNCERTAIN');
    const state = f.store.readSync();
    assert.equal(state.phase, 'UNCERTAIN');
    assert.equal(state.attemptedValues.length, 10);
    const restartedStore = new CoordinatorStore(f.sql);
    restartedStore.recover();
    f.google.values = clone(state.attemptedValues);
    f.google.values[3][1] = 'Different update timestamp';
    const restarted = f.create({store: restartedStore});
    const second = await restarted.sync();
    assert.equal(second.status, 'UNCERTAIN');
    assert.equal(second.code, 'GOOGLE_WRITE_UNRESOLVED');
    assert.equal(writeCalls, 1);
    assert.deepEqual(restartedStore.readSync(), state);
  } finally {f.db.close();}
});

test('exact read-back of the entire ambiguous attempt confirms success without another write', async () => {
  const f = setup();
  let writeCalls = 0;
  try {
    f.google.replaceTab = async request => {
      writeCalls++;
      f.google.values = clone(request.values);
      throw new GoogleError('GOOGLE_WRITE_UNKNOWN', {ambiguous: true});
    };
    assert.equal((await f.create().sync()).status, 'UNCERTAIN');
    const restartedStore = new CoordinatorStore(f.sql);
    restartedStore.recover();
    const recovered = await f.create({store: restartedStore}).sync();
    assert.equal(recovered.status, 'SKIPPED');
    assert.equal(restartedStore.readSync().phase, 'IDLE');
    assert.equal(recovered.updatedAt, f.google.values[3][1]);
    assert.equal(writeCalls, 1);
  } finally {f.db.close();}
});

test('after exact reconciliation a genuinely changed projection may replace once; an unknown write exception is UNCERTAIN', async () => {
  const f = setup();
  let writeCalls = 0;
  try {
    f.google.replaceTab = async request => {
      writeCalls++; f.google.values = clone(request.values);
      throw new Error('untrusted private network response');
    };
    const ambiguous = await f.create().sync();
    assert.equal(ambiguous.status, 'UNCERTAIN');
    assert.equal(ambiguous.code, 'SYNC_FAILED');
    assert(!JSON.stringify(f.store.readSync()).includes('private network'));
    f.google.replaceTab = async request => {writeCalls++; f.google.values = clone(request.values);};
    const changed = f.create({readSource: async () => data([row('B')])});
    assert.equal((await changed.sync()).status, 'UPDATED');
    assert.equal(f.google.values[9][2], 'B');
    assert.equal(writeCalls, 2);
    assert.equal(f.store.readSync().phase, 'IDLE');
    assert.equal((await changed.sync()).status, 'SKIPPED');
    assert.equal(writeCalls, 2);
  } finally {f.db.close();}
});

test('crash during WRITING is recovered as UNCERTAIN; no blind replacement occurs on restart', async () => {
  const f = setup();
  try {
    const intended = sheetValues(f.source, '05/11/2026 07:02:00 JST');
    f.store.writeSync({phase: 'WRITING', attemptedValues: intended,
      attemptedKey: 'test-semantic-key', updatedAt: '05/11/2026 07:02:00 JST'});
    const restartedStore = new CoordinatorStore(f.sql);
    assert.equal(restartedStore.recover().syncRecovered, true);
    assert.equal(restartedStore.readSync().phase, 'UNCERTAIN');
    assert.equal((await f.create({store: restartedStore}).sync()).status, 'UNCERTAIN');
    assert.equal(f.google.writes.length, 0);
    f.google.values = clone(intended);
    assert.equal((await f.create({store: restartedStore}).sync()).status, 'SKIPPED');
    assert.equal(f.google.writes.length, 0);
  } finally {f.db.close();}
});

test('15-second budget is shared across D1 and Google read; expired calls return before starting work', async () => {
  let now = NOW;
  const f = setup({clock: () => now});
  try {
    assert.equal(SYNC_BUDGET_MS, 15000);
    const coordinator = f.create({
      readSource: async () => {now += 6; return clone(f.source);},
      google: {
        async readTab() {now += 5; return {values: []};},
        async replaceTab() {assert.fail('expired shared budget cannot start write');},
      },
    });
    const result = await coordinator.sync({deadlineAt: NOW + 10});
    assert.equal(result.status, 'TIMEOUT');
    assert.equal(result.code, 'GOOGLE_TIMEOUT');
    assert.deepEqual(f.store.readSync(), {phase: 'IDLE'});
    const alreadyExpired = await f.create().sync({deadlineAt: now});
    assert.deepEqual(alreadyExpired, {status: 'TIMEOUT', code: 'SYNC_TIMEOUT'});
    assert.equal(f.sourceReads, 0);
  } finally {f.db.close();}
});

test('unresolved D1 or Google reads time out bounded waiters; abandoned reads never initiate a late write', async t => {
  for (const hung of ['D1', 'GOOGLE_READ']) await t.test(hung, async () => {
    const f = setup();
    const gate = deferred(), reached = deferred();
    let reads = 0;
    let coordinator;
    try {
      coordinator = f.create(hung === 'D1' ? {
        readSource: async () => {reads++; reached.resolve(); return gate.promise;},
      } : {google: {
        async readTab() {reads++; reached.resolve(); return gate.promise;},
        async replaceTab() {assert.fail('late read must not start a write');},
      }});
      const waiter = coordinator.sync({deadlineAt: NOW + 10});
      await reached.promise;
      const operation = coordinator.inFlight;
      assert.equal((await waiter).status, 'TIMEOUT');
      assert.equal((await operation).status, 'TIMEOUT');
      await Promise.resolve();
      assert.equal(coordinator.inFlight, null);
      assert.equal(reads, 1);
      gate.resolve(hung === 'D1' ? clone(f.source) : {values: []});
      await Promise.resolve();
      assert.deepEqual(f.store.readSync(), {phase: 'IDLE'});
      assert.equal(f.google.writes.length, 0);
      // A source/read-only timeout does not leave the global object unusable.
      assert.equal((await f.create().sync()).status, 'UPDATED');
      assert.equal(f.google.writes.length, 1);
    } finally {
      gate.resolve(hung === 'D1' ? clone(f.source) : {values: []});
      if (coordinator?.inFlight) await coordinator.inFlight;
      f.db.close();
    }
  });
});

test('a timed-out write keeps a durable UNCERTAIN latch; late receipt requires exact read-back before clearing it', async () => {
  const f = setup();
  const writeStarted = deferred(), finish = deferred();
  let coordinator, writeCalls = 0;
  try {
    f.google.replaceTab = async request => {
      writeCalls++; writeStarted.resolve(); await finish.promise;
      f.google.values = clone(request.values);
    };
    coordinator = f.create();
    const waiter = coordinator.sync({deadlineAt: NOW + 10});
    await writeStarted.promise;
    const operation = coordinator.inFlight;
    assert(['TIMEOUT', 'UNCERTAIN'].includes((await waiter).status));
    assert.equal((await operation).status, 'UNCERTAIN');
    assert.equal(f.store.readSync().phase, 'UNCERTAIN');
    assert.equal((await coordinator.sync()).status, 'UNCERTAIN');
    assert.equal(writeCalls, 1);
    finish.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.store.readSync().phase, 'UNCERTAIN', 'late adapter result must not invent a confirmed receipt');
    assert.equal((await coordinator.sync()).status, 'SKIPPED');
    assert.equal(f.store.readSync().phase, 'IDLE');
    assert.equal(writeCalls, 1);
  } finally {
    finish.resolve(); if (coordinator?.inFlight) await coordinator.inFlight;
    f.db.close();
  }
});

test('late ambiguous timeout receipt preserves attempt for read-only reconciliation instead of success or automatic retry', async () => {
  const f = setup();
  const writeStarted = deferred(), finish = deferred();
  let coordinator, calls = 0;
  try {
    f.google.replaceTab = async () => {
      calls++; writeStarted.resolve(); await finish.promise;
      throw new GoogleError('GOOGLE_TIMEOUT', {ambiguous: true});
    };
    coordinator = f.create();
    const waiter = coordinator.sync({deadlineAt: NOW + 10});
    await writeStarted.promise;
    const operation = coordinator.inFlight;
    assert(['TIMEOUT', 'UNCERTAIN'].includes((await waiter).status));
    assert.equal((await operation).status, 'UNCERTAIN');
    assert.equal(f.store.readSync().phase, 'UNCERTAIN');
    finish.resolve();
    await Promise.resolve();
    assert.equal((await f.create().sync()).status, 'UNCERTAIN');
    assert.equal(calls, 1);
  } finally {
    finish.resolve(); if (coordinator?.inFlight) await coordinator.inFlight;
    f.db.close();
  }
});
