-- Additive and isolated: no statement changes any monitoring table.
CREATE TABLE booking_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,fence INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL DEFAULT 0);
INSERT INTO booking_lease(id) VALUES(1);
CREATE TABLE booking_guard(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE booking_runs(id TEXT PRIMARY KEY,started_at TEXT NOT NULL);
CREATE TABLE booking_attempts(run_id TEXT NOT NULL REFERENCES booking_runs(id),group_alias TEXT NOT NULL CHECK(group_alias IN ('A','B','C')),status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETE','PARTIAL','FAILED')),code TEXT,observed_at TEXT,source_count INTEGER,pages INTEGER,PRIMARY KEY(run_id,group_alias));
CREATE TABLE booking_groups(group_alias TEXT PRIMARY KEY CHECK(group_alias IN ('A','B','C')),display_name TEXT,last_success_at TEXT,last_attempt_at TEXT,sync_status TEXT NOT NULL DEFAULT 'FAILED' CHECK(sync_status IN ('COMPLETE','PARTIAL','FAILED')),code TEXT NOT NULL DEFAULT 'NOT_SYNCED');
INSERT INTO booking_groups(group_alias) VALUES('A'),('B'),('C');
CREATE TABLE bookings(id TEXT PRIMARY KEY,group_alias TEXT NOT NULL REFERENCES booking_groups(group_alias),reservation_number TEXT,day TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,court TEXT NOT NULL CHECK(court IN ('A','B')),reservation_status TEXT NOT NULL CHECK(reservation_status='CONFIRMED'),payment_status TEXT NOT NULL,payment_raw TEXT,observed_at TEXT NOT NULL,listed INTEGER NOT NULL CHECK(listed IN (0,1)),last_run TEXT NOT NULL REFERENCES booking_runs(id));
CREATE INDEX bookings_effective ON bookings(listed,day,start,court,group_alias);
