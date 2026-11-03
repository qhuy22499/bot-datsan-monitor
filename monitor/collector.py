"""Headless hosting adapter; the public UI/read/validation core is unchanged."""
from collections import Counter
from datetime import datetime
import os
from pathlib import Path
from urllib.parse import urlsplit
from .shared.domain import JST, FACILITY, ScanError, availability_rows
from .shared.scope import MonitoringScope
from .shared.collector import ORIGIN, collect_scope_pages


class PublicCollector:
    def __init__(self, *, playwright_factory=None):
        self._factory = playwright_factory

    def __call__(self, *, started_at, clock=lambda: datetime.now(JST)):
        if os.environ.get("DEBUG") or os.environ.get("PWDEBUG"):
            raise ScanError("READ_ERROR")
        try:
            scope = MonitoringScope().resolve(anchor=started_at.astimezone(JST).date())
        except Exception:
            raise ScanError("BOOKABLE_BOUNDARY_UNVERIFIED") from None
        from playwright.sync_api import sync_playwright
        try:
            with (self._factory or sync_playwright)() as pw:
                browser = pw.chromium.launch(headless=True)
                try:
                    context = browser.new_context(timezone_id="Asia/Tokyo")
                    try:
                        context.set_default_timeout(15000)

                        def route_guard(route):
                            parts = urlsplit(route.request.url)
                            if route.request.is_navigation_request() and f"{parts.scheme}://{parts.netloc}" != ORIGIN:
                                route.abort()
                            else:
                                route.continue_()

                        context.route("**/*", route_guard)
                        page = context.new_page()
                        http_failure = []
                        page.on("response", lambda r: http_failure.append(True)
                                if r.request.resource_type == "document" and r.status >= 400 else None)
                        oracle = Path(__file__).with_name("shared").joinpath("oracle.js").read_text(encoding="utf-8")

                        def observe(page, entry):
                            expected = page.evaluate(oracle)
                            actual = Counter((s.day.isoformat(), s.court, s.start, s.end, s.status)
                                             for s in availability_rows({"facility": FACILITY, "days": [entry]}))
                            reference = Counter((s["date"], s["court"], s["start"], s["end"], s["status"])
                                                for s in expected.get("slots", []))
                            if (expected.get("verified") is not True or actual != reference or not page.evaluate(
                                    "f => (document.body?.innerText || '').includes(f)", FACILITY)):
                                raise ScanError("SOURCE_INCOMPLETE")

                        return collect_scope_pages(page, scope=scope, started_at=started_at, clock=clock,
                                                   http_failed=lambda: bool(http_failure), observer=observe)
                    finally:
                        context.close()
                finally:
                    browser.close()
        except (ScanError, KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            raise ScanError("READ_ERROR") from None
