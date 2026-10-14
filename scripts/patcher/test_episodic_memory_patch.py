"""Tests for scripts/patcher/episodic-memory-patch (HTTP transport awareness).

Every run uses a temporary HOME and EPISODIC_MEMORY_PLUGIN_ROOT. The plugin
tree is a copy of the real installed version dir (read-only source) with
node_modules and the pinned Node runtime symlinked, so the native-database
probe runs for real. Nothing under the real HOME is written.

    python3 -m unittest scripts/patcher/test_episodic_memory_patch.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW = HERE / "episodic-memory-patch"
ORIG = Path(os.environ.get(
    "EPISODIC_MEMORY_PATCH_ORIG",
    Path.home() / "repos/mcp-fleet-v2/evidence/2026-10-14-episodic/backups/episodic-memory-patch.orig"))
REAL_HOME = Path.home()
REAL_VERSION_DIR = REAL_HOME / ".claude/plugins/cache/superpowers-marketplace/episodic-memory/1.6.0"
REAL_RUNTIME = REAL_HOME / ".local/share/episodic-memory/runtime"
VERSION = "1.6.0"
MANIFESTS = (".mcp.json", ".claude-plugin/plugin.json")
PRISTINE = {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/cli/mcp-server-wrapper.js"]}

missing = [p for p in (ORIG, REAL_VERSION_DIR, REAL_RUNTIME) if not p.exists()]
if missing:
    raise unittest.SkipTest(f"fixture source absent: {missing}")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Tree:
    """A temp HOME + plugin root holding one copied version dir."""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="em-patch-test-"))
        self.home = self.tmp / "home"
        self.root = self.tmp / "plugins"
        self.ver = self.root / VERSION
        self.home.mkdir()
        shutil.copytree(REAL_VERSION_DIR, self.ver, symlinks=True,
                        ignore=shutil.ignore_patterns("node_modules", ".git", ".in_use"))
        # Read-only use only: the probe and ensure_napi_sqlite read through it.
        os.symlink(REAL_VERSION_DIR / "node_modules", self.ver / "node_modules")
        rt = self.home / ".local/share/episodic-memory"
        rt.mkdir(parents=True)
        os.symlink(REAL_RUNTIME, rt / "runtime")
        self.launcher = str(self.home / ".local/bin/episodic-memory-runtime")
        self.state = self.home / ".local/share/mcp-fleet/episodic-memory"
        self.record = self.state / "switch-record.json"
        self.backups = self.home / "repos/mcp-fleet-v2/evidence/2026-10-14-episodic/backups"
        for rel in MANIFESTS:                   # the copied manifests name the REAL launcher
            entry = self.entry(rel)
            entry["command"] = self.launcher
            self.set_entry(rel, entry)
        self.http = {"type": "http", "url": "http://127.0.0.1:8734/mcp",
                     "headersHelper": str(self.state / "headers-helper.sh")}

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def entry(self, rel, ver=None):
        return json.loads(((ver or self.ver) / rel).read_text())["mcpServers"]["episodic-memory"]

    def set_entry(self, rel, entry, ver=None):
        path = (ver or self.ver) / rel
        obj = json.loads(path.read_text())
        obj["mcpServers"]["episodic-memory"] = entry
        path.write_text(json.dumps(obj, indent=2) + "\n")

    def write_record(self, record):
        self.state.mkdir(parents=True, exist_ok=True)
        self.record.write_text(json.dumps(record, indent=2) + "\n")
        self.record.chmod(0o600)

    def run(self, script, *args, pinned=False):
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin",
               "EPISODIC_MEMORY_PLUGIN_ROOT": str(self.root)}
        if pinned:                              # how episodic-memory-runtime calls it
            env["EPISODIC_MEMORY_VERSION_DIR"] = str(self.ver)
        r = subprocess.run([sys.executable, str(script), *args], env=env,
                           capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout, r.stderr

    def snapshot(self):
        """Hash + mtime of every file under the temp tree except node_modules/runtime."""
        out = {}
        for base, dirs, files in os.walk(self.tmp):
            dirs[:] = [d for d in dirs if not (Path(base) / d).is_symlink()]
            for f in files:
                p = Path(base) / f
                if p.is_symlink():
                    continue
                st = p.stat()
                out[str(p)] = (sha(p), st.st_mtime_ns, st.st_mode)
        return out


def switched_record(tree, versions_dir):
    """An active plugin-manifest record for the manifests of versions_dir."""
    files = {}
    for rel in MANIFESTS:
        path = versions_dir / rel
        files[str(path)] = {
            "kind": "json", "key": ["mcpServers", "episodic-memory"],
            "before_entry": {"command": tree.launcher, "args": ["mcp"]},
            "after_entry": dict(tree.http),
            "backup_path": str(tree.backups / ("0123456789-" + path.name)),
        }
    return {"active": True, "mode": "plugin-manifest",
            "created": "2026-10-14T00:00:00+00:00", "files": files}


class Base(unittest.TestCase):
    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.cleanup)
        # Safety precondition: the copied tree must already be fully patched, so
        # apply mode never reaches the npm install path (node_modules is a
        # symlink to the REAL install).
        rc, out, err = self.t.run(ORIG, "--check")
        if rc != 0:
            self.fail(f"fixture tree is not clean under the original --check:\n{out}{err}")

    def norm(self, text):
        return text.replace(str(self.t.tmp), "<TMP>")


class InactiveRecordIsIdentical(Base):
    """Absent / inactive / unreadable record: new == original, byte for byte."""

    def record_variants(self):
        yield "absent", None
        yield "inactive", {**switched_record(self.t, self.t.ver), "active": False}
        yield "unreadable", "{not json"
        yield "active-not-true", {**switched_record(self.t, self.t.ver), "active": "yes"}

    def apply_variant(self, tree, variant):
        if variant is None:
            return
        tree.state.mkdir(parents=True, exist_ok=True)
        if isinstance(variant, str):
            tree.record.write_text(variant)
        else:
            tree.write_record(variant)

    def compare_check(self, label):
        a = self.t.run(ORIG, "--check")
        b = self.t.run(NEW, "--check")
        self.assertEqual(a, b, f"{label}: --check differs")
        return a

    def test_check_identical_clean_tree(self):
        for name, variant in self.record_variants():
            with self.subTest(record=name):
                self.apply_variant(self.t, variant)
                rc, out, _ = self.compare_check(name)
                self.assertEqual(rc, 0)
                self.assertIn("pinned-runtime already applied", out)

    def test_check_identical_unpinned_and_unknown(self):
        cases = {"pristine-node": PRISTINE,
                 "unknown-command": {"command": "/usr/bin/python3", "args": []},
                 "http-without-record": dict(self.t.http)}
        for case, entry in cases.items():
            for name, variant in self.record_variants():
                with self.subTest(case=case, record=name):
                    self.t.set_entry(".mcp.json", entry)
                    self.apply_variant(self.t, variant)
                    rc, _, _ = self.compare_check(f"{case}/{name}")
                    self.assertEqual(rc, 1 if case == "pristine-node" else 2)

    def test_apply_identical_on_separate_copies(self):
        for name, variant in self.record_variants():
            with self.subTest(record=name):
                results = []
                for script in (ORIG, NEW):
                    tree = Tree()
                    try:
                        tree.set_entry(".mcp.json", PRISTINE)
                        tree.set_entry(".claude-plugin/plugin.json", PRISTINE)
                        self.apply_variant(tree, variant)
                        rc, out, err = tree.run(script)
                        norm = lambda x: json.loads(json.dumps(x).replace(str(tree.tmp), "<TMP>"))
                        results.append((rc, norm(out), norm(err),
                                        norm(tree.entry(".mcp.json")),
                                        norm(tree.entry(".claude-plugin/plugin.json")),
                                        (tree.ver / ".mcp.json").stat().st_mode,
                                        tree.record.exists() and tree.record.read_bytes()))
                    finally:
                        tree.cleanup()
                orig, new = results
                self.assertEqual(orig, new)
                self.assertIn("FIXED .mcp.json: pinned-runtime", new[1])
                self.assertEqual(new[0], 0)


class ActivePluginManifest(Base):
    def switch_current(self):
        record = switched_record(self.t, self.t.ver)
        for rel in MANIFESTS:
            self.t.set_entry(rel, dict(self.t.http))
        self.t.write_record(record)
        return record

    def new_version_record(self, extra=None):
        """Record covers an OLDER version dir; the copied 1.6.0 is 'newly installed'."""
        old = self.t.root / "1.5.0"
        record = switched_record(self.t, old)
        record.update(extra or {})
        self.t.write_record(record)
        return record

    def test_recorded_switched_manifests_pass_check(self):
        self.switch_current()
        rc, out, err = self.t.run(NEW, "--check")
        self.assertEqual(rc, 0, out + err)
        for rel in MANIFESTS:
            self.assertIn(f"  ok    {rel}: transport-http present", out)
        self.assertNotIn("FAIL", out)
        self.assertIn("database vector query under pinned", out)
        # The original refuses this state; that is the bug being fixed.
        self.assertEqual(self.t.run(ORIG, "--check")[0], 2)
        # Same verdict when the version dir is pinned the way the runtime wrapper does.
        rc, pinned_out, _ = self.t.run(NEW, "--check", pinned=True)
        self.assertEqual((rc, pinned_out), (0, out))

    def test_typed_stdio_entry_is_switched(self):
        for rel in MANIFESTS:
            self.t.set_entry(rel, {"type": "stdio", **PRISTINE})
        self.new_version_record()
        rc, out, err = self.t.run(NEW, pinned=True)
        self.assertEqual(rc, 0, out + err)
        for rel in MANIFESTS:
            self.assertIn(f"  FIXED {rel}: transport-http", out)
            self.assertEqual(self.t.entry(rel), self.t.http)

    def test_new_version_check_reports_missing_and_writes_nothing(self):
        for form in ("launcher", "pristine"):
            with self.subTest(form=form):
                if form == "pristine":
                    for rel in MANIFESTS:
                        self.t.set_entry(rel, PRISTINE)
                self.new_version_record({"failed": "x", "sentinel": [1]})
                before = self.t.snapshot()
                rc, out, err = self.t.run(NEW, "--check")
                self.assertEqual(rc, 1, out + err)
                for rel in MANIFESTS:
                    self.assertIn(f"  WOULD {rel}: transport-http missing", out)
                self.assertIn("STALE 2 patch(es) missing: .mcp.json:transport-http, "
                              ".claude-plugin/plugin.json:transport-http", out)
                self.assertEqual(self.t.snapshot(), before, "--check wrote something")
                self.assertFalse(self.t.backups.exists())

    def test_new_version_apply_switches_records_and_rechecks_ok(self):
        self.t.set_entry(".claude-plugin/plugin.json", PRISTINE)
        (self.t.ver / ".mcp.json").chmod(0o644)
        (self.t.ver / ".claude-plugin/plugin.json").chmod(0o640)
        originals = {rel: (self.t.ver / rel).read_bytes() for rel in MANIFESTS}
        befores = {rel: self.t.entry(rel) for rel in MANIFESTS}
        old = self.new_version_record({"failed": "earlier failure", "unresolved": [],
                                       "sentinel": {"keep": True}})
        rc, out, err = self.t.run(NEW)
        self.assertEqual(rc, 0, out + err)
        for rel in MANIFESTS:
            self.assertIn(f"  FIXED {rel}: transport-http", out)
        self.assertNotIn("FAIL", out)

        rec = json.loads(self.t.record.read_text())
        self.assertEqual(self.t.record.stat().st_mode & 0o777, 0o600)
        for k in ("active", "mode", "created", "failed", "unresolved", "sentinel"):
            self.assertEqual(rec[k], old[k], k)
        for path, info in old["files"].items():
            self.assertEqual(rec["files"][path], info)
        self.assertEqual(len(rec["files"]), 4)
        for rel, mode in ((".mcp.json", 0o644), (".claude-plugin/plugin.json", 0o640)):
            path = self.t.ver / rel
            info = rec["files"][str(path)]
            self.assertEqual(info["kind"], "json")
            self.assertEqual(info["key"], ["mcpServers", "episodic-memory"])
            self.assertEqual(info["before_entry"], befores[rel])
            self.assertEqual(info["after_entry"], self.t.http)
            self.assertEqual(self.t.entry(rel), self.t.http)
            self.assertEqual(path.stat().st_mode & 0o777, mode, f"{rel} mode not preserved")
            backup = Path(info["backup_path"])
            self.assertEqual(backup.parent, self.t.backups)
            self.assertEqual(backup.read_bytes(), originals[rel])
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            # Unrelated manifest content survives.
            obj = json.loads(path.read_text())
            self.assertEqual({k: v for k, v in obj.items() if k != "mcpServers"},
                             {k: v for k, v in json.loads(originals[rel]).items() if k != "mcpServers"})

        rc, out, err = self.t.run(NEW, "--check")
        self.assertEqual(rc, 0, out + err)
        for rel in MANIFESTS:
            self.assertIn(f"  ok    {rel}: transport-http present", out)
        snap = self.t.snapshot()
        rc, out, _ = self.t.run(NEW)            # idempotent
        self.assertEqual(rc, 0)
        self.assertNotIn("FIXED", out)
        self.assertEqual(self.t.snapshot(), snap)

    def test_hook_mode_applies_and_reports_fix(self):
        self.new_version_record()
        r = subprocess.run([sys.executable, str(NEW), "--hook"],
                           env={"HOME": str(self.t.home), "PATH": "/usr/bin:/bin",
                                "EPISODIC_MEMORY_PLUGIN_ROOT": str(self.t.root)},
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0)
        msg = json.loads(r.stdout)["systemMessage"]
        self.assertIn("FIXED .mcp.json: transport-http", msg)
        self.assertEqual(self.t.entry(".mcp.json"), self.t.http)

    def test_unknown_entries_fail_and_are_not_touched(self):
        cases = {
            "unrecorded-other-command": ({"command": "/usr/bin/python3", "args": ["x"]}, False),
            "unrecorded-other-http": ({"type": "http", "url": "http://127.0.0.1:9999/mcp"}, False),
            "unrecorded-non-dict": ("not-an-object", False),
            "recorded-but-drifted": ({"command": "/usr/bin/python3", "args": ["x"]}, True),
            "recorded-but-stdio": (None, True),     # launcher form, but the path is recorded
        }
        for case, (entry, recorded) in cases.items():
            with self.subTest(case=case):
                t = Tree()
                try:
                    if entry is not None:
                        t.set_entry(".mcp.json", entry)
                    if recorded:
                        t.set_entry(".claude-plugin/plugin.json", dict(t.http))
                        t.write_record(switched_record(t, t.ver))
                    else:
                        t.write_record(switched_record(t, t.root / "1.5.0"))
                    expected = t.entry(".mcp.json")
                    for args in (["--check"], []):
                        snap = t.snapshot()
                        rc, out, err = t.run(NEW, *args)
                        self.assertEqual(rc, 2, out + err)
                        self.assertRegex(out, r"  FAIL  \.mcp\.json: (unknown MCP entry|"
                                              r"episodic-memory entry differs)")
                        self.assertNotIn("FIXED .mcp.json", out)
                        self.assertIn("database vector query under pinned", out)
                        self.assertEqual(t.entry(".mcp.json"), expected)
                        if args == ["--check"]:
                            self.assertEqual(t.snapshot(), snap)
                finally:
                    t.cleanup()

    def test_no_recorded_http_entry_fails_closed(self):
        self.t.write_record({"active": True, "mode": "plugin-manifest",
                             "created": "2026-10-14T00:00:00+00:00", "files": {}})
        rc, out, _ = self.t.run(NEW)
        self.assertEqual(rc, 2)
        self.assertIn("0 distinct HTTP manifest entries", out)
        self.assertNotEqual(self.t.entry(".mcp.json"), self.t.http)

    def test_existing_backup_with_other_content_is_not_overwritten(self):
        self.new_version_record()
        path = self.t.ver / ".mcp.json"
        name = hashlib.sha256(str(path).encode()).hexdigest()[:10] + "-.mcp.json"
        self.t.backups.mkdir(parents=True)
        (self.t.backups / name).write_text("something else\n")
        rec_before = sha(self.t.record)
        rc, out, _ = self.t.run(NEW)
        self.assertEqual(rc, 2)
        self.assertIn("already exists with different content", out)
        self.assertEqual((self.t.backups / name).read_text(), "something else\n")
        self.assertNotEqual(self.t.entry(".mcp.json"), self.t.http)
        self.assertNotIn(str(path), json.loads(self.t.record.read_text())["files"])
        # plugin.json was still handled on its own.
        self.assertIn("FIXED .claude-plugin/plugin.json: transport-http", out)
        self.assertNotEqual(sha(self.t.record), rec_before)


class ActiveUserScope(Base):
    def test_user_scope_fails_closed_and_probe_still_runs(self):
        record = switched_record(self.t, self.t.ver)
        record["mode"] = "user-scope"
        self.t.write_record(record)
        for args in (["--check"], []):
            snap = self.t.snapshot()
            rc, out, err = self.t.run(NEW, *args)
            self.assertEqual(rc, 2, out + err)
            self.assertIn("  FAIL  user-scope persistence not implemented", out)
            self.assertIn("database vector query under pinned", out)
            self.assertEqual(self.t.snapshot(), snap)

    def test_unknown_mode_fails_closed(self):
        record = switched_record(self.t, self.t.ver)
        record["mode"] = "something-else"
        self.t.write_record(record)
        rc, out, _ = self.t.run(NEW, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("switch record mode 'something-else' unknown", out)


if __name__ == "__main__":
    unittest.main()
