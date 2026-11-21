# SPDX-License-Identifier: AGPL-3.0-only
"""Checks for runtime/research/analysis.{py,R} against independent computations (exact Fraction normal equations,
a manual HC1 sandwich, scipy, a manual within estimator). Needs the user's Python with numpy/pandas/statsmodels/scipy and Rscript:
   <python> -B -I test/research_analysis_test.py
"""
import json, math, os, subprocess, sys, tempfile, unittest
from fractions import Fraction
import numpy as np
from scipy import stats

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "research")
RSCRIPT = os.environ.get("RSCRIPT", "Rscript")


def run_py(request): return json.loads(subprocess.run([sys.executable, "-B", "-I", os.path.join(ROOT, "analysis.py")], input=json.dumps(request), capture_output=True, text=True, timeout=120).stdout)
def run_r(request):
    done = subprocess.run([RSCRIPT, "--vanilla", os.path.join(ROOT, "analysis.R")], input=json.dumps(request), capture_output=True, text=True, timeout=120)
    return json.loads(done.stdout)


def solve(a, b):   # exact Gauss-Jordan on Fractions
    n = len(a); m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = next(r for r in range(c, n) if m[r][c] != 0); m[c], m[p] = m[p], m[c]
        m[c] = [v / m[c][c] for v in m[c]]
        for r in range(n):
            if r != c: m[r] = [v - m[r][c] * w for v, w in zip(m[r], m[c])]
    return [m[i][n] for i in range(n)]


def exact_ols(y, xs):
    X = [[Fraction(1)] + [Fraction(c[i]).limit_denominator(10**6) for c in xs] for i in range(len(y))]; Y = [Fraction(v).limit_denominator(10**6) for v in y]
    XtX = [[sum(r[i] * r[j] for r in X) for j in range(len(X[0]))] for i in range(len(X[0]))]
    beta = solve(XtX, [sum(r[i] * v for r, v in zip(X, Y)) for i in range(len(X[0]))])
    inv = [solve(XtX, [Fraction(int(i == j)) for i in range(len(XtX))]) for j in range(len(XtX))]
    resid = [v - sum(b * x for b, x in zip(beta, r)) for r, v in zip(X, Y)]
    s2 = sum(e * e for e in resid) / (len(Y) - len(beta))
    tss = sum((v - sum(Y) / len(Y)) ** 2 for v in Y)
    return {"beta": [float(b) for b in beta], "se": [math.sqrt(float(s2 * inv[j][j])) for j in range(len(beta))], "r2": float(1 - sum(e * e for e in resid) / tss), "df": len(Y) - len(beta)}


# deterministic small dataset with noise; two regressors, one correlated with the other
X1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; X2 = [2.5, 1.0, 4.5, 3.0, 6.5, 4.0, 8.5, 5.0, 10.5, 7.0, 12.5, 9.0]
Y = [3.1, 4.9, 8.2, 8.8, 13.4, 13.1, 18.9, 17.6, 24.2, 22.3, 29.8, 27.1]
DATA = {"y": Y, "x1": X1, "x2": X2}


