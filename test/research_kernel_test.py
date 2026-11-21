# SPDX-License-Identifier: AGPL-3.0-only
"""Live-kernel checks for runtime/research/kernel.py using only synthetic code in private temp directories.
Needs the user's Python with jupyter_client+ipykernel (python3 kernelspec); the R test runs only if an `ir` kernelspec exists:
   <python> -B -I test/research_kernel_test.py
The kernel layer is UNCONFINED (see module docstring); nothing here claims sandboxing."""
import json, os, queue, signal, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "research"))
import kernel as k

SCRIPT = os.path.join(HERE, "..", "runtime", "research", "kernel.py")
CANARY = "canary-secret-value-123"


def procs_mentioning(fragment):
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return [line for line in out.splitlines() if fragment in line and "ps -axo" not in line]


def wait_gone(pid, seconds=15):
    end = time.time() + seconds
    while time.time() < end:
        if not k._alive(pid): return True
        time.sleep(0.1)
    return False


def text_of(result): return "".join(i.get("data", "") for i in result["items"])


class Live(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CANARY_API_KEY"] = CANARY
        cls.s = k.Session("python3", ["numpy", "definitely_missing_pkg_xyz"]); cls.s.start()
        cls.conn_dir, cls.pid, cls.results = cls.s.conn_dir, cls.s.pid, []
        cls.conn = json.load(open(os.path.join(cls.conn_dir, "k.json")))
        cls.conn_mode = os.stat(os.path.join(cls.conn_dir, "k.json")).st_mode & 0o777; cls.dir_mode = os.stat(cls.conn_dir).st_mode & 0o777

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("CANARY_API_KEY", None); cls.s.shutdown()
        assert not procs_mentioning(cls.conn_dir), "kernel process survived shutdown"

    def run_cell(self, code, cell="cell.py", **kw):
        r = self.s.run(cell, code, **kw); type(self).results.append(r); return r

    def test_discovery_names_only(self):
        kernels = k.list_kernels(); self.assertIn("python3", kernels)
        self.assertNotIn("/", json.dumps(kernels)); self.assertEqual(set(kernels["python3"]), {"display", "language"})
        for bad in ["nope", "../python3", "python3; touch x", "", None]: self.assertRaises(k.KernelError, k.Session, bad)

    def test_connection_file_is_private_and_loopback_only(self):
        self.assertEqual((self.conn_mode, self.dir_mode), (0o600, 0o700)); self.assertEqual(self.conn["ip"], "127.0.0.1")
        lsof = subprocess.run(["lsof", "-nP", "-a", "-p", str(self.pid), "-iTCP"], capture_output=True, text=True).stdout
        listeners = [line for line in lsof.splitlines() if "LISTEN" in line]
        self.assertTrue(listeners); self.assertTrue(all("127.0.0.1:" in line for line in listeners), listeners)
        with k.Session("python3") as other:       # a different session gets a different key and a deleted-on-exit directory
            self.assertNotEqual(json.load(open(os.path.join(other.conn_dir, "k.json")))["key"], self.conn["key"]); gone = other.conn_dir
        self.assertFalse(os.path.exists(gone))

    def test_state_persists_counts_increase_and_streams_merge(self):
        a = self.run_cell("x = 20\nx * 2"); b = self.run_cell("print(x)\nprint('two')")
        self.assertEqual((a["status"], text_of(a)), ("ok", "40")); self.assertEqual(text_of(b), "20\ntwo\n")
        self.assertEqual(len(b["items"]), 1); self.assertEqual(b["execution_count"], a["execution_count"] + 1)

    def test_error_traceback_is_ansi_free_and_paths_redacted(self):
        r = self.run_cell("import os\nprint('\\x1b[31mred\\x1b[0m')\nraise RuntimeError('\\x1b[1mbold\\x1b[0m ' + os.path.expanduser('~') + '/work/' + os.getcwd())")
        err = r["items"][-1]; blob = json.dumps(r)
        self.assertEqual((r["status"], err["ename"]), ("error", "RuntimeError")); self.assertNotIn("\x1b", blob); self.assertEqual(r["items"][0]["data"], "red\n")
        self.assertNotIn(os.path.expanduser("~"), blob); self.assertNotIn(self.s.workdir, blob); self.assertNotIn("/var/folders", blob); self.assertIn("~", err["evalue"])

    def test_wall_clock_timeout_interrupts_and_kernel_stays_usable(self):
        t = time.time(); r = self.run_cell("import time; time.sleep(60)", timeout=1)
        self.assertEqual(r["status"], "timeout"); self.assertLess(time.time() - t, 6); self.assertEqual(text_of(self.run_cell("1 + 1")), "2")
        t = time.time(); r = self.run_cell("while True: pass", timeout=1); self.assertEqual(r["status"], "timeout"); self.assertLess(time.time() - t, 6)

    def test_cancel_from_another_thread(self):
        threading.Timer(0.7, self.s.cancel.set).start(); t = time.time()
        r = self.run_cell("import time; time.sleep(60)", timeout=30)
        self.assertEqual(r["status"], "canceled"); self.assertLess(time.time() - t, 6); self.assertEqual(text_of(self.run_cell("3 + 4")), "7")

    def test_output_is_bounded_in_bytes_and_items(self):
        t = time.time(); r = self.run_cell("print('x' * 10_000_000)")
        self.assertTrue(r["truncated"]); self.assertLessEqual(len(text_of(r)), k.MAX_TEXT)
        r = self.run_cell("import sys\nfor i in range(10**7):\n    print('y' * 100)", timeout=30)
        self.assertEqual(r["status"], "output_limit"); self.assertTrue(r["truncated"]); self.assertLessEqual(len(text_of(r)), k.MAX_OUT); self.assertLess(time.time() - t, 20)
        r = self.run_cell("from IPython.display import display\nfor i in range(300): display({'text/plain': str(i)}, raw=True)")
        self.assertLessEqual(len(r["items"]), k.MAX_ITEMS); self.assertTrue(r["truncated"]); self.assertEqual(text_of(self.run_cell("5")), "5")

    def test_only_safe_mimes_survive(self):
        png = "import base64\npng = base64.b64encode(b'\\x89PNG\\r\\n\\x1a\\n' + bytes([0,0,0,13]) + b'IHDR' + bytes([0,0,0,2,0,0,0,3]) + bytes(9)).decode()\n"
        r = self.run_cell("from IPython.display import display\n" + png + """
display({'text/html': '<script>alert(1)</script>'}, raw=True)
display({'text/html': '<b>x</b>', 'text/plain': 'plain wins'}, raw=True)
display({'image/svg+xml': '<svg onload=alert(1)/>', 'application/javascript': 'alert(1)'}, raw=True)
display({'application/vnd.jupyter.widget-view+json': {'model_id': 'x'}}, raw=True)
display({'image/png': png}, raw=True)
display({'image/png': 'bm90IGEgcG5n', 'text/plain': 'forged png'}, raw=True)
display({'application/x.table+json': {'columns': ['a'], 'rows': [[1]]}}, raw=True)""")
        mimes = [(i["mime"], i["data"] if i["mime"] != "image/png" else "png") for i in r["items"]]
        self.assertEqual(mimes, [("text/plain", "plain wins"), ("image/png", "png"), ("text/plain", "forged png"), ("application/x.table+json", {"columns": ["a"], "rows": [[1]]})])
        self.assertEqual(r["blocked"], sorted(["text/html", "image/svg+xml", "application/javascript", "application/vnd.jupyter.widget-view+json", "image/png"]))
        self.assertNotIn("alert", json.dumps(r["items"]))

    def test_environment_is_scrubbed_and_stdin_is_not_ours(self):
        self.assertEqual(text_of(self.run_cell("import os\nprint(os.environ.get('CANARY_API_KEY'), os.environ.get('JPY_PARENT_PID') is not None)")).split()[0], "None")
        r = self.run_cell("import os\nprint(repr(os.read(0, 1)))", timeout=5); self.assertEqual(r["status"], "ok")   # reads /dev/null, not the caller's pipe
        r = self.run_cell("input('x')", timeout=5); self.assertEqual((r["status"], r["items"][-1]["ename"]), ("error", "StdinNotImplementedError"))

    def test_provenance_fields_and_no_secrets_or_ports_in_results(self):
        r = self.run_cell("print(sum(range(5)))", cell="analysis/model.py", seed=42); p = r["provenance"]
        self.assertEqual((p["cell"], p["seed"], p["kernel"], p["language"], p["status"]), ("analysis/model.py", 42, "python3", "python", "ok"))
        self.assertEqual(set(p["packages"]), {"numpy", "definitely_missing_pkg_xyz"}); self.assertEqual(p["packages"]["definitely_missing_pkg_xyz"], "missing")
        self.assertRegex(p["code"], "^[0-9a-f]{64}$"); self.assertRegex(p["output"], "^[0-9a-f]{64}$"); self.assertRegex(p["runtime"], r"^\d+\.\d+")
        self.assertEqual(p["code"], k.sha256("print(sum(range(5)))")); self.assertNotIn("/", json.dumps({x: p[x] for x in p if x != "cell"}))
        blob = json.dumps(self.results)
        self.assertNotIn(self.conn["key"], blob); self.assertNotIn(self.conn_dir, blob); self.assertNotIn(CANARY, blob)
        for name in ("shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"): self.assertNotIn(f'"{name}"', blob); self.assertNotIn(f":{self.conn[name]}", blob)

    def test_input_validation(self):
        for cell in ["/abs/x.py", "../x.py", "a/../../x", "~/x", "", "a b", None]: self.assertRaises(k.KernelError, self.s.run, cell, "1")
        self.assertRaises(k.KernelError, self.s.run, "c", "x" * (k.MAX_CODE + 1)); self.assertRaises(k.KernelError, self.s.run, "c", None)
        self.assertRaises(k.KernelError, self.s.run, "c", "1", seed="7"); self.assertRaises(k.KernelError, self.s.run, "c", "1", seed=True)
        for bad in (["numpy; import os"], ["a b"], [""], ["x"] * 51): self.assertRaises(k.KernelError, k.Session, "python3", bad)


class Cleanup(unittest.TestCase):
    def test_ignored_interrupt_restarts_the_kernel_and_leaves_no_orphan(self):
        with k.Session("python3") as s:
            old, conn = s.pid, s.conn_dir
            r = s.run("c", "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ntime.sleep(100)", timeout=1)
            self.assertEqual((r["status"], r.get("restarted")), ("timeout", True)); self.assertTrue(wait_gone(old, 5)); self.assertNotEqual(s.pid, old)
            self.assertEqual(text_of(s.run("c", "6 * 7")), "42")
        self.assertEqual(procs_mentioning("kernel-"), [])

    def test_rerun_exposes_hidden_state(self):
        c1, c2 = {"cell": "a.py", "code": "x = 2"}, {"cell": "b.py", "code": "print(x + 1)"}
        with k.Session("python3") as s:
            first = s.rerun([c1, c2]); self.assertEqual((first["status"], text_of(first["cells"][1])), ("differs", "3\n"))   # no previous: everything is new
            same = s.rerun([c1, c2], first["provenance"]); self.assertEqual((same["status"], same["differences"]), ("same", []))
            s.run("a.py", "x = 2"); live = s.run("b.py", "print(x + 1)"); self.assertEqual(live["status"], "ok")
            only = s.rerun([c2], first["provenance"])        # cell a.py was deleted: the live kernel still had x, a fresh one does not
            self.assertEqual((only["cells"][0]["status"], only["cells"][0]["items"][-1]["ename"]), ("error", "NameError"))
            self.assertIn({"cell": "b.py", "change": "status_changed", "from": "ok", "to": "error"}, only["differences"]); self.assertIn({"cell": "a.py", "change": "removed"}, only["differences"])
            changed = s.rerun([c1, {"cell": "b.py", "code": "print(x + 2)"}], first["provenance"]); self.assertEqual(changed["differences"], [{"cell": "b.py", "change": "code_changed"}])
            rnd = s.rerun([{"cell": "r.py", "code": "import random\nprint(random.random())"}], [])
            again = s.rerun([{"cell": "r.py", "code": "import random\nprint(random.random())"}], rnd["provenance"]); self.assertIn({"cell": "r.py", "change": "output_changed"}, again["differences"])
            self.assertRaises(k.KernelError, s.rerun, [c1] * (k.MAX_CELLS + 1))

    def test_fallback_kills_the_kernel_when_the_normal_shutdown_fails(self):
        s = k.Session("python3"); s.start(); pid = s.pid
        def broken(**kw): raise RuntimeError("shutdown failed")
        s.km.shutdown_kernel = broken; s.shutdown()
        self.assertTrue(wait_gone(pid, 3)); self.assertEqual(procs_mentioning("kernel-"), [])

    def test_shutdown_removes_every_trace(self):
        s = k.Session("python3"); s.start(); pid, conn, work = s.pid, s.conn_dir, s.workdir; s.shutdown()
        self.assertTrue(wait_gone(pid, 3)); self.assertFalse(os.path.exists(conn)); self.assertFalse(os.path.exists(work)); s.shutdown()   # idempotent
        with tempfile.TemporaryDirectory() as mine:       # a caller-supplied project copy is never deleted
            with k.Session("python3", workdir=mine) as s2: s2.run("c", "open('marker.txt', 'w').write('x')")
            self.assertTrue(os.path.isfile(os.path.join(mine, "marker.txt")))   # the kernel ran in the caller's directory, which survives shutdown


class Cli:
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, "-B", "-I", "-W", "ignore", SCRIPT], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.q = queue.Queue(); threading.Thread(target=lambda: [self.q.put(l) for l in self.p.stdout], daemon=True).start(); self.n = 0
    def send(self, **req): self.n += 1; self.p.stdin.write(json.dumps({"id": self.n, **req}) + "\n"); self.p.stdin.flush(); return self.n
    def get(self, timeout=60): return json.loads(self.q.get(timeout=timeout))
    def call(self, **req): rid = self.send(**req); r = self.get(); assert r["id"] == rid; return r
    def kernel_children(self): return [int(x) for x in subprocess.run(["pgrep", "-P", str(self.p.pid)], capture_output=True, text=True).stdout.split()]


