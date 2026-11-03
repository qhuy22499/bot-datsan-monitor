-- Additive, replay-safe v1. D1 migration runner manages the version ledger.
-- Local tests apply this file twice. No production migration has been run.
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO schema_meta VALUES(1);
CREATE TABLE IF NOT EXISTS source (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
 transition_count INTEGER NOT NULL DEFAULT 0,
 baseline TEXT CHECK(baseline IN ('QUIET','NOTIFY')),
 last_scan TEXT, last_status TEXT CHECK(last_status IN ('COMPLETE','PARTIAL','FAILED')),
 last_success TEXT, last_error TEXT, destination TEXT
);
INSERT OR IGNORE INTO source(id) VALUES(1);
CREATE TABLE IF NOT EXISTS lease (
 id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, fence INTEGER NOT NULL,
 expires INTEGER NOT NULL
);
INSERT OR IGNORE INTO lease VALUES(1,'',0,0);
CREATE TABLE IF NOT EXISTS atomic_guard (
 id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)
);
CREATE TABLE IF NOT EXISTS scans (
 id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('COMPLETE','PARTIAL','FAILED')),
 reason TEXT NOT NULL, window_start TEXT, window_end TEXT,
 days INTEGER NOT NULL, cells INTEGER NOT NULL, fence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, court TEXT NOT NULL CHECK(court IN ('A','B')),
 start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
 observed_at TEXT NOT NULL, in_scope INTEGER NOT NULL CHECK(in_scope IN (0,1)),
 scan_id TEXT NOT NULL REFERENCES scans(id), UNIQUE(day,court,start,end)
);
CREATE TABLE IF NOT EXISTS opportunities (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES slots(id),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','INVALIDATED','EXPIRED')),
 origin TEXT NOT NULL CHECK(origin IN ('BASELINE','FIRST_OBSERVED','ENTERED_SCOPE','REOPENED')),
 reason TEXT NOT NULL, created_scan TEXT NOT NULL REFERENCES scans(id), updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_opportunity ON opportunities(slot_id) WHERE state='ACTIVE';
CREATE TABLE IF NOT EXISTS batches (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('INITIAL','INCREMENTAL')),
 revision INTEGER NOT NULL CHECK(revision>0), message_id INTEGER CHECK(message_id>0),
 scan_id TEXT NOT NULL REFERENCES scans(id)
);
CREATE TABLE IF NOT EXISTS members (
 opportunity_id TEXT PRIMARY KEY REFERENCES opportunities(id),
 batch_id TEXT NOT NULL REFERENCES batches(id), ordinal INTEGER NOT NULL,
 delivery TEXT NOT NULL CHECK(delivery IN ('PENDING','SENT')), UNIQUE(batch_id,ordinal)
);
CREATE INDEX IF NOT EXISTS members_batch ON members(batch_id);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('SEND','EDIT')),
 status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','SENT','FAILED','UNCERTAIN','CANCELLED')),
 text TEXT NOT NULL, owner TEXT, fence INTEGER, claimed_at INTEGER,
 message_id INTEGER, error_code TEXT,
 UNIQUE(batch_id,revision,kind)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS transitions (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES slots(id),
 scan_id TEXT NOT NULL REFERENCES scans(id), old_status TEXT, new_status TEXT NOT NULL,
 reason TEXT NOT NULL
);
-- History grows only on verified changes, not on unchanged observed_at updates.
