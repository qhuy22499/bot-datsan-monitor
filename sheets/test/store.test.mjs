import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CoordinatorStore} from '../src/store.mjs';

const setup = () => {
  const db = new DatabaseSync(':memory:');
  const statements = [];
  const sql = {exec(text, ...params) {
    statements.push(text);
    const statement = db.prepare(text);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return {toArray: () => rows, rowsWritten: db.prepare('SELECT changes() AS n').get().n};
  }};
  return {db, sql, statements, store: new CoordinatorStore(sql)};
};
const update = (id = 1, receivedAt = 1000) => ({
  updateId: id, chatId: '-100123456', receivedAt, deadlineAt: receivedAt + 15000,
});

test('SQLite coordinator owns only isolated tables; sync state survives a new wrapper', () => {
  const {db, sql, store, statements} = setup();
  try {
    assert.deepEqual(store.readSync(), {phase: 'IDLE'});
    const state = {phase: 'CONFIRMED', hash: 'public-hash', values: [['Public slots']], syncedAt: 1200};
    store.writeSync(state);
    assert.deepEqual(new CoordinatorStore(sql).readSync(), state);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map(row => row.name), ['sheets_coordinator_state', 'sheets_webhook_inbox']);
    assert.ok(statements.every(text => !/\b(?:slots|scans|source|lease|opportunities|jobs|members|batches)\b/i.test(text)));
  } finally { db.close(); }
});

test('inbox accept is durable and deduplicates an update without overwriting its original fields', () => {
  const {db, sql, store} = setup();
  try {
    const first = store.accept({...update(), rawPayload: {secret: 'DO_NOT_STORE'}, userId: 42});
    assert.equal(first.accepted, true);
    assert.deepEqual(first.record, {...update(), state: 'PENDING'});
    const repeated = new CoordinatorStore(sql).accept({...update(), chatId: '-999', deadlineAt: 99999});
    assert.equal(repeated.accepted, false);
    assert.deepEqual(repeated.record, first.record);
    const raw = JSON.stringify(db.prepare('SELECT * FROM sheets_webhook_inbox').all());
    assert.ok(!raw.includes('DO_NOT_STORE') && !raw.includes('userId'));
  } finally { db.close(); }
});

test('conditional update and reply claims permit exactly one transition, including after restart', () => {
  const {db, sql, store} = setup();
  try {
    store.accept(update());
    assert.equal(store.claimReply(1), null);
    assert.equal(store.claimUpdate(1).state, 'WORKING');
    assert.equal(new CoordinatorStore(sql).claimUpdate(1), null);
    assert.equal(store.claimReply(1).state, 'REPLY_SENDING');
    assert.equal(new CoordinatorStore(sql).claimReply(1), null);
    assert.deepEqual(store.finishUpdate(1, 'SENT', {messageId: 81, result: {status: 'UPDATED'}}), {
      ...update(), state: 'SENT', messageId: 81, result: {status: 'UPDATED'},
    });
    assert.equal(store.finishUpdate(1, 'UNCERTAIN', {code: 'TIMEOUT'}), null);
    assert.equal(new CoordinatorStore(sql).claimReply(1), null);
  } finally { db.close(); }
});

test('failure and uncertain delivery never become pending or resendable', () => {
  const {db, store} = setup();
  try {
    for (const [id, state] of [[1, 'FAILED'], [2, 'UNCERTAIN']]) {
      store.accept(update(id));
      store.claimUpdate(id);
      store.claimReply(id);
      assert.equal(store.finishUpdate(id, state, {code: 'TELEGRAM_UNAVAILABLE'}).state, state);
    }
    store.recover();
    assert.deepEqual(store.pending(), []);
    assert.equal(store.claimUpdate(1), null);
    assert.equal(store.claimReply(2), null);
  } finally { db.close(); }
});