class CommandLine(unittest.TestCase):
    def test_json_lines_contract_and_interrupt_during_run(self):
        cli = Cli()
        try:
            self.assertIn("python3", cli.call(op="list")["kernels"]); self.assertEqual(cli.call(op="run", cell="c", code="1")["status"], "unsupported")
            started = cli.call(op="start", kernel="python3", packages=["numpy"]); self.assertEqual((started["status"], started["language"]), ("ok", "python")); self.assertEqual(started["packages"]["numpy"][0].isdigit(), True)
            self.assertEqual(cli.call(op="start", kernel="python3")["status"], "error")
            self.assertEqual(cli.call(op="run", cell="c", code="2 + 2")["items"][0]["data"], "4")
            self.assertEqual(cli.call(op="run", cell="/abs", code="1")["status"], "error")
            rid = cli.send(op="run", cell="c", code="import time; time.sleep(60)", timeout=60); time.sleep(1.0); cli.send(op="interrupt")
            r = cli.get(15); self.assertEqual((r["id"], r["status"]), (rid, "canceled"))
            self.assertNotIn("shell_port", json.dumps(r)); self.assertNotIn("kernel-", json.dumps(r)); self.assertEqual(cli.call(op="shutdown")["status"], "ok")
            self.assertEqual(cli.kernel_children(), [])
        finally: cli.p.kill()

    def test_kernel_dies_when_the_cli_is_killed_or_stdin_closes(self):
        for how in ("sigkill", "eof", "sigterm"):
            cli = Cli()
            try:
                self.assertEqual(cli.call(op="start", kernel="python3")["status"], "ok"); kids = cli.kernel_children(); self.assertTrue(kids)
                if how == "sigkill": cli.p.send_signal(signal.SIGKILL)
                elif how == "sigterm": cli.p.send_signal(signal.SIGTERM)
                else: cli.p.stdin.close()
                for pid in kids: self.assertTrue(wait_gone(pid, 20), f"kernel {pid} survived {how}")
                cli.p.wait(10)
            finally: cli.p.kill()
        self.assertEqual(procs_mentioning("kernel-"), [])


