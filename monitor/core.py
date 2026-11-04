"""Pure D1 delta planner; uses the verified Windows eligibility and renderer.

No HTTP, SQL, Playwright, credentials, reservation data, or booking execution.
The Worker applies this typed plan atomically, guarded by revision and fencing.
"""
from copy import deepcopy
from datetime import datetime
from hashlib import sha256
from types import SimpleNamespace
from .shared.domain import JST, Slot, iso_time, parse_date, parse_time, require
from .shared.scope import notification_eligibility
from .shared.formatting import render_original
from .display import display_date


def key(*parts):
    return sha256("|".join(map(str, parts)).encode()).hexdigest()[:32]


def slot_id(slot):
    return f"{slot.day.isoformat()}:{slot.court}:{slot.start}:{slot.end}"


def render(batch, members, opportunities, slots, scan):
    """Adapt three read queries and date presentation; generated core is unchanged.

    Cloud batches contain <=24 items, so nothing is hidden. No command ingress
    is packaged; replace the old /available hint with a static public UI link.
    """
    rows = []
    for member in members:
        opp = opportunities[member["opportunity_id"]]
        slot = slots[opp["slot_id"]]
        rows.append({"usage_date": slot["day"], "court": slot["court"], "start_time": slot["start"],
                     "end_time": slot["end"], "item_state": "INVALIDATED" if opp["reason"] == "OUT_OF_SCOPE" else opp["state"], "invalidation_reason": opp["reason"]})
    rows.sort(key=lambda r: (r["usage_date"], r["start_time"], r["court"]))
    for row in rows:
        row['usage_date'] = display_date(row['usage_date'])
    observed = min(slots[opportunities[m["opportunity_id"]]["slot_id"]]["observed_at"] for m in members)

    class Result:
        def __init__(self, value): self.value = value
        def fetchone(self): return self.value

    class Reads:
        def execute(self, sql, params):
            if "FROM mvp_notification_batches" in sql:
                return Result({"batch_kind": batch["kind"], "scan_id": batch["scan_id"]})
            if "FROM monitor_runs" in sql:
                return Result({**scan, 'window_start': display_date(scan['window_start']),
                               'window_end': display_date(scan['window_end'])})
            if "min(c.observed_at)" in sql:
                return Result([observed])
            raise ValueError("UNSUPPORTED_RENDER_READ")

    facade = SimpleNamespace(db=SimpleNamespace(connection=Reads()), _item_rows=lambda _: rows)
    text = render_original(facade, batch["id"])
    text = text.replace("Gõ /available để xem danh sách hiện tại.",
                        "Xem website công khai: https://rsv.shisetsu.city.katsushika.lg.jp/katsushika/web/")
    text = "[TEST · READ_ONLY — KHÔNG ĐẶT SÂN THẬT]\n" + text
    require(len(text) <= 4096, "MESSAGE_TOO_LONG")
    return text


