#!/usr/bin/env python3
"""Install, probe, switch clients to, and roll back the shared episodic-memory HTTP service.

Never prints the bearer token. All paths derive from HOME, which tests redirect with EM_TEST_HOME.
"""
import argparse
import copy
import hashlib
import json
import os
import plistlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("EM_TEST_HOME") or Path.home())
REPO = Path(__file__).resolve().parent.parent
LABEL = "com.local.episodic-memory-v2"
PORT = 8734
URL = f"http://127.0.0.1:{PORT}/mcp"
STATE = HOME / ".local/share/mcp-fleet/episodic-memory"
TOKEN = STATE / "http-token"
LOG = STATE / "service.log"
RECORD = STATE / "switch-record.json"
HEADERS_HELPER = STATE / "headers-helper.sh"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
NODE = HOME / ".local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin/node"
CODEX_CONFIG = HOME / ".codex/config.toml"
CLAUDE_JSON = HOME / ".claude.json"
INSTALLED_PLUGINS = HOME / ".claude/plugins/installed_plugins.json"
PLUGIN_KEY = "episodic-memory@superpowers-marketplace"
PLUGIN_ROOT = HOME / ".claude/plugins/cache/superpowers-marketplace/episodic-memory"
EVIDENCE = HOME / "repos/mcp-fleet-v2/evidence" / f"{date.today()}-episodic"
SERVER = "episodic-memory"
OLD_TOOL_PREFIX = "mcp__plugin_episodic-memory_episodic-memory__"
NEW_TOOL_PREFIX = "mcp__episodic-memory__"
MODES = ("plugin-manifest", "user-scope")

NATIVE_PROBE = """const {createRequire}=require('module');
const r=createRequire(process.argv[1]);
const version=r('better-sqlite3/package.json').version;
const D=r('better-sqlite3');
const d=new D(':memory:');
r('sqlite-vec').load(d);
d.exec('CREATE VIRTUAL TABLE native_probe USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])');
const embedding=Buffer.from(new Float32Array([1,0]).buffer);
d.prepare('INSERT INTO native_probe(id,embedding) VALUES(?,?)').run('probe',embedding);
const row=d.prepare('SELECT id FROM native_probe WHERE embedding MATCH ? AND k=1').get(embedding);
if(!row||row.id!=='probe')throw new Error('sqlite-vec returned the wrong row');
d.close();
process.stdout.write(JSON.stringify({version,node:process.version,modules:process.versions.modules,napi:process.versions.napi}));"""

MODEL_OFFLINE_CHECK = """(async()=>{
const t=await import('@huggingface/transformers');
t.env.allowRemoteModels=false;t.env.allowLocalModels=true;t.env.useBrowserCache=false;
const p=await t.pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:%s,progress_callback:()=>{}});
const o=await p('offline model check',{pooling:'mean',normalize:true});
if(!o||!o.data||o.data.length!==384)throw new Error('unexpected embedding shape');
process.stdout.write(JSON.stringify({dims:o.data.length}));
})().catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(1);});"""


class DriftError(RuntimeError):
    """A recorded entry was edited by someone else; refuse to overwrite it."""


class PreflightError(RuntimeError):
    """A switch target is not in an expected, parseable state."""


# ---------------------------------------------------------------- file helpers

