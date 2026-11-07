# Group Booking READ_ONLY

Runs sequential Group A/B/C sessions using the PoC03/04 login route and exact
DOM extractor. Only login and verified list pagination may be clicked. No
booking/cancel/lottery/payment execution exists in this module.

GitHub Secrets (entered by admin; never copied automatically from Windows):
`BOOKING_GROUP_A_LOGIN_ID`, `BOOKING_GROUP_A_PASSWORD`, corresponding B/C names,
existing `MONITOR_API_URL`, `MONITOR_API_SECRET`, plus `BOOKED_SYNC_URL` and
`BOOKED_SYNC_SECRET`. Group aliases map to the matching Account_A/B/C credentials.
Never emit actual IDs/passwords/display names/reservation rows to Actions logs.

Migration 0003 adds isolated booking lease, guard, attempts, groups and bookings.
It does not modify monitoring tables, baseline, source version2 or receipts.
The workflow identity and per-group begin permit survive restarts: an interrupted
STARTED group is not automatically logged in again for the same trigger.
Use a new manual run only after assessing the previous attempt. A different daily
Cron tick has a new identity. Lease fencing is independent from monitoring.

Counter ranges must be contiguous across pages with an unchanged declared total;
rows are all parsed before filtering to the target facility/courts. A unique exact
next-page link recognized by the original extractor may be followed, with a wait
for the declared first row to change. Unsupported controls/counters stay PARTIAL.
Explicit 0/0/0 counter + authenticated reservation heading/columns + zero rows +
no page controls is the only supported COMPLETE empty proof. No counter means
PARTIAL, never a zero-booking success. No 90-day truncation is applied.

Display names come only from the authenticated visible `利用者：…様` header.
Internal full-width spaces and characters remain unchanged. Missing names retain
previous verified names and produce a Sheet warning. Names are group display
metadata, not login IDs. Each repeated source row retains a stable occurrence ID
within group/reservation/date/time/court; number alone is never unique.

COMPLETE updates that group atomically (missing rows become listed=0, not
CANCELLED). PARTIAL/FAILED retain prior rows/name/last success. BOOKED reads only
the dedicated tables and uses its own Durable Object `BOOKED-v1`; AVAILABLE and
commands continue on `AVAILABLE-v1`. BOOKED contains ongoing/future bookings,
sorted by ISO day/start/court/group, five literal string cells per data row.
Weekly count also includes ended days this week; incomplete groups are labelled
as a lower bound. Reservation freshness threshold is not invented.

BOOKED creation has a durable chosen sheet ID before addSheet; ambiguous create
requires metadata read-back and never a blind second creation. Existing Google
replace/read-back/UNCERTAIN machinery is reused. Authenticated `/booked/sync`
allows repair from D1 without another website login; it returns status/count only.

Cron dispatch: `30 23 * * *` UTC = 08:30 JST next calendar day. Monitoring Cron
and Sheets AVAILABLE hourly Cron remain unchanged. The Cron trigger is activated
only after controlled LIVE checks; configured is not evidence of a real tick.

Rollback is code-only for Booking routes/Cron; retain additive tables and DO state.
Do not drop/reset production tables or roll back monitoring Notification V2.
Execution and auto-booking flags remain false. No new paid service is needed.
