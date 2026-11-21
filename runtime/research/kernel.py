# SPDX-License-Identifier: AGPL-3.0-only
"""Jupyter kernel adapter (DOCEXEC-01 kernel layer): one kernel, explicit cells, bounded safe outputs, provenance.

!! UNCONFINED. The kernel runs with the user's own privileges: it can read the home directory, use the network and
!! spawn processes. The only controls here are an environment allowlist (no inherited API keys), a private working
!! directory, wall-clock and output bounds, and child cleanup. TeX's sandbox does not qualify general code. Keep this
!! path unavailable to users until RESEARCH-RUNTIME-01 qualifies a real sandbox. Memory/process limits are not applied.

Uses installed jupyter_client only for protocol operations (no server, no notebook UI). The kernel is launched by
jupyter_client from the installed kernelspec argv, never through a shell string built from document text; its
connection file (0600, in a 0700 temp dir, 127.0.0.1 only) is deleted on shutdown and its keys/ports never appear in
any result. Library: `Session`. CLI (JSON lines on stdin/stdout, run with `python -B -I kernel.py`):
  {"op":"list"} {"op":"start","kernel":"python3","packages":["numpy"]} {"op":"run","cell":"a.py","code":"1+1","seed":1,"timeout":30}
  {"op":"interrupt"} {"op":"restart"} {"op":"rerun","cells":[{"cell":..,"code":..}],"previous":[provenance..]} {"op":"shutdown"}
Output items use only the MIME set that outputs.mjs renders: text/plain, image/png, application/x.table+json.
"""
import base64, hashlib, json, os, queue, re, shutil, signal, subprocess, sys, tempfile, threading, time
from importlib.util import find_spec

MAX_CODE, MAX_CELLS, MAX_ITEMS, MAX_OUT, MAX_TEXT, MAX_PNG, MAX_TIMEOUT = 1 << 20, 500, 100, 256 << 10, 64 << 10, 2 << 20, 600
SAFE_ENV = {"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME"}   # nothing secret-shaped is inherited
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PACKAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$")
CELL = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
VERSION_CODE = {
    "python": "import importlib.metadata as _m\nfor _n in {names!r}:\n    try: print(_n, _m.version(_n))\n    except Exception: print(_n, 'missing')",
    "R": 'for (n in c({r_names})) cat(n, tryCatch(as.character(packageVersion(n)), error = function(e) "missing"), "\\n")',
}


class KernelError(Exception): pass


def sha256(data): return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def list_kernels():
    """Installed kernelspecs as {name: {display, language}}; filesystem locations are not exposed."""
    if find_spec("jupyter_client") is None: raise KernelError("jupyter_client is not installed in the selected Python environment")
    from jupyter_client.kernelspec import KernelSpecManager
    manager, out = KernelSpecManager(), {}
    for name in manager.find_kernel_specs():
        try: spec = manager.get_kernel_spec(name); out[name] = {"display": spec.display_name, "language": spec.language}
        except Exception: continue
    return out