def atomic_write(path, data, mode=None):
    """Write `data` (bytes) to `path` via a same-directory temp file and os.replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode is None:
        mode = stat_mode(path) if path.exists() else 0o600
    tmp = path.with_name(path.name + ".em-tmp")
    if tmp.exists():
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
        os.replace(tmp, path)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise


def stat_mode(path):
    return os.stat(path).st_mode & 0o7777


def write_json(path, obj, mode=None):
    atomic_write(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode(), mode)


# ---------------------------------------------------------------- Codex TOML block

_HEADER = "[mcp_servers.episodic-memory]"


def _block_span(text):
    start = text.find(_HEADER)
    if start < 0 or (start and text[start - 1] != "\n"):
        raise ValueError("no [mcp_servers.episodic-memory] table found")
    body = start + len(_HEADER)
    end_marker = re.search(r"(?m)^# --- end episodic-memory block ---", text[body:])
    next_table = re.search(r"(?m)^\[", text[body:])
    ends = [m.start() for m in (end_marker, next_table) if m]
    return start, body + (min(ends) if ends else len(text) - body)


def extract_block(text):
    """The episodic-memory table: from its header up to the end marker / next table / EOF."""
    start, end = _block_span(text)
    return text[start:end]


def _replace_block(text, new_block):
    start, end = _block_span(text)
    return text[:start] + new_block + text[end:]


def codex_switch(text, url, token):
    """Replace only the episodic block with the HTTP form, keeping its timeouts."""
    block = extract_block(text)
    kept = [ln for ln in block.splitlines() if re.match(r"\s*(startup_timeout_sec|tool_timeout_sec)\s*=", ln)]
    trailing = block[len(block.rstrip()):] or "\n"
    new = "\n".join([_HEADER, f"url = {json.dumps(url)}",
                    f"http_headers = {{ Authorization = {json.dumps('Bearer ' + token)} }}", *kept]) + "\n" + trailing
    return _replace_block(text, new)


def codex_restore(current, switched_block, original_block):
    if extract_block(current) != switched_block:
        raise DriftError("episodic-memory block in Codex config differs from the recorded switched block")
    return _replace_block(current, original_block)


def claude_entry(url, helper):
    return {"type": "http", "url": url, "headersHelper": helper}


def registered_plugin_dir():
    data = json.loads(INSTALLED_PLUGINS.read_text())
    entries = [e for e in data.get("plugins", {}).get(PLUGIN_KEY, []) if e.get("scope") == "user"]
    if len(entries) != 1:
        raise PreflightError(f"expected exactly one user-scope {PLUGIN_KEY} entry, found {len(entries)}")
    return Path(entries[0]["installPath"])


# ---------------------------------------------------------------- switch targets

_MISSING = object()


class Target:
    """One edited location: kind json (key path inside a JSON file), toml (Codex block) or text."""

    def __init__(self, path, kind, key=None):
        self.path, self.kind, self.key = Path(path), kind, key

    def read(self):
        """Current entry (JSON: dict or None when absent; toml: block text; text: whole file)."""
        raw = self.path.read_text()
        if self.kind == "toml":
            return extract_block(raw)
        if self.kind == "text":
            return raw
        node = json.loads(raw)
        for part in self.key:
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
        return node

    def write(self, entry):
        raw = self.path.read_text()
        if self.kind == "toml":
            mode = stat_mode(self.path)
            if "http_headers" in entry:
                # The block holds the bearer token: owner read/write only, nothing else.
                if mode != 0o600:
                    print(f"set {self.path} permissions to 0600 (was {mode:04o}; it now holds the service bearer token)")
                mode = 0o600
            atomic_write(self.path, _replace_block(raw, entry).encode(), mode)
        elif self.kind == "text":
            atomic_write(self.path, entry.encode())
        else:
            obj = json.loads(raw)
            node = obj
            for part in self.key[:-1]:
                node = node.setdefault(part, {})
            if entry is None:
                node.pop(self.key[-1], None)
            else:
                node[self.key[-1]] = copy.deepcopy(entry)
            write_json(self.path, obj)

    @staticmethod
    def from_record(path, info):
        kind = info.get("kind")
        if not kind:
            kind = "toml" if path.endswith(".toml") else "text" if path.endswith(".md") else "json"
        return Target(path, kind, info.get("key") or ([ "mcpServers", SERVER ] if kind == "json" else None))


class Switcher:
    def __init__(self, mode="plugin-manifest"):
        if mode not in MODES:
            raise ValueError(f"unknown claude mode {mode!r}")
        self.mode = mode
        self.entry = claude_entry(URL, str(HEADERS_HELPER))

    # -- planning
    def _targets(self):
        plugin = registered_plugin_dir()
        manifests = [Target(plugin / ".mcp.json", "json", ["mcpServers", SERVER]),
                     Target(plugin / ".claude-plugin/plugin.json", "json", ["mcpServers", SERVER])]
        targets = [Target(CODEX_CONFIG, "toml")]
        if self.mode == "plugin-manifest":
            return targets + manifests
        targets.append(Target(CLAUDE_JSON, "json", ["mcpServers", SERVER]))
        targets += manifests
        agent = plugin / "agents/search-conversations.md"
        if agent.exists():
            targets.append(Target(agent, "text"))
        return targets

    def _classify(self, t, token, current):
        """Return (before, after, already_switched) or raise PreflightError."""
        user = self.mode == "user-scope"
        if t.kind == "toml":
            switched = (f"url = {json.dumps(URL)}" in current and "http_headers" in current and "command" not in current)
            if switched:
                return None, current, True
            if not re.search(r"(?m)^command\s*=", current) or re.search(r"(?m)^url\s*=", current):
                raise PreflightError(f"{t.path}: episodic-memory block is not the expected stdio form")
            if re.search(r"(?m)^\[mcp_servers\.episodic-memory\.", t.path.read_text()):
                raise PreflightError(f"{t.path}: [mcp_servers.episodic-memory.*] sub-tables are not supported "
                                     "(Codex rejects them on an HTTP server); remove them and re-run")
            allowed = {"command", "args", "startup_timeout_sec", "tool_timeout_sec"}
            for ln in current.splitlines()[1:]:
                m = re.match(r"\s*([A-Za-z0-9_.\"-]+)\s*=", ln)
                if m and m.group(1) not in allowed:
                    hint = " (the server is disabled; enable or remove it first)" if m.group(1) == "enabled" else ""
                    raise PreflightError(f"{t.path}: unsupported key {m.group(1)!r} in the episodic-memory block{hint}; "
                                         "refusing to drop it")
            return current, extract_block(codex_switch(t.path.read_text(), URL, token)), False
        if t.kind == "text":
            if OLD_TOOL_PREFIX in current:
                return current, current.replace(OLD_TOOL_PREFIX, NEW_TOOL_PREFIX), False
            return None, current, True
        is_user_json = t.path == CLAUDE_JSON
        if is_user_json:
            if current == self.entry:
                return None, current, True
            if current is None or (isinstance(current, dict) and "command" in current and "url" not in current):
                return current, self.entry, False
            raise PreflightError(f"{t.path}: mcpServers.{SERVER} is not absent, stdio, or the switched entry")
        # plugin manifests
        if user:
            if current is None:
                return None, None, True
            if isinstance(current, dict) and "command" in current and "url" not in current:
                return current, None, False
            raise PreflightError(f"{t.path}: manifest entry is not the stdio form (roll back a manifest-mode switch first)")
        if current == self.entry:
            return None, current, True
        if isinstance(current, dict) and "command" in current and "url" not in current:
            return current, self.entry, False
        raise PreflightError(f"{t.path}: manifest entry is not the stdio form or the switched entry")

    def preflight(self):
        if not TOKEN.is_file():
            raise PreflightError("token file missing; run install first")
        token = TOKEN.read_text().strip()
        old = load_record()
        old_files = old["files"] if old and old.get("active") and old.get("mode") == self.mode else {}
        plan = []
        for t in self._targets():
            try:
                current = t.read()
            except FileNotFoundError:
                raise PreflightError(f"{t.path}: file missing")
            except (ValueError, json.JSONDecodeError) as exc:
                raise PreflightError(f"{t.path}: cannot parse ({exc})")
            before, after, done = self._classify(t, token, current)
            if done:
                prior = old_files.get(str(t.path))
                if prior is None:
                    # switched outside this tool's record (or absent in user-scope): nothing recorded to roll back
                    if not (t.kind == "json" and current is None):
                        raise PreflightError(f"{t.path}: already switched but not in an active switch record; "
                                             "restore it manually or roll back first")
                    before, after = None, None
                else:
                    # "Already switched" means exactly the recorded switched entry; anything else is drift.
                    if current != prior["after_entry"]:
                        raise PreflightError(f"{t.path}: episodic-memory entry differs from the recorded switched "
                                             "entry (drift); inspect it, then roll back or restore it manually")
                    if t.kind == "toml" and f"Bearer {token}" not in current:
                        raise PreflightError(f"{t.path}: switched block carries a bearer that is not the current "
                                             "token; roll back and switch again")
                    before, after = prior["before_entry"], prior["after_entry"]
            plan.append({"target": t, "before": before, "after": after, "done": done})
        return plan

    # -- apply
    def apply(self):
        plan = self.preflight()
        if all(p["done"] for p in plan):
            print("episodic-memory clients already switched; nothing to do")
            return
        old = load_record()
        files = {}
        for item in plan:
            t = item["target"]
            old_info = (old or {}).get("files", {}).get(str(t.path)) if old and old.get("active") else None
            backup = old_info["backup_path"] if old_info else self._backup(t)
            files[str(t.path)] = {"kind": t.kind, "key": t.key, "before_entry": item["before"],
                                  "after_entry": item["after"], "backup_path": backup}
        if old and old.get("active"):  # keep patcher-added entries for other plugin versions
            for path, info in old["files"].items():
                files.setdefault(path, info)
        record = {"active": True, "mode": self.mode, "created": old["created"] if old and old.get("active")
                  else datetime.now(timezone.utc).isoformat(), "files": files}
        save_record(record)
        edited = []
        try:
            for item in plan:
                if item["done"]:
                    continue
                t = item["target"]
                if t.read() != item["before"]:
                    raise DriftError(f"{t.path}: changed during switch")
                t.write(item["after"])
                edited.append(item)
        except BaseException as exc:
            unresolved = []
            for item in reversed(edited):
                t = item["target"]
                try:
                    current = t.read()
                    if current == item["before"]:
                        continue
                    if current != item["after"]:
                        # Edited by someone else after our write: never overwrite it.
                        unresolved.append({"path": str(t.path), "reason": "changed after the switch; left as is"})
                        continue
                    t.write(item["before"])
                except Exception as inner:  # noqa: BLE001
                    unresolved.append({"path": str(t.path), "reason": f"restore failed: {type(inner).__name__}: {inner}"})
            # Every other recorded file must be readable and not switched; a file that cannot
            # be read or parsed might still be switched, so it is unresolved too.
            seen = {u["path"] for u in unresolved}
            switched, unreadable = self._switch_state(record["files"])
            unresolved += [u for u in unreadable if u["path"] not in seen]
            # The record stays active while any recorded file is still switched or unresolved,
            # so rollback can still finish the job.
            record["active"] = bool(unresolved) or switched
            record["unresolved"] = unresolved
            problems = [f"{u['path']}: {u['reason']}" for u in unresolved]
            record["failed"] = f"{type(exc).__name__}: {exc}" + (f" (unresolved: {problems})" if problems else "")
            save_record(record)
            if record["active"]:
                raise RuntimeError(f"switch failed; the record stays active, run rollback to finish: {record['failed']}") from exc
            raise RuntimeError(f"switch failed and was rolled back: {record['failed']}") from exc
        print(f"switched {len(edited)} file(s) to the shared service ({self.mode}); new sessions pick it up")

    @staticmethod
    def _switch_state(files):
        """(any recorded file still holds its switched entry, [unreadable files with reasons])."""
        switched, unreadable = False, []
        for path, info in files.items():
            if info["after_entry"] == info["before_entry"]:
                continue
            try:
                if Target.from_record(path, info).read() == info["after_entry"]:
                    switched = True
            except FileNotFoundError:
                continue  # nothing left to restore (rollback skips it too)
            except (OSError, ValueError) as exc:
                unreadable.append({"path": path, "reason": f"cannot be read or parsed: {type(exc).__name__}: {exc}"})
        return switched, unreadable

    def _backup(self, t):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        EVIDENCE.chmod(0o700)
        name = hashlib.sha256(str(t.path).encode()).hexdigest()[:10] + "-" + t.path.name
        dest = EVIDENCE / "backups" / name
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(dest, t.path.read_bytes(), 0o600)
        return str(dest)

    # -- rollback
    def rollback(self):
        record = load_record()
        if not record:
            raise PreflightError("no switch record; nothing to roll back")
        todo = []
        for path, info in record["files"].items():
            t = Target.from_record(path, info)
            if not t.path.exists():
                print(f"skip {path}: file no longer exists")
                continue
            current = t.read()
            if current == info["after_entry"] and current != info["before_entry"]:
                todo.append((t, info))
            elif current == info["before_entry"]:
                continue
            else:
                raise DriftError(f"{path}: episodic-memory entry was changed after the switch; inspect and restore manually")
        for t, info in todo:
            t.write(info["before_entry"])
        record["active"] = False
        record["rolled_back"] = datetime.now(timezone.utc).isoformat()
        save_record(record)
        print(f"restored {len(todo)} file(s). The service is still running for connected HTTP clients; "
              f"stop it with: launchctl bootout gui/{os.getuid()}/{LABEL}")


def load_record():
    if not RECORD.exists():
        return None
    return json.loads(RECORD.read_text())


def save_record(record):
    write_json(RECORD, record, 0o600)


# ---------------------------------------------------------------- commands

def runtime_env():
    return {**os.environ, "PATH": f"{NODE.parent}:{os.environ.get('PATH', '/usr/bin:/bin')}"}


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=kw.pop("cwd", REPO), env=kw.pop("env", runtime_env()), check=True, **kw)


def model_dtype():
    m = re.search(r"const MODEL_DTYPE\s*=\s*'([^']+)'", (REPO / "src/embeddings.ts").read_text())
    if not m:
        raise RuntimeError("MODEL_DTYPE not found in src/embeddings.ts")
    return m.group(1)


def install():
    if not NODE.exists():
        raise RuntimeError(f"pinned runtime missing: {NODE}")
    STATE.mkdir(parents=True, exist_ok=True)
    STATE.chmod(0o700)
    try:
        fd = os.open(TOKEN, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(48))
        print("created token file (not displayed)")
    except FileExistsError:
        print("token file exists; left unchanged")
    if not LOG.exists():
        os.close(os.open(LOG, os.O_WRONLY | os.O_CREAT, 0o600))
    LOG.chmod(0o600)
    helper = f'#!/bin/sh\nprintf \'{{"Authorization":"Bearer %s"}}\' "$(cat {shlex.quote(str(TOKEN))})"\n'
    atomic_write(HEADERS_HELPER, helper.encode(), 0o700)

    run(["npm", "install", "--no-package-lock"])
    run(["npm", "run", "build"])
    run([str(NODE), "-e", NATIVE_PROBE, str(REPO / "package.json")], stdout=subprocess.DEVNULL)

    # Seed and validate the model cache before the test suite: embedding tests need it,
    # and the shared service's workers load it offline-only.
    cache_rel = Path("node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5")
    dest = REPO / cache_rel
    if not dest.exists():
        shutil.copytree(registered_plugin_dir() / cache_rel, dest)
    run([str(NODE), "-e", MODEL_OFFLINE_CHECK % json.dumps(model_dtype())], stdout=subprocess.DEVNULL)
    run(["npm", "test"])

    plist = {"Label": LABEL, "ProgramArguments": [str(NODE), str(REPO / "dist/mcp-server.js"), "--http"],
             "WorkingDirectory": str(REPO),
             "EnvironmentVariables": {"EPISODIC_MEMORY_HTTP_TOKEN_FILE": str(TOKEN),
                                      "EPISODIC_MEMORY_HTTP_PORT": str(PORT), "HOME": str(HOME),
                                      "PATH": f"{NODE.parent}:/usr/bin:/bin:/usr/sbin:/sbin"},
             "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 5,
             "StandardOutPath": str(LOG), "StandardErrorPath": str(LOG)}
    atomic_write(PLIST, plistlib.dumps(plist), 0o644)
    subprocess.run(["plutil", "-lint", str(PLIST)], check=True, stdout=subprocess.DEVNULL)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], stderr=subprocess.DEVNULL)
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True)
    probe(wait=90)


# Per-session overrides the launchd service never sees; the probe drops them so it checks
# the same index (embedding version) the service reads.
SESSION_ONLY_ENV = ("EPISODIC_MEMORY_CONFIG_DIR", "XDG_CONFIG_HOME", "EPISODIC_MEMORY_DB_PATH",
                    "PERSONAL_SUPERPOWERS_DIR", "TEST_DB_PATH")


def probe(wait=0):
    env = {k: v for k, v in runtime_env().items() if k not in SESSION_ONLY_ENV}
    env.update({"EPISODIC_MEMORY_HTTP_TOKEN_FILE": str(TOKEN), "EPISODIC_MEMORY_HTTP_URL": URL})
    deadline = time.time() + wait
    while True:
        r = subprocess.run([str(NODE), "scripts/probe-live.mjs"], cwd=REPO, env=env, capture_output=True, text=True, timeout=180)
        if r.returncode == 0:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            atomic_write(EVIDENCE / "probe.json", r.stdout.encode(), 0o600)
            print(r.stdout.strip())
            return
        if time.time() >= deadline:
            print(r.stdout.strip())
            raise RuntimeError("probe failed; clients remain unchanged. Inspect the protected service log.")
        time.sleep(2)


def switch_clients(mode):
    probe()
    Switcher(mode).apply()


def rollback_cmd():
    record = load_record()
    Switcher(record["mode"] if record else "plugin-manifest").rollback()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("install")
    sub.add_parser("probe")
    sw = sub.add_parser("switch-clients")
    sw.add_argument("--claude-mode", choices=MODES, default="plugin-manifest")
    sub.add_parser("rollback")
    args = parser.parse_args(argv)
    {"install": install, "probe": probe, "rollback": rollback_cmd,
     "switch-clients": lambda: switch_clients(args.claude_mode)}[args.action]()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
