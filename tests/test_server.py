"""Tests for the sync mailbox server, run against a real server on a free port.

    python3 -m unittest discover -s tests
"""

import http.client
import json
import os
import secrets
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import server  # noqa: E402

BLOB = "1.z.AAAAAAAAAAAAAAAA.ciphertext_-"


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.MailboxStore(self.tmp.name, max_mailboxes=3)
        self.limiter = server.RateLimiter()
        handler = server.make_handler(self.store, self.limiter)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.key = secrets.token_hex(32)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path="/api/sync", body=None, key=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        h = dict(headers or {})
        if key is not False:
            h["Authorization"] = f"Bearer {key or self.key}"
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, (json.loads(raw) if raw else None)

    def test_health(self):
        self.assertEqual(self.call("GET", "/api/health", key=False), (200, {"status": "ok"}))

    def test_rejects_missing_or_malformed_key(self):
        self.assertEqual(self.call("GET", key=False)[0], 401)
        self.assertEqual(self.call("GET", key="not-hex")[0], 401)
        self.assertEqual(self.call("GET", key="AB" * 32)[0], 401)  # upper case is not the format

    def test_round_trip(self):
        self.assertEqual(self.call("GET")[0], 404)
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}), (200, {"rev": 1}))
        self.assertEqual(self.call("GET"), (200, {"rev": 1, "blob": BLOB}))

    def test_stale_revision_is_refused(self):
        self.call("PUT", body={"rev": 0, "blob": BLOB})
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}), (409, {"rev": 1}))
        self.assertEqual(self.call("PUT", body={"rev": 1, "blob": BLOB}), (200, {"rev": 2}))

    def test_mailboxes_are_isolated_by_key(self):
        self.call("PUT", body={"rev": 0, "blob": BLOB})
        self.assertEqual(self.call("GET", key=secrets.token_hex(32))[0], 404)

    def test_file_name_does_not_reveal_the_key(self):
        self.call("PUT", body={"rev": 0, "blob": BLOB})
        names = os.listdir(self.tmp.name)
        self.assertEqual(len(names), 1)
        self.assertNotIn(self.key, names[0])

    def test_rejects_blobs_that_are_not_the_envelope_format(self):
        for blob in ("<script>", "", "1.x.AAAAAAAAAAAAAAAA.abc", "2.z.AAAAAAAAAAAAAAAA.abc", 42):
            self.assertEqual(self.call("PUT", body={"rev": 0, "blob": blob})[0], 400, blob)
        self.assertEqual(self.call("PUT", body=b"not json")[0], 400)
        self.assertEqual(self.call("PUT", body={"blob": BLOB})[0], 400)

    def test_rejects_oversized_blob(self):
        big = "1.z.AAAAAAAAAAAAAAAA." + "a" * (server.MAX_BLOB + 1)
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": big})[0], 413)

    def test_delete(self):
        self.call("PUT", body={"rev": 0, "blob": BLOB})
        self.assertEqual(self.call("DELETE")[0], 204)
        self.assertEqual(self.call("GET")[0], 404)
        self.assertEqual(self.call("DELETE")[0], 404)

    def test_mailbox_cap(self):
        for _ in range(3):
            self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}, key=secrets.token_hex(32))[0], 200)
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}, key=secrets.token_hex(32))[0], 507)

    def test_create_rate_limit_is_per_client_ip(self):
        self.limiter.limits["create"] = (2, 3600)
        ip = {"Cf-Connecting-Ip": "203.0.113.7"}
        for _ in range(2):
            self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}, key=secrets.token_hex(32), headers=ip)[0], 200)
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}, key=secrets.token_hex(32), headers=ip)[0], 429)
        other = {"Cf-Connecting-Ip": "203.0.113.8"}
        self.assertEqual(self.call("PUT", body={"rev": 0, "blob": BLOB}, key=secrets.token_hex(32), headers=other)[0], 200)

    def test_concurrent_writers_never_both_win(self):
        self.call("PUT", body={"rev": 0, "blob": BLOB})
        results = []
        barrier = threading.Barrier(8)

        def write():
            barrier.wait()
            results.append(self.call("PUT", body={"rev": 1, "blob": BLOB})[0])

        threads = [threading.Thread(target=write) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [200] + [409] * 7)


class StoreTest(unittest.TestCase):
    def test_expire_removes_only_idle_mailboxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = server.MailboxStore(tmp)
            old, new = secrets.token_hex(32), secrets.token_hex(32)
            store.write(old, 0, BLOB)
            store.write(new, 0, BLOB)
            past = 1_000_000_000
            os.utime(store.path(old), (past, past))
            self.assertEqual(store.expire(max_idle_days=30), 1)
            self.assertIsNone(store.read(old))
            self.assertIsNotNone(store.read(new))


class RateLimiterTest(unittest.TestCase):
    def test_forgets_idle_clients(self):
        limiter = server.RateLimiter({"req": (5, 60)})
        clock = [0.0]
        limiter.now = lambda: clock[0]
        self.assertTrue(limiter.allow("1.2.3.4", "req"))
        clock[0] = 61
        limiter.sweep()
        self.assertEqual(limiter.tracked(), 0)


if __name__ == "__main__":
    unittest.main()