class Session:
    def __init__(self, kernel, packages=(), workdir=None):
        if not isinstance(kernel, str) or kernel not in list_kernels(): raise KernelError("Unknown kernel")
        if len(packages) > 50 or any(not isinstance(p, str) or not PACKAGE.match(p) for p in packages): raise KernelError("Invalid package name")
        self.kernel, self.packages_requested, self.cancel = kernel, list(packages), threading.Event()
        self.keep_workdir, self.workdir_arg = workdir is not None, workdir
        self.km = self.client = self.conn_dir = self.workdir = None
        self.language = self.runtime = ""; self.packages = {}; self.order = 0

    # -- lifecycle
    def start(self):
        from jupyter_client import KernelManager
        if self.km: raise KernelError("Kernel already started")
        try:
            self.conn_dir = tempfile.mkdtemp(prefix="kernel-"); os.chmod(self.conn_dir, 0o700)    # mkdtemp is 0700; explicit for clarity
            self.workdir = self.workdir_arg or tempfile.mkdtemp(prefix="kernel-work-")
            self.cancel.clear()
            self.km = KernelManager(kernel_name=self.kernel); self.km.ip = "127.0.0.1"
            self.km.connection_file = os.path.join(self.conn_dir, "k.json")
            env = {k: v for k, v in os.environ.items() if k in SAFE_ENV}
            self.km.start_kernel(cwd=self.workdir, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.client = self.km.client(); self.client.start_channels(); self.client.wait_for_ready(timeout=60)
            self.client.kernel_info(); info = self._shell_reply(None, 15)["content"].get("language_info", {})
            self.language, self.runtime = str(info.get("name", "")), str(info.get("version", ""))
            self.packages = self._package_versions()
        except BaseException:
            self.shutdown(); raise

    @property
    def pid(self): return getattr(getattr(self.km, "provisioner", None), "pid", None) if self.km else None

    def shutdown(self):
        km, client, pid, conn, work = self.km, self.client, self.pid, self.conn_dir, self.workdir
        self.km = self.client = self.conn_dir = None
        try:
            if client: client.stop_channels()
        except Exception: pass
        try:
            if km: km.shutdown_kernel(now=True)
        except Exception: pass
        if pid:                                    # guarantee: no kernel survives, whatever shutdown_kernel did
            for sig in (signal.SIGTERM, signal.SIGKILL):
                deadline = time.monotonic() + 3
                while _alive(pid) and time.monotonic() < deadline: time.sleep(0.05)
                if _alive(pid):
                    try: os.killpg(os.getpgid(pid), sig)
                    except OSError:
                        try: os.kill(pid, sig)
                        except OSError: pass
        if conn: shutil.rmtree(conn, ignore_errors=True)
        if work and not self.keep_workdir: shutil.rmtree(work, ignore_errors=True)
        self.workdir = None if not self.keep_workdir else self.workdir

    def restart(self): self.shutdown(); self.start()
    def __enter__(self): self.start(); return self
    def __exit__(self, *exc): self.shutdown()

    # -- protocol helpers
    def _shell_reply(self, msg_id, timeout):
        end = time.monotonic() + timeout
        while True:
            try: msg = self.client.get_shell_msg(timeout=max(0.05, end - time.monotonic()))
            except queue.Empty: raise KernelError("Kernel did not reply in time")
            if msg_id is None or msg["parent_header"].get("msg_id") == msg_id: return msg

    def interrupt(self):
        try: self.km.interrupt_kernel()
        except Exception: pass

    def _package_versions(self):
        if not self.packages_requested or self.language not in VERSION_CODE: return {}
        code = VERSION_CODE[self.language].format(names=self.packages_requested, r_names=", ".join(f'"{p}"' for p in self.packages_requested))
        result = self._exec(code, 20, store_history=False)
        words = (line.split() for line in "".join(i.get("data", "") for i in result["items"]).splitlines())
        return {w[0]: w[1] for w in words if len(w) == 2 and w[0] in self.packages_requested}

    def _redact(self, text):
        text = ANSI.sub("", text)
        for path in {self.workdir, self.conn_dir, *(os.path.realpath(p) for p in (self.workdir, self.conn_dir) if p)} - {None}:
            text = text.replace(path, "<work>")
        text = re.sub(r"/(?:private/)?var/folders/[^\s'\"]+", "<tmp>", text)
        home = os.path.expanduser("~")
        if len(home) > 1: text = text.replace(home, "~")
        return re.sub(r"/(?:Users|home)/[^/\s'\"]+", "~", text)

    def _safe_bundle(self, bundle):
        """Pick the displayable item from a MIME bundle; every other MIME is reported by name only."""
        blocked = sorted(m[:80] for m in bundle if m not in ("text/plain", "image/png", "application/x.table+json"))
        png = bundle.get("image/png")
        if isinstance(png, str):
            png = "".join(png.split())
            try: raw = base64.b64decode(png, validate=True)
            except ValueError: raw = b""
            if len(png) <= MAX_PNG * 4 // 3 + 4 and raw.startswith(PNG_MAGIC) and len(raw) <= MAX_PNG: return {"mime": "image/png", "data": png}, blocked
            blocked.append("image/png")
        table = bundle.get("application/x.table+json")
        if isinstance(table, (dict, str)) and len(canonical(table)) <= MAX_TEXT: return {"mime": "application/x.table+json", "data": table}, blocked
        text = bundle.get("text/plain")
        if isinstance(text, str): return {"mime": "text/plain", "data": self._redact(text)[:MAX_TEXT]}, blocked
        return None, blocked

    # -- execution
    def _exec(self, code, timeout, store_history):
        c, items, blocked, size, status, truncated, limited = self.client, [], set(), 0, None, False, False
        self.cancel.clear()   # a cancel applies to the running cell only; shortcut: one that lands before this line is lost
        mid = c.execute(code, silent=False, store_history=store_history, allow_stdin=False, stop_on_error=True)
        deadline, interrupted = time.monotonic() + timeout, False
        def add(item):
            nonlocal size, truncated, status, limited
            cost = len(item.get("data", "") if isinstance(item.get("data"), str) else canonical(item.get("data"))) + len(item.get("traceback", ""))
            if len(items) >= MAX_ITEMS or size + cost > MAX_OUT:
                if not limited: limited = truncated = True; status = status or "output_limit"; self.interrupt()   # a runaway printer is stopped, once
                return
            size += cost; items.append(item)
        while True:
            if self.cancel.is_set() and not interrupted: status, interrupted, deadline = "canceled", True, time.monotonic() + 5; self.interrupt()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if interrupted:                    # the kernel ignored the interrupt: replace it
                    self.restart(); return {"status": status or "timeout", "items": items, "blocked": sorted(blocked), "truncated": truncated, "execution_count": None, "restarted": True}
                status, interrupted, deadline = "timeout", True, time.monotonic() + 5; self.interrupt(); continue
            try: msg = c.get_iopub_msg(timeout=min(0.2, remaining))
            except queue.Empty: continue
            if msg["parent_header"].get("msg_id") != mid: continue
            kind, body = msg["msg_type"], msg["content"]
            if kind == "status" and body.get("execution_state") == "idle": break
            if kind == "stream":
                text = self._redact(str(body.get("text", "")))
                if len(text) > MAX_TEXT: truncated = True
                if items and items[-1].get("kind") == "stream" and items[-1]["name"] == body.get("name") and len(items[-1]["data"]) + len(text) <= MAX_TEXT and size + len(text) <= MAX_OUT:
                    items[-1]["data"] += text; size += len(text)
                else: add({"kind": "stream", "name": str(body.get("name", "stdout"))[:20], "mime": "text/plain", "data": text[:MAX_TEXT]})
            elif kind in ("display_data", "execute_result", "update_display_data"):
                item, dropped = self._safe_bundle(body.get("data", {})); blocked.update(dropped)
                if item: add({"kind": "display", **item})
            elif kind == "error":
                add({"kind": "error", "ename": self._redact(str(body.get("ename", "")))[:200], "evalue": self._redact(str(body.get("evalue", "")))[:2000],
                     "traceback": self._redact("\n".join(map(str, body.get("traceback", []))))[:MAX_TEXT]})
        reply = self._shell_reply(mid, 10)["content"]
        return {"status": status or {"ok": "ok", "error": "error"}.get(reply.get("status"), "aborted"), "items": items, "blocked": sorted(blocked),
                "truncated": truncated, "execution_count": reply.get("execution_count") if store_history else None}

    def run(self, cell, code, seed=None, timeout=30):
        if not self.km: raise KernelError("Kernel not started")
        if not isinstance(cell, str) or not CELL.match(cell) or cell.startswith(("/", "~")) or ".." in cell.split("/"): raise KernelError("Cell ids are project-relative names")
        if not isinstance(code, str) or len(code.encode()) > MAX_CODE: raise KernelError("Code is missing or too large")
        if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)): raise KernelError("Seed must be an integer")
        result = self._exec(code, min(max(float(timeout), 0.1), MAX_TIMEOUT), store_history=True)
        order, self.order = self.order, self.order + 1
        result["provenance"] = {"cell": cell, "order": order, "execution_count": result["execution_count"], "kernel": self.kernel, "language": self.language,
                                "runtime": self.runtime, "packages": self.packages, "seed": seed, "code": sha256(code), "output": sha256(canonical(result["items"])), "status": result["status"]}
        return result

    def rerun(self, cells, previous=(), timeout=30):
        """Fresh kernel, cells in the given order; differences from `previous` provenance expose hidden state."""
        if not isinstance(cells, list) or len(cells) > MAX_CELLS: raise KernelError("Too many cells")
        self.restart(); self.order = 0
        results = [self.run(c["cell"], c["code"], c.get("seed"), timeout) for c in cells]
        prov = [r["provenance"] for r in results]; before = {p["cell"]: p for p in previous}; diffs = []
        for p in prov:
            q = before.get(p["cell"])
            if q is None: diffs.append({"cell": p["cell"], "change": "new"})
            elif q["code"] != p["code"]: diffs.append({"cell": p["cell"], "change": "code_changed"})
            elif q["status"] != p["status"]: diffs.append({"cell": p["cell"], "change": "status_changed", "from": q["status"], "to": p["status"]})
            elif q["output"] != p["output"]: diffs.append({"cell": p["cell"], "change": "output_changed"})
        diffs += [{"cell": cell, "change": "removed"} for cell in before if cell not in {p["cell"] for p in prov}]
        return {"status": "differs" if diffs else "same", "cells": results, "provenance": prov, "differences": diffs}


