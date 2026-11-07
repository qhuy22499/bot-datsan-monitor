# Telegram weekly bookings

`/bookings` and `/bookings next` (also addressed to the configured bot) read only
the current D1 booking snapshot. Weeks are Monday–Sunday JST; ended bookings are
omitted, days deduplicate across courts/groups, sorting uses ISO date/start/court/group.
Group failure retains earlier verified rows and shows original observation time.
No reservation freshness threshold or three-day booking entitlement is invented.
One UTF-16-bounded reply links to BOOKED; no website, Google API or Actions dispatch.

Webhook secret/chat checks and old command receipts remain in place. New routing
is persisted atomically in existing inbox `detail.route`; legacy CHECK-compatible
command column remains a transport category. Finish/recovery preserve routing.
There is no rebuild/drop/reset of inbox or D1 tables. Weekly receipts are a new
isolated SQLite DO table on the existing AVAILABLE-v1 singleton, not business D1.

Daily 08:30 Booking Cron is unchanged. Cron now signs its exact trigger ID using
`BOOKING_CRON_SIGNING_SECRET` (Cron + Sheets Worker Secrets ONLY, not GitHub).
The signature passes through workflow input and the runner-local event JSON to
the authenticated weekly API; it is not put in step env/public Actions logs.
Blank-signature manual runs, other weekdays and sheets_only never auto-send.
Worker checks HMAC, Monday JST including Sunday UTC, exact scheduled time, existing
matching D1 run and all three terminal attempts, current group results and released
booking lease. One SELECT supplies consistent proof/data. Incomplete runs cannot
consume a weekly identity. All-failed/no-history yields warning, never zero bookings.

After persisted group results and BOOKED sync attempt, runtime calls `/booked/weekly`.
Sheet failure may accompany a D1 summary with a warning. Bearer BOOKED_SYNC_SECRET
is reused. Caller cannot choose text/chat; responses go only to configured TEST.
Identity WEEKLY_BOOKINGS:MondayISO has PENDING → IN_FLIGHT intent before SEND →
SENT/FAILED/UNCERTAIN receipt. Restart converts IN_FLIGHT to UNCERTAIN; no auto retry
of terminal statuses. A warning sent once consumes that week's standard identity.
No new Cron/Worker/sender exists. Saturday/manual test uses separate fixed identity
WEEKLY_BOOKINGS_TEST:LIVE_V1 and an explicit TEST label, never Monday's receipt.

Authenticated `/booked/receipts` returns bounded routing/status/message metadata,
no text/chat IDs/tokens or user profiles. Existing webhook is not re-registered.
Rollback must drain new PENDING command records before reverting to older routing;
retain all receipt tables and signing secrets. No production data deletion.

Execution and auto_booking remain false. Billing and production Telegram unchanged.
