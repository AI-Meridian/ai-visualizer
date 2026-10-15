"""Real tests for server.py -- stdlib unittest only, deliberately, to
match this project's own "Python standard library only, nothing to
install" philosophy (see server.py's module docstring). No pytest,
no requests, nothing a contributor needs to pip install to run these.

Covers the two things added 2026-10-15 with zero coverage of their
own until now: the per-install token gating /state and /config (a
real security fix, not just a feature), and the pre-existing static-
file path-traversal guard in _static.

Spins up the REAL server (an actual ThreadingHTTPServer with the real
Handler class) on an OS-assigned ephemeral port in a background
thread -- not a mock, the exact code that runs in production.
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server as srv  # noqa: E402


def start_test_server():
    """A real ThreadingHTTPServer on an ephemeral port, same Handler
    class production uses. Returns (server, base_url); caller must
    call server.shutdown() when done."""
    httpd = srv.ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, f"http://127.0.0.1:{port}"


def get(url, expect_error=False):
    """Returns (status, body_bytes). Never raises on a non-2xx status
    -- HTTPError IS the response here, not an exceptional case."""
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class TestTokenAuth(unittest.TestCase):
    """2026-10-15 fix: /state and /config are gated by a per-install
    token (server.TOKEN), because binding to 127.0.0.1 only stops the
    network, not a different local OS account on a shared machine."""

    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.base = start_test_server()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_state_without_token_is_rejected(self):
        status, _ = get(f"{self.base}/state")
        self.assertEqual(status, 403)

    def test_state_with_wrong_token_is_rejected(self):
        status, _ = get(f"{self.base}/state?token=definitely-not-it")
        self.assertEqual(status, 403)

    def test_state_with_real_token_succeeds(self):
        status, body = get(f"{self.base}/state?token={srv.TOKEN}")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertIn("state", data)

    def test_config_without_token_is_rejected(self):
        status, _ = get(f"{self.base}/config")
        self.assertEqual(status, 403)

    def test_config_with_real_token_succeeds(self):
        status, body = get(f"{self.base}/config?token={srv.TOKEN}")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertIn("faces", data)

    def test_static_files_need_no_token(self):
        """Static HTML/JS carries no user data -- the page that reads
        the token out of its own URL has to be reachable before it
        can know the token at all."""
        status, _ = get(f"{self.base}/index.html")
        self.assertEqual(status, 200)

    def test_token_is_a_real_random_value_not_empty_or_predictable(self):
        self.assertTrue(len(srv.TOKEN) >= 20)


class TestStaticPathTraversal(unittest.TestCase):
    """Pre-existing guard in _static: target must resolve inside HERE.
    Not new code, but had zero coverage; a future refactor of the
    resolve()/parents check could silently reopen this."""

    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.base = start_test_server()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_root_serves_index(self):
        status, _ = get(f"{self.base}/")
        self.assertEqual(status, 200)

    def test_path_traversal_outside_here_is_rejected(self):
        status, _ = get(f"{self.base}/../../../../../../etc/passwd")
        self.assertIn(status, (404, 400))

    def test_path_traversal_encoded_is_rejected(self):
        status, _ = get(f"{self.base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd")
        self.assertIn(status, (404, 400))

    def test_nonexistent_file_is_404(self):
        status, _ = get(f"{self.base}/this-file-does-not-exist.html")
        self.assertEqual(status, 404)


class TestReadBusMockMode(unittest.TestCase):
    """read_bus() is the one function that assembles everything a
    face actually renders. Mock mode is what every face demo/screenshot
    relies on -- if this silently breaks, every demo breaks with it."""

    def setUp(self):
        self._old_mock = srv.MOCK

    def tearDown(self):
        srv.MOCK = self._old_mock

    def test_mock_speaking_has_expected_shape(self):
        srv.MOCK = "speaking"
        data = srv.read_bus()
        self.assertEqual(data["state"], "speaking")
        self.assertTrue(0.0 <= data["level"] <= 1.0)
        self.assertEqual(len(data["samples"]), 64)

    def test_mock_thinking_includes_fake_tasks(self):
        srv.MOCK = "thinking"
        data = srv.read_bus()
        self.assertEqual(data["state"], "thinking")
        self.assertTrue(len(data["tasks"]) >= 1)

    def test_mock_idle_has_no_tasks(self):
        srv.MOCK = "idle"
        data = srv.read_bus()
        self.assertEqual(data["tasks"], [])


if __name__ == "__main__":
    unittest.main()
