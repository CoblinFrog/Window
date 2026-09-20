#!/usr/bin/env python3
"""Primed-session page fetch for Window's web adapters.

Node's fetch carries a TLS fingerprint that bot mitigation (Akamai, PerimeterX)
refuses outright. curl_cffi impersonates a real browser's fingerprint, and
requesting the site's homepage first lets its bot manager stamp the session
cookies it needs before it will serve item pages. The jar is persisted per
domain under --jar-dir so a process restart does not pay the priming cost again.

Usage:
    fetch_page.py --jar-dir .data/cookies <url> [<url> ...]

Emits one JSON array on stdout: [{url, status, final_url, blocked, body}].
`blocked` marks a bot-mitigation response — a refused status or a challenge
body returned with HTTP 200 — so callers can escalate rather than parse noise.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from curl_cffi import requests as cffi
except ImportError:
    print(json.dumps({"error": "curl_cffi is not installed: pip install curl_cffi"}))
    sys.exit(2)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
IMPERSONATE = ["chrome131", "chrome124", "safari180"]
# Kept in step with BLOCKED_STATUSES / CHALLENGE_MARKERS in primed-fetch.ts.
# 503 is Amazon's automated-access refusal; "bm-verify" is Akamai Bot Manager's
# interstitial, which arrives as a 200 and would otherwise be reported as a
# clean page and parsed into listings.
BLOCKED_STATUSES = {401, 403, 405, 429, 503}
CHALLENGE_MARKERS = [
    "Just a moment",
    "cf_chl_opt",
    "cf-mitigated",
    "Pardon our interruption",
    "Robot Check",
    "validateCaptcha",
    "Enter the characters",
    "Enable JavaScript and cookies to continue",
    "bm-verify",
    "To discuss automated access to Amazon data",
]
TIMEOUT = 30
MAX_BODY_BYTES = 4 * 1024 * 1024


def load_jar(session: "cffi.Session", jar: Path) -> None:
    try:
        saved = json.loads(jar.read_text())
    except (OSError, ValueError):
        return
    for name, value in saved.items():
        session.cookies.set(name, value)


def save_jar(session: "cffi.Session", jar: Path) -> None:
    jar.parent.mkdir(parents=True, exist_ok=True)
    try:
        jar.write_text(json.dumps(session.cookies.get_dict()))
    except OSError:
        pass


def prime(session: "cffi.Session", origin: str) -> None:
    """Touch the homepage so the bot manager issues its session cookies."""
    try:
        session.get(origin + "/", timeout=TIMEOUT)
    except Exception:
        pass


def looks_challenged(body: str) -> bool:
    return any(marker in body for marker in CHALLENGE_MARKERS)


def fetch_one(session: "cffi.Session", url: str, jar: Path) -> dict:
    origin = url.split("/")[0] + "//" + url.split("/")[2]
    primed = jar.exists()
    try:
        response = session.get(url, timeout=TIMEOUT)
    except Exception as exc:
        return {"url": url, "status": 0, "final_url": url, "blocked": False,
                "error": f"{type(exc).__name__}: {exc}", "body": ""}

    # A refused page is sometimes the session's first contact: prime and retry
    # once before reporting the block upstream.
    if response.status_code in BLOCKED_STATUSES and not primed:
        prime(session, origin)
        save_jar(session, jar)
        try:
            response = session.get(url, timeout=TIMEOUT)
        except Exception as exc:
            return {"url": url, "status": 0, "final_url": url, "blocked": False,
                    "error": f"{type(exc).__name__}: {exc}", "body": ""}

    body = response.text[:MAX_BODY_BYTES]
    # Sitemap children ship as .gz *files* — a content type, not a transport
    # encoding — so nothing decompresses them for us.
    if url.endswith(".gz") or "gzip" in response.headers.get("content-type", ""):
        import gzip
        try:
            body = gzip.decompress(response.content).decode("utf-8", "replace")[:MAX_BODY_BYTES]
        except OSError:
            pass
    blocked = response.status_code in BLOCKED_STATUSES or looks_challenged(body)
    return {
        "url": url,
        "status": response.status_code,
        "final_url": str(response.url),
        "blocked": blocked,
        "body": body,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    parser.add_argument("--jar-dir", required=True)
    args = parser.parse_args()

    session = cffi.Session(
        impersonate=IMPERSONATE[0],
        headers={"user-agent": USER_AGENT,
                 "accept-language": "en-US,en;q=0.9",
                 "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
    )

    results = []
    for url in args.urls:
        host = url.split("/")[2]
        jar = Path(args.jar_dir) / f"{host}.json"
        load_jar(session, jar)
        results.append(fetch_one(session, url, jar))
        save_jar(session, jar)

    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
