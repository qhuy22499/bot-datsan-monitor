-- Additive capability markers. Existing schema/API v1 remains readable.
-- Applied once by D1 migration tracking; no reset, deletion or baseline change.
ALTER TABLE source ADD COLUMN notification_version INTEGER NOT NULL DEFAULT 1 CHECK(notification_version IN (1,2));
ALTER TABLE batches ADD COLUMN notification_version INTEGER NOT NULL DEFAULT 1 CHECK(notification_version IN (1,2));
