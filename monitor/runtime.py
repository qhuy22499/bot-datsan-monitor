"""Finite one-shot. D1 is the authority; there is no SQLite cache or poller."""
from datetime import datetime
from uuid import uuid4
import argparse
import json
import os
from pathlib import Path
from .shared.domain import JST, ScanError, iso_time
from .shared.domain import Slot, parse_date, parse_time
from .shared.scope import notification_eligibility
from .shared.calendar import load_calendar
from .shared.telegram import TelegramBotAdapter, TelegramDeliveryError, chat_id
from .core import plan, key
from .storage import D1Storage, StorageError


def run_once(storage, collector, telegram, destination, *, clock=lambda: datetime.now(JST), baseline_mode="QUIET", max_sends=2, notification_version=1):
    if notification_version not in {1,2} or baseline_mode not in {"QUIET", "NOTIFY"} or type(max_sends) is not int or not 0 <= max_sends <= (128 if notification_version==2 else 2):
        raise StorageError("INVALID_CONFIGURATION")
    destination = chat_id(destination)
    if not destination.startswith("-"):
        raise StorageError("INVALID_CONFIGURATION")
    started = clock().astimezone(JST)
    result = {"mode": "READ_ONLY", "execution_allowed": False, "auto_booking_allowed": False,
              "status": "NOT_RUN", "sent": 0, "edited": 0, "uncertain": 0}
    try:
        hours = json.loads(Path(__file__).with_name("shared").joinpath("data/mvp_monitoring_config.json").read_text(encoding="utf-8"))
        if (hours["schema_version"] != "mvp-monitoring-config-v1" or hours["hours_verified"] is not True
                or hours["website_opens_jst"] != "07:00" or hours["website_closes_jst"] != "24:00"):
            raise ValueError()
    except Exception:
        raise StorageError("INVALID_CONFIGURATION") from None
    if started.strftime("%H:%M") < hours["website_opens_jst"]:
        result["reason"] = "OUTSIDE_VERIFIED_OPERATING_HOURS"
        return result
    lease = storage.call("acquire", {"owner": str(uuid4()), "destination": destination})
    credentials = {"owner": lease["owner"], "fence": lease["fence"]}
    try:
        snapshot = storage.call("snapshot", credentials)
        try:
            scan = collector(started_at=started, clock=clock)
            if scan.read_status != "COMPLETE":
                raise ScanError(scan.reason_code, days_read=scan.days_read, slots_read=scan.slots_read)
        except ScanError as error:
            storage.call("failure", {**credentials, "id": key("failure", iso_time(started), str(uuid4())),
                "started_at": iso_time(started), "finished_at": iso_time(clock()), "status": "PARTIAL" if error.days_read else "FAILED",
                "reason": error.code, "days": error.days_read, "cells": error.slots_read})
            result.update(status="PARTIAL" if error.days_read else "FAILED", reason=error.code)
            return result
        calendar = load_calendar(now=clock())
        checks = [notification_eligibility(s, calendar, now=clock(), observed_at=dict(scan.observations)[s.day])
                  for s in scan.slots if s.status == "AVAILABLE"]
        incomplete = sum(c["notification_eligibility"] == "DATA_INCOMPLETE" for c in checks)
        prepared = plan(snapshot, scan, calendar, now=clock(), baseline_mode=baseline_mode, notification_version=notification_version)
        if snapshot["source"]["last_scan"] != prepared["scan"]["id"]:
            storage.call("commit", {**credentials, **prepared})
        result.update(status="PARTIAL" if incomplete else "COMPLETE", days=scan.days_read, cells=scan.slots_read,
                      eligibility_status="DATA_INCOMPLETE" if incomplete else "COMPLETE",
                      eligibility_incomplete_slots=incomplete)
        # Reload committed state; do not dispatch hypothetical client-only jobs.
        committed = storage.call("snapshot", credentials)
        if any(j["status"] == "UNCERTAIN" for j in committed["jobs"]):
            result.update(status="PARTIAL", reason="UNCERTAIN", uncertain=1)
            return result
        for job in committed["jobs"]:
            if job["status"] != "PENDING" or (job["kind"] == "SEND" and result["sent"] >= max_sends):
                continue
            batch = next(b for b in committed['batches'] if b['id'] == job['batch_id'])
            if notification_version == 2:
                # Never replay old EDIT/SEND jobs or use a previous scan's list.
                # A stale pending summary remains visible as unresolved for
                # controlled reconciliation; it is not deleted or blindly sent.
                if batch.get('notification_version',1) != 2 or job['kind'] != 'SEND' or batch['scan_id'] != prepared['scan']['id']:
                    continue
            if job["kind"] == "SEND" and notification_version == 1:
                opps = {o["id"]: o for o in committed["opportunities"]}
                rows = {s["id"]: s for s in committed["slots"]}
                relevant = [rows[opps[m["opportunity_id"]]["slot_id"]] for m in committed["members"]
                            if m["batch_id"] == job["batch_id"]]
                if not relevant or any(notification_eligibility(
                        Slot(parse_date(r["day"]), r["court"], r["start"], r["end"], r["status"]),
                        load_calendar(now=clock()), now=clock(), observed_at=parse_time(r["observed_at"]))[
                            "notification_eligibility"] != "ELIGIBLE" for r in relevant):
                    continue
            claimed = storage.call("claim", {**credentials, "job_id": job["id"]}).get("job")
            if claimed is None:
                continue
            try:
                delivered = (telegram.send_message(destination, claimed["text"], [])
                             if claimed["kind"] == "SEND" else telegram.edit_message(destination, claimed["message_id"], claimed["text"], []))
                if delivered.chat_id != destination or (claimed["kind"] == "EDIT" and delivered.message_id != claimed["message_id"]):
                    raise TelegramDeliveryError("TELEGRAM_INVALID_RESPONSE", True)
            except TelegramDeliveryError as error:
                status = "UNCERTAIN" if error.ambiguous else "FAILED"
                storage.call("receipt", {**credentials, "job_id": claimed["id"], "status": status,
                                         "message_id": None, "error_code": error.code})
                result.update(status="PARTIAL", reason=error.code)
                result["uncertain"] += int(error.ambiguous)
                # No automatic retry/backoff. Stop dispatch on first error.
                break
            else:
                # If this write fails after send, leave IN_FLIGHT for controlled
                # UNCERTAIN recovery. Never send again in an exception handler.
                storage.call("receipt", {**credentials, "job_id": claimed["id"], "status": "SENT",
                                         "message_id": delivered.message_id, "error_code": None})
                result["sent" if claimed["kind"] == "SEND" else "edited"] += 1
        # A definite failure is not success merely because the next scan changed nothing.
        final = storage.call("snapshot", credentials)
        unresolved = sum(j["status"] in {"FAILED", "UNCERTAIN", "IN_FLIGHT", "PENDING"} for j in final["jobs"])
        if unresolved:
            result.update(status="PARTIAL", unresolved_jobs=unresolved)
        return result
    finally:
        try:
            storage.call("release", credentials)
        except StorageError:
            # Lease expires server-side; no unsafe recovery mutation is attempted.
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="offline generated fixture, no network")
    parser.add_argument("--enable-test-delivery", action="store_true")
    parser.add_argument("--baseline", choices=["QUIET", "NOTIFY"], default="QUIET")
    args = parser.parse_args()
    try:
        if args.dry_run:
            from .dry_run import run
            report = run()
        else:
            if not args.enable_test_delivery or os.environ.get("TELEGRAM_DESTINATION") != "TEST":
                raise StorageError("INVALID_CONFIGURATION")
            from .collector import PublicCollector
            storage = D1Storage(os.environ.get("MONITOR_API_URL", ""), os.environ.get("MONITOR_API_SECRET", ""))
            adapter = TelegramBotAdapter(os.environ.get("TELEGRAM_BOT_TOKEN"), enabled=True)
            report = run_once(storage, PublicCollector(), adapter, os.environ.get("TELEGRAM_TEST_CHAT_ID", ""), baseline_mode=args.baseline,
                              notification_version=2,max_sends=128)
        # Only counters, fixed codes, and safety flags; no IDs or payloads.
        print(json.dumps(report, ensure_ascii=True))
        return 0 if report["status"] in {"COMPLETE", "NOT_RUN"} else 2
    except (StorageError, ScanError) as error:
        print(json.dumps({"status": "FAILED", "reason": error.code, "execution_allowed": False, "auto_booking_allowed": False}))
        return 2
    except Exception:
        print(json.dumps({"status": "FAILED", "reason": "RUN_STOPPED_NO_RETRY", "execution_allowed": False, "auto_booking_allowed": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