def _alive(pid):
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    except PermissionError: return True
    try: return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()[:1] not in ("", "Z")   # a zombie is already dead
    except OSError: return True


def main():
    requests, session = queue.Queue(), {"s": None}
    def reader():
        for line in sys.stdin:
            try: request = json.loads(line) if len(line) <= 6_000_000 else {}
            except ValueError: request = {}
            if isinstance(request, dict) and request.get("op") == "interrupt":
                if session["s"]: session["s"].cancel.set()
                continue
            requests.put(request)
        requests.put(None)
        if session["s"]: session["s"].cancel.set()          # parent closed stdin: stop whatever runs
    def stop(*_): s = session["s"]; s and s.shutdown(); os._exit(0)
    for sig in (signal.SIGTERM, signal.SIGHUP): signal.signal(sig, stop)
    threading.Thread(target=reader, daemon=True).start()
    def reply(value, rid): sys.stdout.write(json.dumps({"id": rid, **value}, allow_nan=False) + "\n"); sys.stdout.flush()
    try:
        while (request := requests.get()) is not None:
            rid, op, s = request.get("id"), request.get("op"), session["s"]
            try:
                if op == "list": reply({"status": "ok", "kernels": list_kernels()}, rid)
                elif op == "start":
                    if s: raise KernelError("Kernel already started")
                    session["s"] = s = Session(request.get("kernel"), request.get("packages", [])); s.start()
                    reply({"status": "ok", "language": s.language, "runtime": s.runtime, "packages": s.packages}, rid)
                elif op in ("run", "restart", "rerun") and s:
                    if op == "run": reply({"status": "ok", **s.run(request.get("cell"), request.get("code"), request.get("seed"), request.get("timeout", 30))}, rid)
                    elif op == "restart": s.restart(); reply({"status": "ok"}, rid)
                    else: reply(s.rerun(request.get("cells", []), request.get("previous", []), request.get("timeout", 30)), rid)
                elif op == "shutdown":
                    if s: s.shutdown(); session["s"] = None
                    reply({"status": "ok"}, rid)
                else: reply({"status": "unsupported", "reason": "Unknown operation or no kernel started"}, rid)
            except (KernelError, KeyError, TypeError, ValueError) as error:
                reply({"status": "error", "reason": (s._redact(str(error)) if s else str(error))[:300]}, rid)
            except Exception as error: reply({"status": "error", "reason": type(error).__name__}, rid)
    finally:
        if session["s"]: session["s"].shutdown()


if __name__ == "__main__": main()
