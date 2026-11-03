"""Minimal storage port; Oracle can supply the same finite command contract."""
from typing import Protocol
import json
import re
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError


class StorageError(Exception):
    def __init__(self, code="STORAGE_UNAVAILABLE"):
        self.code = code if code in {"STORAGE_UNAVAILABLE", "SOURCE_BUSY", "STALE_OWNER", "INVALID_CONFIGURATION", "UNCERTAIN", "INVALID_REQUEST", "DESTINATION_MISMATCH", "STATE_LIMIT", "BODY_TOO_LARGE", "UNAUTHORIZED", "NOT_CONFIGURED", "UNSUPPORTED_SCHEMA"} else "STORAGE_UNAVAILABLE"
        super().__init__(self.code)


class Storage(Protocol):
    def call(self, command: str, payload: dict) -> dict: ...


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class D1Storage:
    COMMANDS = frozenset({"acquire", "snapshot", "commit", "failure", "claim", "receipt", "release"})

    def __init__(self, url, secret, *, transport=None):
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
                or parts.query or parts.fragment or parts.path not in ("", "/")
                or not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret)):
            raise StorageError("INVALID_CONFIGURATION")
        self._url, self._secret, self._transport = url.rstrip("/"), secret, transport

    def call(self, command, payload):
        if command not in self.COMMANDS or not isinstance(payload, dict):
            raise StorageError("INVALID_REQUEST")
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > 800_000:
            raise StorageError("INVALID_REQUEST")
        try:
            if self._transport:
                result = self._transport(command, payload)
            else:
                request = Request(self._url + "/v1/" + command, data=data, method="POST", headers={
                    "Authorization": "Bearer " + self._secret, "Content-Type": "application/json",
                    "User-Agent": "BotDatSan-Monitor/1.0"})
                try:
                    response = build_opener(NoRedirect()).open(request, timeout=30)
                except HTTPError as failure:
                    response = failure
                with response:
                    raw = response.read(2_000_001)
                    if len(raw) > 2_000_000:
                        raise StorageError()
                    result = json.loads(raw)
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise StorageError(result.get("error") if isinstance(result, dict) else None)
            return result
        except StorageError:
            raise
        except Exception:
            # No raw URL, bearer, SQL, remote payload, or traceback may escape.
            raise StorageError() from None
