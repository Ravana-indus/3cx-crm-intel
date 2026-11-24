from __future__ import annotations

import json
import urllib.error
import urllib.request
from urllib.parse import urljoin


class BridgeError(RuntimeError):
    pass


class BridgeClient:
    """Thin localhost HTTP client for the bridge's internal job endpoints."""

    def __init__(self, base_url: str, token: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _url(self, path: str) -> str:
        return urljoin(self.base_url + "/", path.lstrip("/"))

    def _request(self, method: str, path: str, data=None, timeout: float | None = None):
        body = None
        headers = {"authorization": f"Bearer {self.token}"}
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["content-type"] = "application/json"

        request = urllib.request.Request(
            self._url(path), data=body, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(
                request, timeout=timeout or self.timeout
            ) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise BridgeError(
                f"{method} {path} -> HTTP {exc.code}: {detail}"
            ) from exc
        except urllib.error.URLError as exc:
            raise BridgeError(f"{method} {path} failed: {exc.reason}") from exc

    def claim(self, job_type: str = "transcribe"):
        raw = self._request("POST", "/internal/jobs/claim", {"type": job_type})
        return json.loads(raw or b"{}").get("job")

    def download(self, path: str, destination: str) -> str:
        request = urllib.request.Request(
            self._url(path), headers={"authorization": f"Bearer {self.token}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                with open(destination, "wb") as out:
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        out.write(chunk)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise BridgeError(f"GET {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise BridgeError(f"GET {path} failed: {exc.reason}") from exc
        return destination

    def report(self, job_id: str, payload: dict):
        raw = self._request(
            "POST", f"/internal/jobs/{job_id}/result", payload
        )
        return json.loads(raw or b"{}")
