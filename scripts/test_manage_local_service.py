"""Tests for manage-local-service.py. Everything runs against a temporary HOME (EM_TEST_HOME);
install/probe side effects (launchctl, npm, node) are never exercised here."""
import importlib.util
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


def check_replace_failing(nth):
    """os.replace wrapper that raises on the nth replace that is not the switch record or a backup."""
    real, state = os.replace, {"n": 0}

    def fake(src, dst, *a, **k):
        if Path(dst) != mls.RECORD and mls.EVIDENCE not in Path(dst).parents:
            state["n"] += 1
            if state["n"] == nth:
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
