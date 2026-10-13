"""Hermes Gateway hook: signed lifecycle metadata -> Cloudflare Worker.

Install as ~/.hermes/hooks/vm-task-monitor/handler.py
Private config: ~/.hermes/vm-task-monitor.json (mode 0600)
The config file is never committed to Git.
"""
import asyncio
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

HOME = Path.home() / ".hermes"
CONFIG = HOME / "vm-task-monitor.json"
LOG = HOME / "hooks" / "vm-task-monitor" / "activity.log"


def send_signed(url, secret, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    request = Request(
        url.rstrip("/") + "/hermes-event",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Hermes-Signature-256": "sha256=" + digest,
        },
        method="POST",
    )
    with urlopen(request, timeout=4) as response:
        if response.status != 200:
            raise RuntimeError("Unexpected HTTP status " + str(response.status))


async def handle(event_type: str, context: dict):
    now = datetime.now(timezone.utc).isoformat()
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"time": now, "event": event_type}) + "\n")

    if event_type not in ("agent:start", "agent:step", "agent:end"):
        return
    session = str(context.get("session_id") or "")
    if not session or not CONFIG.exists():
        return

    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        url = str(cfg.get("worker_url") or "")
        secret = str(cfg.get("secret") or "")
        if not url.startswith("https://") or len(secret) < 32:
            return
        payload = {
            "event": event_type,
            "session_id": session,
            "timestamp": int(time.time()),
            "delivery_id": uuid.uuid4().hex,
        }
        await asyncio.to_thread(send_signed, url, secret, payload)
    except Exception as exc:
        # No secret or sensitive conversation text is logged.
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "time": now,
                "bridge_error": type(exc).__name__,
            }) + "\n")
