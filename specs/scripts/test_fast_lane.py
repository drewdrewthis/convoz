"""Tests for scripts/fast_lane.py. Run: python3 -I specs/scripts/test_fast_lane.py"""
import importlib.util
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location("fast_lane", os.path.join(ROOT, "scripts", "fast_lane.py"))
fl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fl)


class FastLane(unittest.TestCase):
    def test_eligible(self):
        files = ["apps/web/src/features/plan/Plan.tsx", "apps/web/src/styles/app.css", "specs/features/x.feature"]
        self.assertEqual(fl.check(files), [])

    def test_service_worker_change(self):
        for f in ("apps/web/src/sw/worker.ts", "apps/web/src/main.tsx"):
            self.assertEqual([b[0] for b in fl.check([f])], [f])

    def test_auth_change(self):
        for f in ("apps/web/src/features/auth/SignIn.tsx", "apps/web/src/shared/ceremony.ts"):
            self.assertEqual([b[0] for b in fl.check([f])], [f])

    def test_write_call_added(self):
        bad = fl.check(["apps/web/src/features/plan/Plan.tsx"], lambda f: ['client.POST("/api/x")'])
        self.assertEqual(len(bad), 1)
        self.assertIn("write call", bad[0][1])

    def test_write_call_pattern(self):
        for s in ('client.POST("/a")', 'fetch(u, { method: "DELETE" })', "http.put(u)"):
            self.assertTrue(fl.WRITE_CALL.search(s), s)
        self.assertFalse(fl.WRITE_CALL.search('client.GET("/a")'))

    def test_build_config_and_outside_path(self):
        for f in ("apps/web/vite.config.ts", "apps/web/package.json", "apps/web/index.html", "apps/web/tsconfig.json"):
            self.assertEqual([b[0] for b in fl.check([f])], [f])
        bad = fl.check(["server/main.go"])
        self.assertIn("outside", bad[0][1])


if __name__ == "__main__":
    unittest.main()