class Regression(unittest.TestCase):
    def check(self, r, expected, tol=1e-8):
        self.assertEqual(r["status"], "computed", r)
        self.assertEqual(r["terms"], ["(Intercept)", "x1", "x2"]); self.assertEqual((r["nobs"], r["dropped_rows"], r["df_resid"]), (12, 0, expected["df"]))
        for got, want in zip(r["estimate"], expected["beta"]): self.assertAlmostEqual(got, want, delta=tol * (1 + abs(want)))
        for got, want in zip(r["std_error"], expected["se"]): self.assertAlmostEqual(got, want, delta=tol * (1 + want))
        self.assertAlmostEqual(r["r_squared"], expected["r2"], delta=tol)
        for t, b, se, p, lo, hi in zip(r["t"], r["estimate"], r["std_error"], r["p"], r["ci_low"], r["ci_high"]):
            self.assertAlmostEqual(t, b / se, delta=1e-8 * (1 + abs(t)))
            self.assertAlmostEqual(p, 2 * stats.t.sf(abs(t), expected["df"]), delta=1e-9)
            q = stats.t.ppf(0.975, expected["df"]); self.assertAlmostEqual(lo, b - q * se, delta=1e-8); self.assertAlmostEqual(hi, b + q * se, delta=1e-8)

    def test_python_and_r_match_exact_normal_equations(self):
        want = exact_ols(Y, [X1, X2])
        for runner in (run_py, run_r): self.check(runner({"op": "ols", "data": DATA, "y": "y", "x": ["x1", "x2"]}), want)

    def test_hc1_robust_errors_match_a_manual_sandwich(self):
        X = np.column_stack([np.ones(12), X1, X2]); y = np.array(Y); bread = np.linalg.inv(X.T @ X); e = y - X @ (bread @ X.T @ y)
        want = np.sqrt(np.diag(bread @ (X.T * e**2) @ X @ bread) * 12 / (12 - 3))
        r = run_py({"op": "ols", "data": DATA, "y": "y", "x": ["x1", "x2"], "robust": True})
        self.assertIn("HC1", r["method"]); np.testing.assert_allclose(r["std_error"], want, rtol=1e-8)

    def test_missing_rows_are_dropped_listwise_and_reported(self):
        data = {k: list(v) for k, v in DATA.items()}; data["x2"][3] = None; data["y"][9] = None
        want = exact_ols([v for i, v in enumerate(Y) if i not in (3, 9)], [[v for i, v in enumerate(c) if i not in (3, 9)] for c in (X1, X2)])
        for runner in (run_py, run_r):
            r = runner({"op": "ols", "data": data, "y": "y", "x": ["x1", "x2"]})
            self.assertEqual((r["nobs"], r["dropped_rows"], r["missing_policy"]), (10, 2, "listwise deletion"))
            self.assertAlmostEqual(r["estimate"][1], want["beta"][1], delta=1e-8)

    def test_unsupported_and_inconclusive_states_are_explicit(self):
        cases = [({"y": "y", "x": ["nope"]}, "unsupported"), ({"y": "y", "x": ["y"]}, "unsupported"), ({"y": "y", "x": []}, "unsupported"), ({"y": "y", "x": ["x1", "x1"]}, "unsupported"),
                 ({"y": "y", "x": ["x1", "dup"]}, "inconclusive"), ({"y": "y", "x": ["lab"]}, "unsupported")]
        data = {**DATA, "dup": [2 * v for v in X1], "lab": list("abcdefghijkl")}
        for runner in (run_py, run_r):
            for extra, status in cases: self.assertEqual(runner({"op": "ols", "data": data, **extra})["status"], status, (runner.__name__, extra))
            self.assertEqual(runner({"op": "ols", "data": {"y": [1, 2], "x1": [1, 2]}, "y": "y", "x": ["x1"]})["status"], "inconclusive")
            self.assertEqual(runner({"op": "frobnicate", "data": DATA})["status"], "unsupported")
            self.assertEqual(runner({"op": "ols", "y": "y", "x": ["x1"]})["status"], "unsupported")

    def test_column_names_are_never_parsed_as_code(self):
        marker = os.path.join(tempfile.gettempdir(), "research-injection-marker"); evil = f"x1) + I(system('touch {marker}'))"
        data = {"y": Y, evil: X1}
        for runner in (run_py, run_r):
            r = runner({"op": "ols", "data": data, "y": "y", "x": [evil]})
            self.assertEqual(r["status"], "computed"); self.assertEqual(r["terms"][1], evil); self.assertAlmostEqual(r["estimate"][1], exact_ols(Y, [X1])["beta"][1], delta=1e-8)
        self.assertFalse(os.path.exists(marker))

    def test_csv_path_input_and_limits(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "d.csv"); open(path, "w").write("y,x1\n" + "\n".join(f"{a},{b}" for a, b in zip(Y, X1)))
            for runner in (run_py, run_r): self.assertEqual(runner({"op": "ols", "csv": path, "y": "y", "x": ["x1"]})["nobs"], 12)
            for runner in (run_py, run_r): self.assertEqual(runner({"op": "ols", "csv": os.path.join(d, "absent.csv"), "y": "y", "x": ["x1"]})["status"], "unsupported")

    def test_describe(self):
        r = run_py({"op": "describe", "data": {"a": [1, 2, 3, None], "b": [1.5, 2.5, 4.0, 8.0]}, "columns": ["a", "b"]})
        self.assertEqual((r["rows"][0]["n"], r["rows"][0]["missing"]), (3, 1)); self.assertAlmostEqual(r["rows"][0]["sd"], 1.0); self.assertAlmostEqual(r["rows"][1]["mean"], 4.0)
        self.assertEqual(run_py({"op": "describe", "data": {"a": ["x", "y"]}, "columns": ["a"]})["status"], "unsupported")


