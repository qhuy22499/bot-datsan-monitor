// Coordination storage belongs to the SQLite Durable Object, never env.DB.
// Every operation is synchronous: no claim yields across external I/O.
const TERMINAL = new Set(['SENT', 'FAILED', 'UNCERTAIN']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const updateId = value => Number.isSafeInteger(value) && value >= 0;
const messageId = value => Number.isSafeInteger(value) && value > 0;
const decode = row => row ? {
  updateId: row.update_id,
  chatId: row.chat_id,
  command: JSON.parse(row.detail).route ?? row.command,
  receivedAt: row.received_at,
  deadlineAt: row.deadline_at,
  state: row.state,
  ...JSON.parse(row.detail),
} : null;

export class CoordinatorStore {
  constructor(sql) {
    if (!sql || typeof sql.exec !== 'function') throw new Error('INVALID_COORDINATOR_STORAGE');
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS sheets_coordinator_state (
      id TEXT PRIMARY KEY CHECK (id = 'sync'), value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sheets_webhook_inbox (
      update_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL,
      received_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('PENDING','WORKING','REPLY_SENDING','SENT','FAILED','UNCERTAIN')),
      detail TEXT NOT NULL DEFAULT '{}',
      command TEXT NOT NULL DEFAULT 'available' CHECK (command IN ('available','priority'))
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS booking_weekly_receipts (
      id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','SENT','FAILED','UNCERTAIN')),
      detail TEXT NOT NULL DEFAULT '{}')`);
    // Additive migration in the isolated DO only. Existing inbox rows retain
    // their receipts and are all the original /available command.
    if (!sql.exec('PRAGMA table_info(sheets_webhook_inbox)').toArray().some(row => row.name === 'command')) {
      sql.exec("ALTER TABLE sheets_webhook_inbox ADD COLUMN command TEXT NOT NULL DEFAULT 'available' CHECK (command IN ('available','priority'))");
    }
  }

  weekly(id) {
    if(typeof id!=='string'||!/^WEEKLY_BOOKINGS(?:_TEST)?:[A-Z0-9_-]{1,50}$/.test(id))throw new Error('INVALID_WEEKLY_ID');
    const row=this.sql.exec('SELECT * FROM booking_weekly_receipts WHERE id=?',id).toArray()[0];
    return row?{id:row.id,state:row.state,...JSON.parse(row.detail)}:null;
  }
  weeklyIntent(id,detail) {
    this.weekly(id);
    this.sql.exec("INSERT OR IGNORE INTO booking_weekly_receipts(id,state,detail) VALUES(?,'PENDING',?)",id,JSON.stringify(detail));
  }
  weeklyClaim(id) {
    this.weekly(id);
    return this.sql.exec("UPDATE booking_weekly_receipts SET state='IN_FLIGHT' WHERE id=? AND state='PENDING' RETURNING id",id).toArray().length===1;
  }
  weeklyFinish(id,state,detail) {
    if(!TERMINAL.has(state))throw new Error('INVALID_WEEKLY_STATE');this.weekly(id);
    this.sql.exec("UPDATE booking_weekly_receipts SET state=?,detail=? WHERE id=? AND state='IN_FLIGHT'",state,JSON.stringify(detail),id);
  }
  readSync() {
    const row = this.sql.exec(
      "SELECT value FROM sheets_coordinator_state WHERE id = 'sync'",
    ).toArray()[0];
    return row ? JSON.parse(row.value) : {phase: 'IDLE'};
  }

  writeSync(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.phase !== 'string') throw new Error('INVALID_SYNC_STATE');
    const encoded = JSON.stringify(value);
    this.sql.exec(`INSERT INTO sheets_coordinator_state (id, value) VALUES ('sync', ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value`, encoded);
  }

  accept(update) {
    if (!update || !updateId(update.updateId)
        || typeof update.chatId !== 'string' || !/^-?\d{1,20}$/.test(update.chatId)
        || !integer(update.receivedAt) || !integer(update.deadlineAt)
        || update.deadlineAt < update.receivedAt
        || !['available','priority','bookings_current','bookings_next'].includes(update.command ?? 'available')) throw new Error('INVALID_INBOX_UPDATE');
    // Store only fields needed to reply. Raw Telegram payload/user data are excluded.
    const rows = this.sql.exec(`INSERT OR IGNORE INTO sheets_webhook_inbox
      (update_id, chat_id, received_at, deadline_at, state, command, detail) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)
      RETURNING *`, update.updateId, update.chatId, update.receivedAt, update.deadlineAt,
    update.command?.startsWith('bookings_')?'priority':update.command ?? 'available',
    JSON.stringify(update.command?.startsWith('bookings_')?{route:update.command}:{})).toArray();
    return {accepted: rows.length === 1, record: rows.length ? decode(rows[0]) : this.getUpdate(update.updateId)};
  }

  getUpdate(id) {
    if (!updateId(id)) throw new Error('INVALID_UPDATE_ID');
    return decode(this.sql.exec(
      'SELECT * FROM sheets_webhook_inbox WHERE update_id = ?', id,
    ).toArray()[0]);
  }

  claimUpdate(id) {
    if (!updateId(id)) throw new Error('INVALID_UPDATE_ID');
    return decode(this.sql.exec(`UPDATE sheets_webhook_inbox SET state = 'WORKING'
      WHERE update_id = ? AND state = 'PENDING' RETURNING *`, id).toArray()[0]);
  }

  claimReply(id) {
    if (!updateId(id)) throw new Error('INVALID_UPDATE_ID');
    return decode(this.sql.exec(`UPDATE sheets_webhook_inbox SET state = 'REPLY_SENDING'
      WHERE update_id = ? AND state = 'WORKING' RETURNING *`, id).toArray()[0]);
  }

  finishUpdate(id, state, detail = {}) {
    if (!updateId(id) || !TERMINAL.has(state) || !detail || typeof detail !== 'object') {
      throw new Error('INVALID_UPDATE_RESULT');
    }
    const route=this.getUpdate(id)?.command;
    const safe = route?.startsWith('bookings_')?{route}:{};
    if (detail.messageId !== undefined) {
      if (!messageId(detail.messageId)) throw new Error('INVALID_MESSAGE_ID');
      safe.messageId = detail.messageId;
    }
    if (detail.code !== undefined) {
      if (typeof detail.code !== 'string' || !/^[A-Z0-9_:-]{1,100}$/.test(detail.code)) {
        throw new Error('INVALID_RESULT_CODE');
      }
      safe.code = detail.code;
    }
    if (detail.result !== undefined) safe.result = detail.result;
    return decode(this.sql.exec(`UPDATE sheets_webhook_inbox SET state = ?, detail = ?
      WHERE update_id = ? AND state IN ('WORKING','REPLY_SENDING') RETURNING *`,
    state, JSON.stringify(safe), id).toArray()[0]);
  }

  pending(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PENDING_LIMIT');
    return this.sql.exec(`SELECT * FROM sheets_webhook_inbox WHERE state = 'PENDING'
      ORDER BY received_at, update_id LIMIT ?`, limit).toArray().map(decode);
  }

  pendingDeadline({pendingOnly = false} = {}) {
    if (typeof pendingOnly !== 'boolean') throw new Error('INVALID_PENDING_FILTER');
    // Alarm wakeups concern queued inbox records. In-progress requests already
    // have a bounded worker; rearming on their expired deadline can hot-loop.
    const query = pendingOnly
      ? "SELECT MIN(deadline_at) AS deadline FROM sheets_webhook_inbox WHERE state = 'PENDING'"
      : "SELECT MIN(deadline_at) AS deadline FROM sheets_webhook_inbox WHERE state IN ('PENDING','WORKING')";
    return this.sql.exec(query).toArray()[0]?.deadline ?? null;
  }

  recover() {
    this.sql.exec("UPDATE booking_weekly_receipts SET state='UNCERTAIN',detail=json_set(detail,'$.code','INTERRUPTED_TELEGRAM_SEND') WHERE state='IN_FLIGHT'");
    const sync = this.readSync();
    const syncRecovered = sync.phase === 'WRITING';
    if (syncRecovered) this.writeSync({...sync, phase: 'UNCERTAIN', code: 'INTERRUPTED_SYNC'});
    const requeued = this.sql.exec(`UPDATE sheets_webhook_inbox SET state = 'PENDING'
      WHERE state = 'WORKING' RETURNING update_id`).toArray();
    const uncertain = this.sql.exec(`UPDATE sheets_webhook_inbox
      SET state = 'UNCERTAIN', detail = json_set(detail,'$.code','INTERRUPTED_TELEGRAM_SEND')
      WHERE state = 'REPLY_SENDING' RETURNING update_id`).toArray();
    return {syncRecovered, updatesRequeued: requeued.length, repliesUncertain: uncertain.length};
  }
}