def plan(snapshot, scan, calendar, *, now, baseline_mode="QUIET"):
    require(scan.read_status == "COMPLETE" and baseline_mode in {"QUIET", "NOTIFY"}, "SOURCE_INCOMPLETE")
    require(0 <= (now - scan.finished_at).total_seconds() <= 300, "AVAILABILITY_DATA_STALE")
    source = snapshot["source"]
    sid = key("scan", iso_time(scan.started_at), iso_time(scan.finished_at))
    old_slots = {r["id"]: r for r in snapshot["slots"]}
    slots = deepcopy(old_slots)
    opportunities = {r["id"]: deepcopy(r) for r in snapshot["opportunities"]}
    batches = {r["id"]: deepcopy(r) for r in snapshot["batches"]}
    members = list(deepcopy(snapshot["members"]))
    old_members = {r["opportunity_id"] for r in members}
    old_opps = deepcopy(opportunities)
    old_batches = deepcopy(batches)
    observations = dict(scan.observations)
    days = sorted(observations)
    meta = {"id": sid, "started_at": iso_time(scan.started_at), "finished_at": iso_time(scan.finished_at),
            "status": "COMPLETE", "reason": "VERIFIED", "window_start": days[0].isoformat(),
            "window_end": days[-1].isoformat(), "days": scan.expected_days, "cells": scan.expected_days * 14}
    for row in slots.values():
        row["in_scope"] = 0
    transitions = []
    for slot in scan.slots:
        ident = slot_id(slot)
        prior = old_slots.get(ident)
        slots[ident] = {"id": ident, "day": slot.day.isoformat(), "court": slot.court,
                        "start": slot.start, "end": slot.end, "status": slot.status,
                        "observed_at": iso_time(observations[slot.day]), "in_scope": 1, "scan_id": sid}
        if prior is None or prior["status"] != slot.status:
            transitions.append({"id": key(sid, ident), "slot_id": ident, "scan_id": sid,
                                "old_status": prior["status"] if prior else None,
                                "new_status": slot.status, "reason": "FIRST_OBSERVED" if prior is None else "VERIFIED_CHANGE"})
    # Out-of-scope and wall-clock expiry are distinct from reservation evidence.
    active = {r["slot_id"]: r for r in opportunities.values() if r["state"] == "ACTIVE"}
    for ident, opp in active.items():
        row = slots[ident]
        reason = ("OUT_OF_SCOPE" if not row["in_scope"] else
                  "STARTED" if datetime.fromisoformat(row["day"] + "T" + row["start"] + ":00+09:00") <= now else
                  "SOURCE_NOT_AVAILABLE" if row["status"] != "AVAILABLE" else None)
        if reason:
            opp.update(state="INVALIDATED" if reason == "SOURCE_NOT_AVAILABLE" else "EXPIRED", reason=reason, updated_at=iso_time(now))
    fresh_ids = []
    for slot in scan.slots:
        ident = slot_id(slot)
        if any(r["slot_id"] == ident and r["state"] == "ACTIVE" for r in opportunities.values()):
            continue
        decision = notification_eligibility(slot, calendar, now=now, observed_at=observations[slot.day])
        if decision["notification_eligibility"] != "ELIGIBLE":
            continue
        prior = old_slots.get(ident)
        history = any(r["slot_id"] == ident for r in opportunities.values())
        origin = ("BASELINE" if source["baseline"] is None else "REOPENED" if history else
                  "ENTERED_SCOPE" if prior is None or not prior["in_scope"] else "FIRST_OBSERVED")
        oid = key("opportunity", sid, ident)
        opportunities[oid] = {"id": oid, "slot_id": ident, "state": "ACTIVE", "origin": origin,
                              "reason": "AVAILABLE", "created_scan": sid, "updated_at": iso_time(now)}
        fresh_ids.append(oid)
    quiet_initial = source["baseline"] is None and baseline_mode == "QUIET"
    if not quiet_initial:
        # Stable chronological ordering is for display only, never auto booking.
        fresh_ids.sort(key=lambda oid: (opportunities[oid]["slot_id"]))
        for offset in range(0, len(fresh_ids), 24):
            bid = key("batch", sid, offset)
            batches[bid] = {"id": bid, "kind": "INITIAL" if source["baseline"] is None else "INCREMENTAL",
                            "revision": 1, "message_id": None, "scan_id": sid}
            for ordinal, oid in enumerate(fresh_ids[offset:offset+24], 1):
                members.append({"opportunity_id": oid, "batch_id": bid, "ordinal": ordinal, "delivery": "PENDING"})
    affected = {m["batch_id"] for m in members if m["opportunity_id"] in old_opps
                and old_opps[m["opportunity_id"]]["state"] != opportunities[m["opportunity_id"]]["state"]}
    changed_batches = {bid for bid in batches if bid not in old_batches} | affected
    jobs = []
    for bid in changed_batches:
        batch = batches[bid]
        if bid in old_batches:
            batch["revision"] += 1
            batch["scan_id"] = sid
        items = [m for m in members if m["batch_id"] == bid]
        # An invalidated pre-send batch is suppressed, never advertised as new.
        if batch["message_id"] is None and not any(opportunities[m["opportunity_id"]]["state"] == "ACTIVE" for m in items):
            continue
        if batch["message_id"] is None and any(j["batch_id"] == bid and j["status"] in {
                "FAILED", "IN_FLIGHT", "UNCERTAIN"} for j in snapshot["jobs"]):
            # A changed batch is not permission to retry a failed delivery.
            continue
        kind = "EDIT" if batch["message_id"] is not None else "SEND"
        jobs.append({"id": key(bid, batch["revision"], kind), "batch_id": bid,
                     "revision": batch["revision"], "kind": kind,
                     "text": render(batch, items, opportunities, slots, meta)})
    return {"expected_revision": source["revision"], "scan": meta,
            "baseline": source["baseline"] or baseline_mode,
            "slots": [r for ident, r in slots.items() if r["in_scope"] or old_slots.get(ident) != r],
            "opportunities": [r for oid, r in opportunities.items() if old_opps.get(oid) != r],
            "batches": [batches[bid] for bid in changed_batches],
            "members": [r for r in members if r["opportunity_id"] not in old_members],
            "jobs": jobs, "transitions": transitions,
            "execution_allowed": False, "auto_booking_allowed": False}