class RStatistics(unittest.TestCase):
    A = [5.1, 4.9, 6.2, 5.8, 6.6, 5.0, 7.1, 6.3]; B = [4.1, 5.2, 4.8, 3.9, 5.5, 4.4, 4.0, 5.1, 4.6]

    def test_one_and_two_sample_t_tests_match_scipy(self):
        r = run_r({"op": "ttest", "data": {"v": self.A}, "x": "v", "mu": 5, "conf_level": 0.9}); s = stats.ttest_1samp(self.A, 5); ci = s.confidence_interval(0.9)
        self.assertAlmostEqual(r["t"], s.statistic, places=9); self.assertAlmostEqual(r["p"], s.pvalue, places=9); self.assertAlmostEqual(r["ci_low"], ci.low, places=9); self.assertEqual(r["df"], 7)
        data = {"v": self.A + self.B, "g": ["a"] * len(self.A) + ["b"] * len(self.B)}
        r = run_r({"op": "ttest", "data": data, "x": "v", "group": "g"}); s = stats.ttest_ind(self.A, self.B, equal_var=False); ci = s.confidence_interval(0.95)
        self.assertAlmostEqual(r["t"], s.statistic, places=9); self.assertAlmostEqual(r["p"], s.pvalue, places=9); self.assertAlmostEqual(r["ci_low"], ci.low, places=9); self.assertAlmostEqual(r["ci_high"], ci.high, places=9)
        self.assertAlmostEqual(r["difference"], np.mean(self.A) - np.mean(self.B), places=12); self.assertEqual(r["groups"], ["a", "b"])

    def test_t_test_failures_are_explicit(self):
        d = {"v": self.A, "g": ["a"] * 4 + ["b"] * 3 + ["c"], "s": list("abcdefgh")}
        self.assertEqual(run_r({"op": "ttest", "data": d, "x": "v", "group": "g"})["status"], "unsupported")
        self.assertEqual(run_r({"op": "ttest", "data": d, "x": "s"})["status"], "unsupported")
        self.assertEqual(run_r({"op": "ttest", "data": d, "x": "v", "conf_level": 1.5})["status"], "unsupported")
        self.assertEqual(run_r({"op": "ttest", "data": {"v": [1.0]}, "x": "v"})["status"], "inconclusive")

    def test_panel_fixed_effects_match_the_within_estimator(self):
        rng = np.random.default_rng(7); ids = np.repeat(np.arange(5), 8); x = rng.normal(size=40) + ids; y = 2 * x + 3 * ids + rng.normal(scale=.5, size=40)
        xd = x - np.array([x[ids == i].mean() for i in ids]); yd = y - np.array([y[ids == i].mean() for i in ids]); slope = (xd @ yd) / (xd @ xd)
        r = run_r({"op": "panel_fe", "data": {"y": y.tolist(), "x": x.tolist(), "id": [f"e{i}" for i in ids]}, "y": "y", "x": ["x"], "id": "id"})
        self.assertEqual(r["status"], "computed"); self.assertEqual(r["terms"], ["(Intercept)", "x"]); self.assertAlmostEqual(r["estimate"][1], slope, places=9)
        self.assertEqual((r["entities"], r["nobs"], r["df_resid"]), (5, 40, 40 - 5 - 1)); self.assertIn("NOT clustered", r["method"])
        self.assertEqual(run_r({"op": "panel_fe", "data": {"y": [1, 2, 3, 4], "x": [1, 2, 2, 5]}, "y": "y", "x": ["x"], "id": "id"})["status"], "unsupported")

    def test_arima_recovers_a_simulated_ar1_and_matches_statsmodels(self):
        from statsmodels.tsa.arima.model import ARIMA
        rng = np.random.default_rng(11); e = rng.normal(size=400); z = np.zeros(400)
        for t in range(1, 400): z[t] = .6 * z[t - 1] + e[t]
        r = run_r({"op": "arima", "data": {"z": z.tolist()}, "x": "z", "order": [1, 0, 0]}); ref = ARIMA(z, order=(1, 0, 0), trend="c").fit()
        self.assertEqual(r["status"], "computed"); self.assertEqual(r["terms"], ["ar1", "intercept"])
        self.assertAlmostEqual(r["estimate"][0], ref.params[1], delta=0.01); self.assertAlmostEqual(r["estimate"][0], .6, delta=3 * r["std_error"][0])
        self.assertGreater(r["ljung_box_p"], 0.01)
        self.assertEqual(run_r({"op": "arima", "data": {"z": z[:6].tolist()}, "x": "z", "order": [1, 0, 0]})["status"], "inconclusive")
        self.assertEqual(run_r({"op": "arima", "data": {"z": z.tolist()}, "x": "z", "order": [9, 0, 0]})["status"], "unsupported")
        self.assertEqual(run_r({"op": "arima", "data": {"z": [None] + z[1:60].tolist()}, "x": "z", "order": [1, 0, 0]})["status"], "inconclusive")


