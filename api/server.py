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
MAX_MAILBOXES = int(os.environ.get("MAX_MAILBOXES", "5000"))
EXPIRE_DAYS = int(os.environ.get("EXPIRE_DAYS", "400"))
# The header carrying the visitor's address, set by the proxy in front. Behind
# Cloudflare that is Cf-Connecting-Ip. Without a trusted proxy, leave it empty
# so a client cannot pick its own rate-limit bucket by sending the header.
CLIENT_IP_HEADER = os.environ.get("CLIENT_IP_HEADER", "Cf-Connecting-Ip")

MAX_BLOB = 350_000  # base64 characters, about 256 KB of ciphertext
MAX_BODY = MAX_BLOB + 1024
SOCKET_TIMEOUT = 15  # seconds; a slow or idle client cannot hold a thread

KEY_RE = re.compile(r"^[0-9a-f]{64}$")
# "1.<z|n>.<iv>.<ciphertext>", base64url parts: see encryptState() in src/js/crypto.js.
BLOB_RE = re.compile(r"^1\.[zn]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$")

log = logging.getLogger("billable-api")


class RateLimiter:
    """Sliding-window limits per client and kind of request.

    Entries for clients that have gone quiet are swept, so the table cannot
    grow without bound however many addresses it sees.
    """

    DEFAULTS = {
        "req": (240, 600),     # an open tab polls about twice a minute
        "create": (10, 3600),  # new mailboxes
    }

    def __init__(self, limits=None):
        self.limits = dict(limits or self.DEFAULTS)
        self.now = time.monotonic
        self._events = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, client, kind):
        count, window = self.limits[kind]
        now = self.now()
        with self._lock:
            q = self._events[(kind, client)]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= count:
                return False
            q.append(now)
            return True

    def sweep(self):
        now = self.now()
        with self._lock:
            for k in [k for k, q in self._events.items() if not q or now - q[-1] > self.limits[k[0]][1]]:
                del self._events[k]

    def tracked(self):
        with self._lock:
            return len(self._events)


class StaleRevision(Exception):
    def __init__(self, current):
        super().__init__(current)
        self.current = current


class StoreFull(Exception):
    pass


class MailboxStore:
    """One JSON file per mailbox, written atomically."""

    def __init__(self, root, max_mailboxes=MAX_MAILBOXES):
        self.root = root
        self.max_mailboxes = max_mailboxes
        self._lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def path(self, key):
        return os.path.join(self.root, hashlib.sha256(key.encode()).hexdigest() + ".json")

    def exists(self, key):
        return os.path.exists(self.path(key))

    def read(self, key, touch=False):
        path = self.path(key)
        try:
            with open(path, encoding="utf-8") as fh:
                box = json.load(fh)
            if touch:
                os.utime(path)  # reading counts as activity for expiry
        except FileNotFoundError:  # absent, or expired between open and utime
            return None
        except ValueError:  # a torn or corrupt file: treat as empty so the owner can rewrite it
            log.warning("unreadable mailbox file %s", os.path.basename(path))
            return None
        return box

    def write(self, key, expected, blob):
        """Store blob if the mailbox is still at revision `expected`. Returns the new revision."""
        path = self.path(key)
        with self._lock:
            box = self.read(key)
            current = box["rev"] if box else 0
            if expected != current:
                raise StaleRevision(current)
            if box is None and self.count() >= self.max_mailboxes:
                raise StoreFull()
            fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".tmp-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump({"rev": current + 1, "blob": blob, "updated": int(time.time())}, fh, separators=(",", ":"))
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except FileNotFoundError:
                    pass
                raise
            return current + 1

    def delete(self, key):
        with self._lock:
            try:
                os.unlink(self.path(key))
                return True
            except FileNotFoundError:
                return False

    def count(self):
        return sum(1 for n in os.listdir(self.root) if n.endswith(".json"))

    def expire(self, max_idle_days=EXPIRE_DAYS):
        """Delete mailboxes nobody has read or written for max_idle_days."""
        cutoff = time.time() - max_idle_days * 86400
        removed = 0
        with self._lock:
            for name in os.listdir(self.root):
                path = os.path.join(self.root, name)
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.unlink(path)
                        removed += 1
                except FileNotFoundError:
                    pass
        return removed