test('pending queue is bounded and ordered; deadlines include work already claimed', () => {
  const {db, store} = setup();
  try {
    assert.equal(store.pendingDeadline(), null);
    store.accept(update(3, 3000));
    store.accept(update(2, 1000));
    store.accept(update(1, 1000));
    assert.deepEqual(store.pending(2).map(row => row.updateId), [1, 2]);
    store.claimUpdate(1);
    assert.equal(store.pendingDeadline(), 16000);
    assert.equal(store.pendingDeadline({pendingOnly: true}), 16000);
    store.finishUpdate(1, 'FAILED', {code: 'SOURCE_FAILED'});
    store.claimUpdate(2);
    store.claimReply(2);
    assert.equal(store.pendingDeadline(), 18000);
    store.claimUpdate(3);
    assert.equal(store.pendingDeadline(), 18000);
    assert.equal(store.pendingDeadline({pendingOnly: true}), null);
  } finally { db.close(); }
});

test('restart preserves uncertain Google write and never retries an attempted Telegram send', () => {
  const {db, sql, store} = setup();
  try {
    const attempted = {phase: 'WRITING', attemptedHash: 'new', attemptedValues: [['Future public slot']],
      confirmedHash: 'previous', confirmedValues: [['Previous public slot']]};
    store.writeSync(attempted);
    for (const id of [1, 2, 3]) store.accept(update(id));
    store.claimUpdate(1);
    store.claimUpdate(2);
    store.claimReply(2);
    const restarted = new CoordinatorStore(sql);
    assert.deepEqual(restarted.recover(), {syncRecovered: true, updatesRequeued: 1, repliesUncertain: 1});
    assert.deepEqual(restarted.readSync(), {...attempted, phase: 'UNCERTAIN', code: 'INTERRUPTED_SYNC'});
    assert.equal(restarted.getUpdate(2).state, 'UNCERTAIN');
    assert.equal(restarted.getUpdate(2).code, 'INTERRUPTED_TELEGRAM_SEND');
    assert.equal(restarted.claimReply(2), null);
    assert.deepEqual(restarted.pending().map(row => row.updateId), [1, 3]);
    assert.deepEqual(restarted.recover(), {syncRecovered: false, updatesRequeued: 0, repliesUncertain: 0});
  } finally { db.close(); }
});

test('invalid identifiers and invalid states fail before storage changes', () => {
  const {db, store} = setup();
  try {
    for (const bad of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.throws(() => store.accept({...update(), updateId: bad}), /INVALID_INBOX_UPDATE/);
      assert.throws(() => store.getUpdate(bad), /INVALID_UPDATE_ID/);
    }
    assert.throws(() => store.accept({...update(), deadlineAt: 999}), /INVALID_INBOX_UPDATE/);
    assert.throws(() => store.accept({...update(), chatId: 'other-chat'}), /INVALID_INBOX_UPDATE/);
    assert.throws(() => store.writeSync({}), /INVALID_SYNC_STATE/);
    assert.throws(() => store.pending(1000), /INVALID_PENDING_LIMIT/);
    store.accept(update()); store.claimUpdate(1);
    assert.throws(() => store.finishUpdate(1, 'PENDING'), /INVALID_UPDATE_RESULT/);
    assert.throws(() => store.finishUpdate(1, 'SENT', {code: 'Raw secret text'}), /INVALID_RESULT_CODE/);
    assert.throws(() => store.finishUpdate(1, 'SENT', {messageId: 0}), /INVALID_MESSAGE_ID/);
    assert.equal(store.getUpdate(1).state, 'WORKING');
  } finally { db.close(); }
});

test('Telegram update zero is valid consistently while message identifiers remain positive', () => {
  const {db, store} = setup();
  try {
    assert.equal(store.accept(update(0)).accepted, true);
    assert.equal(store.getUpdate(0).updateId, 0);
    assert.equal(store.claimUpdate(0).state, 'WORKING');
    assert.equal(store.claimReply(0).state, 'REPLY_SENDING');
    assert.throws(() => store.finishUpdate(0, 'SENT', {messageId: 0}), /INVALID_MESSAGE_ID/);
    assert.equal(store.getUpdate(0).state, 'REPLY_SENDING');
    assert.equal(store.finishUpdate(0, 'SENT', {messageId: 1}).messageId, 1);
    assert.equal(store.accept(update(0)).accepted, false);
  } finally { db.close(); }
});