def sm_fit(y, X, **kw):
    import statsmodels.api as sm
    return sm.OLS(np.asarray(y, float), np.asarray(X, float)).fit(**kw)


def render_png(b64):
    """Validate with the real outputs.mjs, exactly as the UI will."""
    url = "file://" + os.path.abspath(os.path.join(ROOT, "outputs.mjs"))
    code = f"import {{renderOutput}} from '{url}'; let s=''; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.stringify(renderOutput('image/png', s.trim())));"
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", code], input=b64, capture_output=True, text=True, timeout=60).stdout)


class Figures(unittest.TestCase):
    REQ = {"op": "figure", "data": DATA, "y": "y", "x": ["x1"]}

    def test_png_passes_the_ui_validator_is_deterministic_and_reports_the_fit(self):
        r = run_py(self.REQ); self.assertEqual(r["status"], "computed")
        shown = render_png(r["png_base64"]); self.assertEqual((shown["kind"], shown["width"], shown["height"]), ("image", r["width"], r["height"]))
        self.assertEqual((r["width"], r["height"]), (800, 360)); self.assertLess(len(r["png_base64"]) * 3 // 4, 200_000)
        self.assertEqual(run_py(self.REQ)["png_base64"], r["png_base64"])
        want = exact_ols(Y, [X1])["beta"]; self.assertAlmostEqual(r["estimate"][0], want[0], places=8); self.assertAlmostEqual(r["estimate"][1], want[1], places=8)
        self.assertNotEqual(run_py({**self.REQ, "data": {**DATA, "y": Y[::-1]}})["png_base64"], r["png_base64"])   # the picture depends on the data

    def test_no_pyplot_state_and_no_files_written_to_the_working_directory(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("analysis_inproc", os.path.join(ROOT, "analysis.py")); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        before = set(sys.modules)
        self.assertEqual(mod.handle(self.REQ)["status"], "computed"); self.assertEqual(mod.handle(self.REQ)["status"], "computed")
        self.assertNotIn("matplotlib.pyplot", set(sys.modules) - before)
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([sys.executable, "-B", "-I", os.path.join(ROOT, "analysis.py")], input=json.dumps(self.REQ), capture_output=True, text=True, cwd=d, timeout=120)
            self.assertEqual(os.listdir(d), [])

    def test_labels_are_text_not_mathtext_or_code(self):
        marker = os.path.join(tempfile.gettempdir(), "research-figure-marker")
        for name in ["price $ (usd)", "$\\notacommand{x}$", "$\\mathrm{bad", f"__import__('os').system('touch {marker}')", "x" * 300, "<script>alert(1)</script>"]:
            r = run_py({"op": "figure", "data": {"y": Y, name: X1}, "y": "y", "x": [name]}); self.assertEqual(r["status"], "computed", name)
            self.assertEqual(render_png(r["png_base64"])["kind"], "image"); self.assertEqual(r["terms"][1], name)
        self.assertFalse(os.path.exists(marker))

    def test_missing_rows_are_dropped_and_limits_are_explicit(self):
        data = {k: list(v) for k, v in DATA.items()}; data["x1"][2] = None; data["y"][7] = None
        r = run_py({**self.REQ, "data": data}); self.assertEqual((r["nobs"], r["dropped_rows"]), (10, 2))
        want = exact_ols([v for i, v in enumerate(Y) if i not in (2, 7)], [[v for i, v in enumerate(X1) if i not in (2, 7)]])["beta"]; self.assertAlmostEqual(r["estimate"][1], want[1], places=8)
        for req, status in [({**self.REQ, "x": ["x1", "x2"]}, "unsupported"), ({**self.REQ, "x": ["nope"]}, "unsupported"), ({**self.REQ, "data": {"y": Y, "x1": [3] * 12}}, "inconclusive"),
                            ({**self.REQ, "data": {"y": [1, 2], "x1": [1, 2]}}, "inconclusive"), ({**self.REQ, "data": {"y": list(range(20001)), "x1": [v % 7 + v / 3 for v in range(20001)]}}, "unsupported"),
                            ({**self.REQ, "data": {"y": Y, "x1": list("abcdefghijkl")}}, "unsupported")]:
            self.assertEqual(run_py(req)["status"], status, req["x"])


class Optimization(unittest.TestCase):
    LX = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; LY = [2.1, 3.9, 6.2, 8.1, 9.8, 12.2, 13.9, 40.0, 18.1, 19.9]    # one gross outlier at x=8

    def lad_brute(self, x, y):
        best = None
        for i in range(len(x)):
            for j in range(i + 1, len(x)):
                if x[i] == x[j]: continue
                m = (y[j] - y[i]) / (x[j] - x[i]); c = y[i] - m * x[i]; obj = sum(abs(b - (c + m * a)) for a, b in zip(x, y))
                best = obj if best is None else min(best, obj)
        return best

    def test_lad_reaches_the_brute_force_optimum_and_resists_the_outlier(self):
        r = run_py({"op": "optimize", "objective": "lad", "data": {"y": self.LY, "x": self.LX}, "y": "y", "x": ["x"]})
        self.assertEqual((r["status"], r["converged"], r["solver_status"]), ("computed", True, 0)); self.assertGreater(r["iterations"], 0)
        self.assertAlmostEqual(r["objective"], self.lad_brute(self.LX, self.LY), places=7)
        c, m = r["estimate"]; self.assertAlmostEqual(sum(abs(b - (c + m * a)) for a, b in zip(self.LX, self.LY)), r["objective"], places=7)
        self.assertAlmostEqual(m, 2.0, delta=0.1); self.assertGreater(exact_ols(self.LY, [self.LX])["beta"][1], 2.4)      # OLS is dragged up, LAD is not
        self.assertEqual(r["objective_name"], "sum of absolute deviations")

    def test_bounded_least_squares_matches_the_exact_reduced_problem(self):
        free = exact_ols(Y, [X1, X2])["beta"]
        r = run_py({"op": "optimize", "objective": "bounded_ls", "data": DATA, "y": "y", "x": ["x1", "x2"], "bounds": {"x1": [-100, 100]}})
        for got, want in zip(r["estimate"], free): self.assertAlmostEqual(got, want, places=7)
        self.assertEqual(r["active_bounds"], [])
        cap = free[2] - 0.5                                                   # force x2 down to its upper bound; remaining terms solve the exact reduced OLS
        r = run_py({"op": "optimize", "objective": "bounded_ls", "data": DATA, "y": "y", "x": ["x1", "x2"], "bounds": {"x2": [None, cap]}})
        reduced = exact_ols([v - cap * b for v, b in zip(Y, X2)], [X1])["beta"]
        self.assertAlmostEqual(r["estimate"][2], cap, places=9); self.assertEqual(r["active_bounds"], ["x2"])
        self.assertAlmostEqual(r["estimate"][0], reduced[0], places=7); self.assertAlmostEqual(r["estimate"][1], reduced[1], places=7)
        rss = sum((v - r["estimate"][0] - r["estimate"][1] * a - r["estimate"][2] * b) ** 2 for v, a, b in zip(Y, X1, X2)); self.assertAlmostEqual(r["objective"], rss, places=7)
        free_rss = (1 - exact_ols(Y, [X1, X2])["r2"]) * sum((v - sum(Y) / 12) ** 2 for v in Y); self.assertGreater(r["objective"], free_rss)   # an active bound cannot lower the RSS

    def test_expression_objectives_never_run_and_bad_inputs_are_explicit(self):
        marker = os.path.join(tempfile.gettempdir(), "research-optimize-marker"); base = {"op": "optimize", "data": DATA, "y": "y", "x": ["x1"]}
        for req, status in [({"objective": f"__import__('os').system('touch {marker}')"}, "unsupported"), ({"objective": "sum((y-b)**2)"}, "unsupported"), ({"objective": ""}, "unsupported"),
                            ({"objective": "lad", "bounds": {"x1": [0, 1]}}, "unsupported"), ({"objective": "bounded_ls", "bounds": {"x1": [2, 1]}}, "unsupported"),
                            ({"objective": "bounded_ls", "bounds": {"zzz": [0, 1]}}, "unsupported"), ({"objective": "bounded_ls", "bounds": {"x1": ["0", 1]}}, "unsupported"),
                            ({"objective": "bounded_ls", "bounds": {"x1": [0]}}, "unsupported"), ({"objective": "bounded_ls", "bounds": {"x1": [float("inf"), 5]}}, "unsupported")]:
            self.assertEqual(run_py({**base, **req})["status"], status, req)
        self.assertFalse(os.path.exists(marker))
        self.assertIn("exceeds", run_py({**base, "objective": "bounded_ls", "bounds": {"x1": [2, 1]}})["reason"])     # a clear reason, not a solver error
        self.assertIn("unknown term", run_py({**base, "objective": "bounded_ls", "bounds": {"zzz": [0, 1]}})["reason"])
        data = {**DATA, "dup": [2 * v for v in X1]}
        for obj in ("lad", "bounded_ls"):
            self.assertEqual(run_py({"op": "optimize", "objective": obj, "data": data, "y": "y", "x": ["x1", "dup"]})["status"], "inconclusive")
            self.assertEqual(run_py({"op": "optimize", "objective": obj, "data": {"y": [1, 2], "x": [1, 2]}, "y": "y", "x": ["x"]})["status"], "inconclusive")
        n = 2001; self.assertEqual(run_py({"op": "optimize", "objective": "lad", "data": {"y": [v % 5 + v / 9 for v in range(n)], "x": list(range(n))}, "y": "y", "x": ["x"]})["status"], "unsupported")

    def test_missing_rows_and_hostile_column_names(self):
        data = {"y": list(self.LY), "x": list(self.LX)}; data["y"][0] = None; data["x"][5] = None
        keep = [i for i in range(10) if i not in (0, 5)]; xs, ys = [self.LX[i] for i in keep], [self.LY[i] for i in keep]
        r = run_py({"op": "optimize", "objective": "lad", "data": data, "y": "y", "x": ["x"]}); self.assertEqual((r["nobs"], r["dropped_rows"]), (8, 2)); self.assertAlmostEqual(r["objective"], self.lad_brute(xs, ys), places=7)
        marker = os.path.join(tempfile.gettempdir(), "research-optimize-name-marker"); evil = f"x') or __import__('os').system('touch {marker}') #"
        for obj, bounds in (("lad", None), ("bounded_ls", {evil: [0, 5]})):
            r = run_py({"op": "optimize", "objective": obj, "data": {"y": self.LY, evil: self.LX}, "y": "y", "x": [evil], "bounds": bounds}); self.assertEqual(r["status"], "computed"); self.assertEqual(r["terms"][1], evil)
        self.assertFalse(os.path.exists(marker))


def clustered_data(seed=5, groups=12, per=6):
    rng = np.random.default_rng(seed); g = np.repeat(np.arange(groups), per); shock = rng.normal(size=groups)[g]
    x = rng.normal(size=groups * per) + 0.5 * shock; y = 1.0 + 2.0 * x + 1.5 * shock + rng.normal(scale=.7, size=groups * per)
    return g, x, y


def manual_cr1(X, e, g):
    X = np.asarray(X, float); n, k = X.shape; ids = np.unique(g); bread = np.linalg.inv(X.T @ X)
    meat = sum(np.outer(X[g == i].T @ e[g == i], X[g == i].T @ e[g == i]) for i in ids)
    return bread @ meat @ bread * len(ids) / (len(ids) - 1) * (n - 1) / (n - k)


class ClusterAndHac(unittest.TestCase):
    def test_ols_cluster_robust_errors_match_manual_cr1_and_statsmodels(self):
        g, x, y = clustered_data(); X = np.column_stack([np.ones_like(x), x]); fit = sm_fit(y, X); V = manual_cr1(X, y - X @ fit.params, g); ref = sm_fit(y, X, cov_type="cluster", cov_kwds={"groups": g})
        r = run_r({"op": "ols", "data": {"y": y.tolist(), "x": x.tolist(), "firm": [f"f{i}" for i in g]}, "y": "y", "x": ["x"], "cluster": "firm"})
        self.assertEqual((r["status"], r["terms"], r["df_inference"]), ("computed", ["(Intercept)", "x"], 11)); self.assertIn("CR1", r["method"]); self.assertNotIn("NOT clustered", r["method"])
        np.testing.assert_allclose(r["std_error"], np.sqrt(np.diag(V)), rtol=1e-9); np.testing.assert_allclose(r["std_error"], ref.bse, rtol=1e-9); np.testing.assert_allclose(r["estimate"], fit.params, rtol=1e-9)
        t = np.array(r["estimate"]) / np.array(r["std_error"]); np.testing.assert_allclose(r["p"], 2 * stats.t.sf(abs(t), 11), rtol=1e-8)
        q = stats.t.ppf(0.975, 11); np.testing.assert_allclose(r["ci_low"], np.array(r["estimate"]) - q * np.array(r["std_error"]), rtol=1e-9)
        plain = run_r({"op": "ols", "data": {"y": y.tolist(), "x": x.tolist()}, "y": "y", "x": ["x"]}); self.assertNotEqual(plain["std_error"][1], r["std_error"][1])   # clustering changes the answer here

    def test_fixed_effects_with_and_without_clustering(self):
        import pandas as pd
        g, x, y = clustered_data(seed=9, groups=8, per=7); ids = [f"e{i}" for i in g]; grp = [f"c{i // 2}" for i in g]      # clusters coarser than entities
        D = pd.get_dummies(pd.Series(ids), drop_first=True, dtype=float).to_numpy(); X = np.column_stack([np.ones_like(x), x, D])
        data = {"y": y.tolist(), "x": x.tolist(), "id": ids, "grp": grp}
        r = run_r({"op": "panel_fe", "data": data, "y": "y", "x": ["x"], "id": "id", "cluster": "id"})
        ref = sm_fit(y, X, cov_type="cluster", cov_kwds={"groups": g}); self.assertEqual((r["clusters"], r["entities"], r["df_inference"]), (8, 8, 7)); self.assertNotIn("NOT clustered", r["method"]); self.assertIn("Stata", r["method"])
        np.testing.assert_allclose(r["std_error"], ref.bse[:2], rtol=1e-9); np.testing.assert_allclose(r["estimate"], ref.params[:2], rtol=1e-9)
        coarse = np.array([i // 2 for i in g]); r2 = run_r({"op": "panel_fe", "data": data, "y": "y", "x": ["x"], "id": "id", "cluster": "grp"})
        np.testing.assert_allclose(r2["std_error"], sm_fit(y, X, cov_type="cluster", cov_kwds={"groups": coarse}).bse[:2], rtol=1e-9); self.assertEqual(r2["clusters"], 4)
        plain = run_r({"op": "panel_fe", "data": data, "y": "y", "x": ["x"], "id": "id"}); self.assertIn("NOT clustered", plain["method"]); self.assertNotIn("clusters", plain)

    def test_missing_data_unsupported_cases_and_hostile_names(self):
        g, x, y = clustered_data(seed=3, groups=6, per=5); ids = [f"f{i}" for i in g]
        xl, yl, il = x.tolist(), y.tolist(), list(ids); xl[4] = None; il[11] = None; yl[20] = None
        keep = [i for i in range(30) if i not in (4, 11, 20)]; Xk = np.column_stack([np.ones(27), x[keep]]); gk = g[keep]
        r = run_r({"op": "ols", "data": {"y": yl, "x": xl, "c": il}, "y": "y", "x": ["x"], "cluster": "c"})
        self.assertEqual((r["nobs"], r["dropped_rows"]), (27, 3)); np.testing.assert_allclose(r["std_error"], sm_fit(y[keep], Xk, cov_type="cluster", cov_kwds={"groups": gk}).bse, rtol=1e-9)
        d = {"y": y.tolist(), "x": x.tolist(), "c": ids}
        for extra, status in [({"cluster": "nope"}, "unsupported"), ({"cluster": "y"}, "unsupported"), ({"cluster": "x"}, "unsupported"), ({"cluster": ["a", "b"]}, "unsupported"), ({"cluster": "c", "hac_lags": 2}, "unsupported")]:
            self.assertEqual(run_r({"op": "ols", "data": d, "y": "y", "x": ["x"], **extra})["status"], status, extra)
        self.assertEqual(run_r({"op": "ols", "data": {**d, "c": ["same"] * 30}, "y": "y", "x": ["x"], "cluster": "c"})["status"], "inconclusive")
        self.assertEqual(run_r({"op": "panel_fe", "data": d, "y": "y", "x": ["x"], "id": "c", "cluster": "y"})["status"], "unsupported")
        marker = os.path.join(tempfile.gettempdir(), "research-cluster-marker"); evil = f"c') + system('touch {marker}') #"; evil_x = f"x\"); system('touch {marker}'); (\""
        for op, extra in (("ols", {}), ("panel_fe", {"id": evil})):
            r = run_r({"op": op, "data": {"y": y.tolist(), evil_x: x.tolist(), evil: ids}, "y": "y", "x": [evil_x], "cluster": evil, **extra}); self.assertEqual(r["status"], "computed", op); self.assertIn(evil, r["method"])
        self.assertFalse(os.path.exists(marker))

    def test_newey_west_hac_matches_statsmodels(self):
        rng = np.random.default_rng(21); n = 120; e = np.zeros(n); w = rng.normal(size=n)
        for t in range(1, n): e[t] = 0.7 * e[t - 1] + w[t]
        x = np.cumsum(rng.normal(size=n)) * 0.2 + rng.normal(size=n); y = 1 + 0.5 * x + e; X = np.column_stack([np.ones(n), x]); data = {"y": y.tolist(), "x": x.tolist()}
        for lags in (0, 3, 8):
            r = run_r({"op": "ols", "data": data, "y": "y", "x": ["x"], "hac_lags": lags}); ref = sm_fit(y, X, cov_type="HAC", cov_kwds={"maxlags": lags})
            self.assertEqual((r["status"], r["df_inference"]), ("computed", n - 2)); np.testing.assert_allclose(r["std_error"], ref.bse, rtol=1e-9); self.assertIn("Newey-West", r["method"])
            t = np.array(r["estimate"]) / np.array(r["std_error"]); np.testing.assert_allclose(r["p"], 2 * stats.t.sf(abs(t), n - 2), rtol=1e-8)
        self.assertGreater(run_r({"op": "ols", "data": data, "y": "y", "x": ["x"], "hac_lags": 8})["std_error"][1], run_r({"op": "ols", "data": data, "y": "y", "x": ["x"]})["std_error"][1])   # positive autocorrelation widens the SE
        xm = list(data["x"]); xm[10] = None
        self.assertEqual(run_r({"op": "ols", "data": {**data, "x": xm}, "y": "y", "x": ["x"], "hac_lags": 3})["status"], "inconclusive")
        for bad in (-1, 1.5, 100, "3", [2, 3]): self.assertEqual(run_r({"op": "ols", "data": data, "y": "y", "x": ["x"], "hac_lags": bad})["status"], "unsupported", bad)


if __name__ == "__main__":
    unittest.main()
