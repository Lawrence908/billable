"""Billable sync mailbox.

Stdlib only. Stores one opaque, client-encrypted blob per mailbox and nothing
else: no names, no hours, no accounts. The browser derives two keys from the
user's passphrase; it sends one (the access key) in the Authorization header
and keeps the other (the encryption key) to itself. This server never sees the
passphrase or the encryption key, so it cannot read what it stores.

A mailbox file is named sha256(access key), so even a listing of the data
directory does not reveal the keys needed to fetch from it.

    GET    /api/sync     -> 200 {"rev", "blob"} | 404
    PUT    /api/sync     {"rev": <expected>, "blob": "..."} -> 200 {"rev"} | 409 {"rev"}
    DELETE /api/sync     -> 204 | 404
    GET    /api/health   -> 200 {"status":"ok"} when the data dir is writable
"""

import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
DATA_DIR = os.environ.get("DATA_DIR", "/app/data/mailboxes")
MAX_BLOB = int(os.environ.get("MAX_BLOB", str(350_000)))  # base64 chars, ~256 KB of ciphertext
MAX_BODY = MAX_BLOB + 1024
MAX_MAILBOXES = int(os.environ.get("MAX_MAILBOXES", "5000"))
EXPIRE_DAYS = int(os.environ.get("EXPIRE_DAYS", "400"))

# Per client IP, sliding windows: (max events, window seconds).
REQUEST_LIMIT = (240, 600)  # an open tab polls about twice a minute
CREATE_LIMIT = (10, 3600)   # new mailboxes

KEY_RE = re.compile(r"^[0-9a-f]{64}$")
# "1.<z|n>.<iv>.<ciphertext>", base64url parts: see encryptState() in app.js.
BLOB_RE = re.compile(r"^1\.[zn]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$")

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("billable-api")

_lock = threading.Lock()
_events = defaultdict(lambda: defaultdict(deque))


def allow(ip, kind, limit):
    """Sliding-window rate limit. Returns False once `limit` is exceeded."""
    count, window = limit
    now = time.monotonic()
    with _lock:
        q = _events[kind][ip]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= count:
            return False
        q.append(now)
        return True


def mailbox_path(key):
    return os.path.join(DATA_DIR, hashlib.sha256(key.encode()).hexdigest() + ".json")


def read_box(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def write_box(path, box):
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(box, fh, separators=(",", ":"))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def mailbox_count():
    return sum(1 for n in os.listdir(DATA_DIR) if n.endswith(".json"))


def expire_loop():
    """Delete mailboxes nobody has read or written for EXPIRE_DAYS."""
    while True:
        cutoff = time.time() - EXPIRE_DAYS * 86400
        removed = 0
        for name in os.listdir(DATA_DIR):
            path = os.path.join(DATA_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.unlink(path)
                    removed += 1
            except FileNotFoundError:
                pass
        if removed:
            log.info("expired %d idle mailbox(es)", removed)
        time.sleep(86400)


class Handler(BaseHTTPRequestHandler):
    server_version = "billable-sync/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # The path carries nothing secret; the key travels in a header and is never logged.
        log.info("%s", fmt % args)

    def _send(self, code, obj=None):
        payload = b"" if obj is None else json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _ip(self):
        return self.headers.get("Cf-Connecting-Ip") or self.headers.get("X-Real-IP") or self.client_address[0]

    def _key(self):
        auth = self.headers.get("Authorization") or ""
        key = auth[7:].strip() if auth.startswith("Bearer ") else ""
        return key if KEY_RE.match(key) else None

    def _route(self):
        """Common checks for /api/sync. Returns (path, ip) or None after replying."""
        if self.path.split("?")[0].rstrip("/") != "/api/sync":
            self._send(404, {"error": "not found"})
            return None
        ip = self._ip()
        if not allow(ip, "req", REQUEST_LIMIT):
            self._send(429, {"error": "too many requests"})
            return None
        key = self._key()
        if not key:
            self._send(401, {"error": "missing or malformed sync key"})
            return None
        return mailbox_path(key), ip

    def do_GET(self):
        if self.path.split("?")[0] in ("/api/health", "/health"):
            ok = os.access(DATA_DIR, os.W_OK)
            self._send(200 if ok else 503, {"status": "ok" if ok else "data dir not writable"})
            return
        routed = self._route()
        if not routed:
            return
        path, _ = routed
        box = read_box(path)
        if box is None:
            self._send(404, {"error": "no mailbox"})
            return
        os.utime(path)  # reading counts as activity for expiry
        self._send(200, {"rev": box["rev"], "blob": box["blob"]})

    def do_PUT(self):
        routed = self._route()
        if not routed:
            return
        path, ip = routed
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(413, {"error": "body too large or empty"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            expected = int(body["rev"])
            blob = body["blob"]
            if not isinstance(blob, str) or not blob or len(blob) > MAX_BLOB or not BLOB_RE.match(blob):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self._send(400, {"error": "expected {rev, blob}"})
            return

        # Counted before the lock because allow() takes the same lock.
        if not os.path.exists(path) and not allow(ip, "create", CREATE_LIMIT):
            self._send(429, {"error": "too many new mailboxes"})
            return
        with _lock:
            box = read_box(path)
            current = box["rev"] if box else 0
            if expected != current:
                self._send(409, {"rev": current})
                return
            if box is None and mailbox_count() >= MAX_MAILBOXES:
                self._send(507, {"error": "sync storage is full"})
                return
            write_box(path, {"rev": current + 1, "blob": blob, "updated": int(time.time())})
        self._send(200, {"rev": current + 1})

    def do_DELETE(self):
        routed = self._route()
        if not routed:
            return
        path, _ = routed
        with _lock:
            try:
                os.unlink(path)
            except FileNotFoundError:
                self._send(404, {"error": "no mailbox"})
                return
        self._send(204)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    threading.Thread(target=expire_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("billable sync listening on %d, data in %s", PORT, DATA_DIR)
    server.serve_forever()


if __name__ == "__main__":
    main()
