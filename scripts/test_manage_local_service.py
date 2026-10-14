"""Tests for manage-local-service.py. Everything runs against a temporary HOME (EM_TEST_HOME);
install/probe side effects (launchctl, npm, node) are never exercised here."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="em-test-home-")
os.environ["EM_TEST_HOME"] = _TMP
_SPEC = importlib.util.spec_from_file_location(
    "mls", Path(__file__).resolve().parent / "manage-local-service.py")
mls = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mls)

CODEX = '''[mcp_servers.outlook]
url = "http://127.0.0.1:8733/mcp"

# --- episodic-memory block ---
[mcp_servers.episodic-memory]
command = "/Users/x/.codex/episodic-memory-launch.sh"
startup_timeout_sec = 90.0
tool_timeout_sec = 120.0

# --- end episodic-memory block ---
[mcp_servers.mongodb]
url = "http://127.0.0.1:3010/mcp"
'''
TOKEN = "t" * 48
OLD_PREFIX = "mcp__plugin_episodic-memory_episodic-memory__"
NEW_PREFIX = "mcp__episodic-memory__"
STDIO = {"command": "/Users/x/.local/bin/episodic-memory-runtime", "args": ["mcp"]}
AGENT = f"---\ntools: Read, {OLD_PREFIX}search, {OLD_PREFIX}read\n---\nUse {OLD_PREFIX}search.\n"


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def jread(path):
    return json.loads(Path(path).read_text())


def check_replace_failing(*nths):
    """os.replace wrapper that raises on the nth replaces that are not the switch record or a backup."""
    real, state = os.replace, {"n": 0}

    def fake(src, dst, *a, **k):
        if Path(dst) != mls.RECORD and mls.EVIDENCE not in Path(dst).parents:
            state["n"] += 1
            if state["n"] in nths:
                raise OSError("injected failure")
        return real(src, dst, *a, **k)
    return fake


class Base(unittest.TestCase):
    def setUp(self):
        home = Path(_TMP)
        for child in home.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        mls.STATE.mkdir(parents=True, mode=0o700)
        write(mls.TOKEN, TOKEN)
        write(mls.CODEX_CONFIG, CODEX)
        self.plugin = home / ".claude/plugins/cache/superpowers-marketplace/episodic-memory/1.0.0"
        write(self.plugin / ".mcp.json", json.dumps({"mcpServers": {"episodic-memory": dict(STDIO)}}))
        write(self.plugin / ".claude-plugin/plugin.json", json.dumps(
            {"name": "episodic-memory", "version": "1.0.0", "keywords": ["a"],
             "mcpServers": {"episodic-memory": dict(STDIO, env={"A": "1"})}}, indent=2))
        write(self.plugin / "agents/search-conversations.md", AGENT)
        write(mls.INSTALLED_PLUGINS, json.dumps({"plugins": {
            "episodic-memory@superpowers-marketplace": [
                {"scope": "user", "installPath": str(self.plugin), "version": "1.0.0"}]}}))
        write(mls.CLAUDE_JSON, json.dumps({"numStartups": 3, "mcpServers": {"other": {"command": "x"}}}, indent=2))
        self.entry = mls.claude_entry(mls.URL, str(mls.HEADERS_HELPER))

    def mcp(self):
        return jread(self.plugin / ".mcp.json")["mcpServers"]["episodic-memory"]

    def pj(self):
        return jread(self.plugin / ".claude-plugin/plugin.json")

    def all_bytes(self):
        return {str(p): p.read_bytes() for p in [mls.CODEX_CONFIG, mls.CLAUDE_JSON,
                self.plugin / ".mcp.json", self.plugin / ".claude-plugin/plugin.json",
                self.plugin / "agents/search-conversations.md"]}


class CodexPureTests(Base):
    def test_switch_only_touches_episodic_block(self):
        out = mls.codex_switch(CODEX, mls.URL, TOKEN)
        self.assertIn('url = "http://127.0.0.1:8734/mcp"', out)
        self.assertIn(f'http_headers = {{ Authorization = "Bearer {TOKEN}" }}', out)
        self.assertNotIn("episodic-memory-launch.sh", out)
        self.assertIn("tool_timeout_sec = 120.0", out)
        self.assertIn("startup_timeout_sec = 90.0", out)
        self.assertEqual(out.replace(out[out.index("[mcp_servers.episodic-memory]"):out.index("# --- end")], ""),
                         CODEX.replace(CODEX[CODEX.index("[mcp_servers.episodic-memory]"):CODEX.index("# --- end")], ""))

    def test_restore_replaces_only_block_and_detects_drift(self):
        original = mls.extract_block(CODEX)
        switched = mls.codex_switch(CODEX, mls.URL, TOKEN)
        block = mls.extract_block(switched)
        self.assertEqual(mls.codex_restore(switched, block, original), CODEX)
        edited = switched.replace("120.0", "300.0")
        with self.assertRaises(mls.DriftError):
            mls.codex_restore(edited, block, original)

    def test_claude_entry_has_no_token(self):
        self.assertEqual(self.entry, {"type": "http", "url": mls.URL, "headersHelper": str(mls.HEADERS_HELPER)})

    def test_registered_plugin_dir(self):
        self.assertEqual(mls.registered_plugin_dir(), self.plugin)
        data = jread(mls.INSTALLED_PLUGINS)
        data["plugins"]["episodic-memory@superpowers-marketplace"].append({"scope": "user", "installPath": "/y"})
        write(mls.INSTALLED_PLUGINS, json.dumps(data))
        with self.assertRaises(mls.PreflightError):
            mls.registered_plugin_dir()


class ManifestSwitchTests(Base):
    def test_manifest_switch_writes_entry_everywhere_without_token(self):
        mls.Switcher("plugin-manifest").apply()
        self.assertEqual(self.mcp(), self.entry)
        pj = self.pj()
        self.assertEqual(pj["mcpServers"]["episodic-memory"], self.entry)
        self.assertEqual(pj["keywords"], ["a"])
        self.assertEqual(pj["name"], "episodic-memory")
        for p in (self.plugin / ".mcp.json", self.plugin / ".claude-plugin/plugin.json", mls.CLAUDE_JSON):
            self.assertNotIn(TOKEN, p.read_text())
        self.assertIn(f'Bearer {TOKEN}', mls.CODEX_CONFIG.read_text())
        rec = jread(mls.RECORD)
        self.assertTrue(rec["active"])
        self.assertEqual(rec["mode"], "plugin-manifest")
        self.assertEqual(stat.S_IMODE(mls.RECORD.stat().st_mode), 0o600)
        self.assertEqual(len(rec["files"]), 3)
        for info in rec["files"].values():
            self.assertEqual(stat.S_IMODE(Path(info["backup_path"]).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(mls.CODEX_CONFIG.stat().st_mode), 0o600)
        self.assertEqual(mls.CLAUDE_JSON.read_text(), json.dumps(
            {"numStartups": 3, "mcpServers": {"other": {"command": "x"}}}, indent=2))

    def test_second_run_is_noop_and_backups_unchanged(self):
        mls.Switcher("plugin-manifest").apply()
        rec1 = mls.RECORD.read_bytes()
        files1 = self.all_bytes()
        backups1 = {p: p.read_bytes() for p in mls.EVIDENCE.rglob("*") if p.is_file()}
        mls.Switcher("plugin-manifest").apply()
        self.assertEqual(self.all_bytes(), files1)
        self.assertEqual(mls.RECORD.read_bytes(), rec1)
        self.assertEqual({p: p.read_bytes() for p in mls.EVIDENCE.rglob("*") if p.is_file()}, backups1)

    def test_failure_on_second_write_restores_first(self):
        before = self.all_bytes()
        with mock.patch.object(mls.os, "replace", check_replace_failing(2)):
            with self.assertRaises(RuntimeError):
                mls.Switcher("plugin-manifest").apply()
        self.assertEqual(self.all_bytes(), before)
        rec = jread(mls.RECORD)
        self.assertFalse(rec["active"])
        self.assertIn("injected failure", rec["failed"])

    def test_failed_recovery_keeps_record_active_and_rollback_completes(self):
        before = self.all_bytes()
        # 2nd replace = .mcp.json switch fails; 3rd = restoring config.toml fails too.
        with mock.patch.object(mls.os, "replace", check_replace_failing(2, 3)):
            with self.assertRaises(RuntimeError):
                mls.Switcher("plugin-manifest").apply()
        self.assertIn("Bearer", mls.CODEX_CONFIG.read_text())  # still switched
        rec = jread(mls.RECORD)
        self.assertTrue(rec["active"])
        self.assertIn("injected failure", rec["failed"])
        self.assertEqual([u["path"] for u in rec["unresolved"]], [str(mls.CODEX_CONFIG)])
        self.assertIn("injected failure", rec["unresolved"][0]["reason"])
        mls.Switcher("plugin-manifest").rollback()
        self.assertEqual(self.all_bytes(), before)
        self.assertFalse(jread(mls.RECORD)["active"])

    def test_recovery_leaves_a_later_edit_alone(self):
        real_write, calls = mls.Target.write, {"n": 0}

        def write(target, entry):
            calls["n"] += 1
            if calls["n"] == 2:  # someone edits the already-switched Codex block, then the 2nd write fails
                mls.CODEX_CONFIG.write_text(mls.CODEX_CONFIG.read_text().replace("120.0", "300.0"))
                raise OSError("injected failure")
            return real_write(target, entry)
        with mock.patch.object(mls.Target, "write", write):
            with self.assertRaises(RuntimeError):
                mls.Switcher("plugin-manifest").apply()
        text = mls.CODEX_CONFIG.read_text()
        self.assertIn("300.0", text)
        self.assertIn("Bearer", text)
        rec = jread(mls.RECORD)
        self.assertTrue(rec["active"])
        self.assertEqual([u["path"] for u in rec["unresolved"]], [str(mls.CODEX_CONFIG)])
        self.assertIn("changed after the switch", rec["unresolved"][0]["reason"])

    def test_unreadable_recorded_file_keeps_record_active(self):
        pj = self.plugin / ".claude-plugin/plugin.json"
        real_write, calls = mls.Target.write, {"n": 0}

        def write(target, entry):
            calls["n"] += 1
            if calls["n"] == 2:  # Codex was switched; plugin.json becomes unreadable, then the 2nd write fails
                pj.chmod(0o000)
                raise OSError("injected failure")
            return real_write(target, entry)
        try:
            with mock.patch.object(mls.Target, "write", write):
                with self.assertRaises(RuntimeError):
                    mls.Switcher("plugin-manifest").apply()
            self.assertNotIn("Bearer", mls.CODEX_CONFIG.read_text())  # Codex itself was restored
            rec = jread(mls.RECORD)
            self.assertTrue(rec["active"])
            self.assertEqual([u["path"] for u in rec["unresolved"]], [str(pj)])
            self.assertIn("cannot be read", rec["unresolved"][0]["reason"])
        finally:
            pj.chmod(0o600)

    def test_failed_rerun_keeps_record_active_while_files_stay_switched(self):
        mls.Switcher("plugin-manifest").apply()
        # A newer plugin version appears with the stdio form; the re-run fails on its first write.
        v2 = self.plugin.parent / "1.1.0"
        write(v2 / ".mcp.json", json.dumps({"mcpServers": {"episodic-memory": dict(STDIO)}}))
        write(v2 / ".claude-plugin/plugin.json", json.dumps({"name": "episodic-memory", "mcpServers": {"episodic-memory": dict(STDIO)}}))
        data = jread(mls.INSTALLED_PLUGINS)
        data["plugins"]["episodic-memory@superpowers-marketplace"][0]["installPath"] = str(v2)
        write(mls.INSTALLED_PLUGINS, json.dumps(data))
        with mock.patch.object(mls.os, "replace", check_replace_failing(1)):
            with self.assertRaises(RuntimeError):
                mls.Switcher("plugin-manifest").apply()
        rec = jread(mls.RECORD)
        self.assertTrue(rec["active"])  # Codex and the 1.0.0 manifests are still switched
        self.assertEqual(rec.get("unresolved"), [])
        self.assertIn("Bearer", mls.CODEX_CONFIG.read_text())

    def test_rerun_with_drifted_codex_block_is_refused(self):
        mls.Switcher("plugin-manifest").apply()
        for old, new in (("120.0", "300.0"), (TOKEN, "u" * 48)):
            switched = mls.CODEX_CONFIG.read_text()
            mls.CODEX_CONFIG.write_text(switched.replace(old, new))
            before = self.all_bytes()
            rec = mls.RECORD.read_bytes()
            with self.assertRaises(mls.PreflightError) as cm:
                mls.Switcher("plugin-manifest").apply()
            self.assertIn("config.toml", str(cm.exception))
            self.assertEqual(self.all_bytes(), before)
            self.assertEqual(mls.RECORD.read_bytes(), rec)
            mls.CODEX_CONFIG.write_text(switched)

    def test_rerun_after_token_rotation_is_refused(self):
        mls.Switcher("plugin-manifest").apply()
        write(mls.TOKEN, "n" * 48)
        before = self.all_bytes()
        with self.assertRaises(mls.PreflightError) as cm:
            mls.Switcher("plugin-manifest").apply()
        self.assertIn("config.toml", str(cm.exception))
        self.assertEqual(self.all_bytes(), before)

    def test_rerun_with_drifted_manifest_is_refused(self):
        mls.Switcher("plugin-manifest").apply()
        d = jread(self.plugin / ".mcp.json")
        d["mcpServers"]["episodic-memory"]["timeout"] = 5
        write(self.plugin / ".mcp.json", json.dumps(d))
        with self.assertRaises(mls.PreflightError) as cm:
            mls.Switcher("plugin-manifest").apply()
        self.assertIn(".mcp.json", str(cm.exception))

    def test_codex_config_is_set_to_exactly_0600_with_notice(self):
        for mode in (0o644, 0o400, 0o700, 0o640):
            with self.subTest(mode=oct(mode)):
                self.setUp()
                mls.CODEX_CONFIG.chmod(mode)
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    mls.Switcher("plugin-manifest").apply()
                self.assertEqual(stat.S_IMODE(mls.CODEX_CONFIG.stat().st_mode), 0o600)
                self.assertIn("0600", out.getvalue())
                self.assertNotIn(TOKEN, out.getvalue())

    def test_codex_config_at_0600_gets_no_notice(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            mls.Switcher("plugin-manifest").apply()
        self.assertNotIn("0600", out.getvalue())

    def test_preflight_rejects_unparseable_or_unexpected(self):
        (self.plugin / ".mcp.json").write_text("{not json")
        before = self.all_bytes()
        with self.assertRaises(mls.PreflightError):
            mls.Switcher("plugin-manifest").apply()
        self.assertEqual(self.all_bytes(), before)
        self.assertFalse(mls.RECORD.exists())
        write(self.plugin / ".mcp.json", json.dumps({"mcpServers": {"episodic-memory": {"type": "http", "url": "http://elsewhere"}}}))
        with self.assertRaises(mls.PreflightError):
            mls.Switcher("plugin-manifest").apply()
        self.assertFalse(mls.RECORD.exists())


class CodexPreflightRefusalTests(Base):
    def _refuses(self, new_text, needle):
        mls.CODEX_CONFIG.write_text(new_text)
        before = self.all_bytes()
        with self.assertRaises(mls.PreflightError) as cm:
            mls.Switcher("plugin-manifest").apply()
        self.assertIn(needle, str(cm.exception))
        self.assertEqual(self.all_bytes(), before)
        self.assertFalse(mls.RECORD.exists())

    def test_refuses_subtable(self):
        self._refuses(CODEX.replace("# --- end", '[mcp_servers.episodic-memory.env]\nA = "1"\n\n# --- end'),
                      "mcp_servers.episodic-memory.")

    def test_refuses_enabled_false(self):
        self._refuses(CODEX.replace("tool_timeout_sec", "enabled = false\ntool_timeout_sec"), "enabled")

    def test_refuses_unknown_key(self):
        self._refuses(CODEX.replace("tool_timeout_sec", "enabled_tools = [\"search\"]\ntool_timeout_sec"), "enabled_tools")

    def test_allows_args_and_timeouts(self):
        mls.CODEX_CONFIG.write_text(CODEX.replace("startup_timeout_sec", 'args = ["mcp"]\nstartup_timeout_sec'))
        mls.Switcher("plugin-manifest").apply()


class RollbackTests(Base):
    def test_rollback_restores_everything(self):
        before = self.all_bytes()
        s = mls.Switcher("plugin-manifest")
        s.apply()
        s.rollback()
        self.assertEqual(jread(self.plugin / ".mcp.json"), json.loads(before[str(self.plugin / ".mcp.json")]))
        self.assertEqual(mls.CODEX_CONFIG.read_text(), CODEX)
        self.assertFalse(jread(mls.RECORD)["active"])

    def test_rollback_keeps_unrelated_codex_edit(self):
        mls.Switcher("plugin-manifest").apply()
        mls.CODEX_CONFIG.write_text(mls.CODEX_CONFIG.read_text().replace(":3010", ":3999"))
        mls.Switcher("plugin-manifest").rollback()
        self.assertEqual(mls.CODEX_CONFIG.read_text(), CODEX.replace(":3010", ":3999"))

    def test_rollback_drift_codex_leaves_file_untouched(self):
        mls.Switcher("plugin-manifest").apply()
        mls.CODEX_CONFIG.write_text(mls.CODEX_CONFIG.read_text().replace("120.0", "300.0"))
        before = self.all_bytes()
        with self.assertRaises(mls.DriftError) as cm:
            mls.Switcher("plugin-manifest").rollback()
        self.assertIn("config.toml", str(cm.exception))
        self.assertEqual(self.all_bytes(), before)
        self.assertTrue(jread(mls.RECORD)["active"])

    def test_rollback_drift_manifest_url(self):
        mls.Switcher("plugin-manifest").apply()
        d = jread(self.plugin / ".mcp.json")
        d["mcpServers"]["episodic-memory"]["url"] = "http://127.0.0.1:9999/mcp"
        (self.plugin / ".mcp.json").write_text(json.dumps(d))
        before = self.all_bytes()
        with self.assertRaises(mls.DriftError):
            mls.Switcher("plugin-manifest").rollback()
        self.assertEqual(self.all_bytes(), before)

    def test_rollback_restores_patcher_recorded_later_version(self):
        mls.Switcher("plugin-manifest").apply()
        v2 = self.plugin.parent / "1.1.0"
        write(v2 / ".mcp.json", json.dumps({"mcpServers": {"episodic-memory": self.entry}}))
        rec = jread(mls.RECORD)
        rec["files"][str(v2 / ".mcp.json")] = {"before_entry": STDIO, "after_entry": self.entry, "backup_path": None}
        write(mls.RECORD, json.dumps(rec))
        mls.Switcher("plugin-manifest").rollback()
        self.assertEqual(jread(v2 / ".mcp.json")["mcpServers"]["episodic-memory"], STDIO)
        self.assertFalse(jread(mls.RECORD)["active"])


class RecordLockTests(Base):
    """switch-clients and rollback wait for the lock the plugin patcher also takes."""

    def run_while_locked(self, action):
        import fcntl
        import threading
        import time
        fd = os.open(mls.RECORD_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)          # stands in for a running patcher
        worker = threading.Thread(target=action)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                worker.start()
                time.sleep(0.5)
                self.assertTrue(worker.is_alive(), "did not wait for the record lock")
                held = self.all_bytes()
        finally:
            os.close(fd)
            worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(stat.S_IMODE(mls.RECORD_LOCK.stat().st_mode), 0o600)
        return held

    def test_switch_waits_for_lock(self):
        before = self.all_bytes()
        held = self.run_while_locked(mls.Switcher("plugin-manifest").apply)
        self.assertEqual(held, before)          # nothing edited while the lock was held
        self.assertEqual(self.mcp(), self.entry)

    def test_rollback_waits_for_lock(self):
        with contextlib.redirect_stdout(io.StringIO()):
            mls.Switcher("plugin-manifest").apply()
        switched = self.all_bytes()
        held = self.run_while_locked(mls.Switcher("plugin-manifest").rollback)
        self.assertEqual(held, switched)
        self.assertEqual(self.mcp(), STDIO)
        self.assertFalse(jread(mls.RECORD)["active"])


class InstallOrderTests(Base):
    def test_model_cache_is_seeded_and_validated_before_npm_test(self):
        mls.NODE.parent.mkdir(parents=True, exist_ok=True)
        mls.NODE.write_text("")
        calls = []

        def fake_run(cmd, **kw):
            calls.append(list(cmd))
            return mls.subprocess.CompletedProcess(cmd, 0, "", "")
        with mock.patch.object(mls.subprocess, "run", fake_run), \
                mock.patch.object(mls, "probe", lambda wait=0: calls.append(["probe"])), \
                mock.patch.object(mls.shutil, "copytree", lambda src, dst: calls.append(["copytree"])), \
                mock.patch.object(mls, "REPO", Path(_TMP) / "repo"), \
                mock.patch.object(mls, "model_dtype", lambda: "q8"):
            mls.install()

        def index(pred):
            return next(i for i, c in enumerate(calls) if pred(c))
        npm_test = index(lambda c: c[:2] == ["npm", "test"])
        offline = index(lambda c: len(c) > 2 and c[1] == "-e" and "allowRemoteModels=false" in c[2])
        seeded = index(lambda c: c == ["copytree"])
        self.assertLess(seeded, offline)
        self.assertLess(offline, npm_test)
        self.assertLess(index(lambda c: c[:2] == ["npm", "run"]), seeded)
        self.assertIn("launchctl", [c[0] for c in calls])  # intercepted by the fake, never run


class ProbeEnvTests(Base):
    def test_probe_resolves_the_index_like_the_service(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen.update(kw["env"])
            return mls.subprocess.CompletedProcess(cmd, 0, '{"ok":true}', "")
        session = {"EPISODIC_MEMORY_CONFIG_DIR": "/x", "XDG_CONFIG_HOME": "/y", "EPISODIC_MEMORY_DB_PATH": "/z",
                   "PERSONAL_SUPERPOWERS_DIR": "/w", "TEST_DB_PATH": "/v"}
        with mock.patch.dict(os.environ, session), mock.patch.object(mls.subprocess, "run", fake_run), \
                contextlib.redirect_stdout(io.StringIO()):
            mls.probe()
        # Compare key names only: never let a failure message print environment values.
        self.assertEqual(sorted(k for k in session if k in seen), [])
        self.assertEqual(seen.get("EPISODIC_MEMORY_HTTP_URL"), mls.URL)


class UserScopeTests(Base):
    def test_user_scope_switch_and_rollback(self):
        before = self.all_bytes()
        s = mls.Switcher("user-scope")
        s.apply()
        cj = jread(mls.CLAUDE_JSON)
        self.assertEqual(cj["mcpServers"]["episodic-memory"], self.entry)
        self.assertEqual(cj["mcpServers"]["other"], {"command": "x"})
        self.assertNotIn("episodic-memory", jread(self.plugin / ".mcp.json")["mcpServers"])
        self.assertNotIn("episodic-memory", self.pj()["mcpServers"])
        self.assertEqual(self.pj()["keywords"], ["a"])
        agent = (self.plugin / "agents/search-conversations.md").read_text()
        self.assertNotIn(OLD_PREFIX, agent)
        self.assertIn(NEW_PREFIX + "search", agent)
        for p in (mls.CLAUDE_JSON, self.plugin / ".mcp.json"):
            self.assertNotIn(TOKEN, p.read_text())
        files1 = self.all_bytes()
        mls.Switcher("user-scope").apply()  # idempotent
        self.assertEqual(self.all_bytes(), files1)
        s.rollback()
        after = self.all_bytes()
        self.assertEqual(after[str(self.plugin / "agents/search-conversations.md")],
                         before[str(self.plugin / "agents/search-conversations.md")])
        self.assertNotIn("episodic-memory", jread(mls.CLAUDE_JSON)["mcpServers"])
        self.assertEqual(self.mcp(), STDIO)
        self.assertEqual(self.pj()["mcpServers"]["episodic-memory"], dict(STDIO, env={"A": "1"}))
        self.assertEqual(mls.CODEX_CONFIG.read_text(), CODEX)


if __name__ == "__main__":
    unittest.main()