@unittest.skipUnless("ir" in (k.list_kernels() if True else {}), "no R kernelspec installed")
class RKernel(unittest.TestCase):
    def test_r_cell_provenance_and_cleanup(self):
        with k.Session("ir", ["stats", "definitely_missing_pkg_xyz"]) as s:
            pid, conn = s.pid, s.conn_dir
            r = s.run("m.R", "x <- c(1, 2, 3)\nmean(x)", seed=1); self.assertEqual(r["status"], "ok"); self.assertIn("2", text_of(r))
            self.assertEqual((s.language, r["provenance"]["packages"]["definitely_missing_pkg_xyz"]), ("R", "missing")); self.assertRegex(r["provenance"]["packages"]["stats"], r"^\d+\.\d+")
            self.assertEqual(s.run("m.R", "stop('boom ', path.expand('~'))")["status"], "error")
            t = time.time(); self.assertEqual(s.run("m.R", "Sys.sleep(60)", timeout=1)["status"], "timeout"); self.assertLess(time.time() - t, 8)
            hidden = s.rerun([{"cell": "b.R", "code": "mean(x)"}], []); self.assertEqual(hidden["cells"][0]["status"], "error")   # x is gone in a fresh kernel
        self.assertTrue(wait_gone(pid, 10)); self.assertEqual(procs_mentioning(conn), [])


if __name__ == "__main__":
    unittest.main()