def make_handler(store, limiter, client_ip_header=CLIENT_IP_HEADER):
    class Handler(BaseHTTPRequestHandler):
        server_version = "billable-sync/2"
        protocol_version = "HTTP/1.1"
        timeout = SOCKET_TIMEOUT

        def log_message(self, fmt, *args):
            # No client address: the request line and status only. The key
            # travels in a header and is never logged.
            log.info("%s", fmt % args)

        def reply(self, code, obj=None, close=False):
            payload = b"" if obj is None else json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(code)
            if obj is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            if close:
                # The request body was not read; reusing the connection would
                # parse it as the next request.
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(payload)

        def client(self):
            return (client_ip_header and self.headers.get(client_ip_header)) or self.headers.get("X-Real-IP") or self.client_address[0]

        def access_key(self):
            auth = self.headers.get("Authorization") or ""
            key = auth[7:].strip() if auth.startswith("Bearer ") else ""
            return key if KEY_RE.match(key) else None

        def authorise(self):
            """Shared checks for /api/sync. Returns the access key, or None after replying."""
            if self.path.split("?")[0].rstrip("/") != "/api/sync":
                self.reply(404, {"error": "not found"}, close=True)
                return None
            if not limiter.allow(self.client(), "req"):
                self.reply(429, {"error": "too many requests"}, close=True)
                return None
            key = self.access_key()
            if not key:
                self.reply(401, {"error": "missing or malformed sync key"}, close=True)
            return key

        def do_GET(self):
            if self.path.split("?")[0] in ("/api/health", "/health"):
                ok = os.access(store.root, os.W_OK)
                self.reply(200 if ok else 503, {"status": "ok" if ok else "data dir not writable"})
                return
            key = self.authorise()
            if not key:
                return
            box = store.read(key, touch=True)
            if box is None:
                self.reply(404, {"error": "no mailbox"})
            else:
                self.reply(200, {"rev": box["rev"], "blob": box["blob"]})

        def do_PUT(self):
            key = self.authorise()
            if not key:
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length > MAX_BODY:
                self.reply(413, {"error": "synced data is too large"}, close=True)
                return
            if length <= 0:
                self.reply(400, {"error": "expected {rev, blob}"}, close=True)
                return
            try:
                body = json.loads(self.rfile.read(length))
                expected, blob = body["rev"], body["blob"]
                # bool is an int subclass; reject it, and floats like 1e999.
                if type(expected) is not int or expected < 0:
                    raise ValueError
                if not isinstance(blob, str) or not BLOB_RE.match(blob):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                self.reply(400, {"error": "expected {rev, blob}"})
                return
            if len(blob) > MAX_BLOB:
                self.reply(413, {"error": "synced data is too large"})
                return
            # Counted before writing, outside the store lock.
            if not store.exists(key) and not limiter.allow(self.client(), "create"):
                self.reply(429, {"error": "too many new mailboxes"})
                return
            try:
                rev = store.write(key, expected, blob)
            except StaleRevision as e:
                self.reply(409, {"rev": e.current})
                return
            except StoreFull:
                self.reply(507, {"error": "sync storage is full"})
                return
            self.reply(200, {"rev": rev})

        def do_DELETE(self):
            key = self.authorise()
            if not key:
                return
            if store.delete(key):
                self.reply(204)
            else:
                self.reply(404, {"error": "no mailbox"})

    return Handler


def housekeeping(store, limiter):
    """Daily expiry of idle mailboxes, sweeping of idle rate-limit entries every minute."""
    last_expiry = 0.0
    while True:
        try:
            limiter.sweep()
            if time.time() - last_expiry > 86400:
                last_expiry = time.time()
                removed = store.expire()
                if removed:
                    log.info("expired %d idle mailbox(es)", removed)
        except Exception:  # keep the loop alive; a dead housekeeper is silent
            log.exception("housekeeping failed; will retry")
        time.sleep(60)


def main():
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = MailboxStore(DATA_DIR)
    limiter = RateLimiter()
    threading.Thread(target=housekeeping, args=(store, limiter), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(store, limiter))
    server.daemon_threads = True
    log.info("billable sync listening on %d, data in %s", PORT, DATA_DIR)
    server.serve_forever()


if __name__ == "__main__":
    main()
