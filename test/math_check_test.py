# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic checks for runtime/math-check/mathcheck.py. Needs a Python with SymPy (the user's own environment):
   <python-with-sympy> -B -I test/math_check_test.py
"""
import json, os, subprocess, sys, time, unittest
from fractions import Fraction
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "math-check"))
import mathcheck as mc
import sympy as sp

POS = {"symbols": {"x": ["positive"]}}


def status(text, context=None): return mc.check(text, context)["status"]


class Identities(unittest.TestCase):
    def test_correct_identities_pass_only_the_supported_check(self):
        self.assertEqual(status(r"(x+1)^2 = x^2 + 2x + 1"), "no_issue_found")
        self.assertEqual(status(r"\sin^2 x + \cos^2 x = 1"), "no_issue_found")
        self.assertEqual(status(r"\ln(ab) = \ln a + \ln b", {"symbols": {"a": ["positive"], "b": ["positive"]}}), "no_issue_found")

    def test_wrong_transformation_gets_a_counterexample_and_range(self):
        r = mc.check(r"(a+b)^2 = a^2 + b^2", base=100)
        self.assertEqual(r["status"], "issue_found")
        step = r["steps"][0]
        self.assertEqual(step["range"], [100, 100 + len(r"(a+b)^2 = a^2 + b^2")])
        self.assertEqual(set(step["counterexample"]["at"]), {"a", "b"})
        a, b = (Fraction(step["counterexample"]["at"][k]) for k in "ab")
        self.assertNotEqual((a + b) ** 2, a * a + b * b)  # the reported point really is a counterexample

    def test_sqrt_of_square_needs_a_sign_assumption(self):
        self.assertEqual(status(r"\sqrt{x^2} = x"), "issue_found")
        self.assertEqual(status(r"\sqrt{x^2} = x", POS), "no_issue_found")
        self.assertEqual(status(r"\sqrt{x^2} = x", {"symbols": {"x": ["negative"]}}), "issue_found")

    def test_cancellation_hides_a_domain_exclusion(self):
        r = mc.check(r"\frac{x^2-1}{x-1} = x+1")
        self.assertEqual(r["status"], "issue_found")
        self.assertEqual(r["steps"][0]["kind"], "domain")
        self.assertEqual(r["steps"][0]["severity"], "suggestion")
        self.assertEqual(r["steps"][0]["at"], {"x": "1"})
        # the author states the exclusion: no finding
        self.assertEqual(status(r"\frac{x^2-1}{x-1} = x+1", {"exclusions": {"x": [1]}}), "no_issue_found")
        self.assertEqual(status(r"\frac{x}{x} = 1"), "issue_found")
        self.assertEqual(status(r"\frac{x}{x} = 1", {"symbols": {"x": ["nonzero"]}}), "no_issue_found")

    def test_sampling_cannot_certify_so_unproved_identities_are_inconclusive(self):
        hard = mc.check(r"\sinh x = \frac{e^{x}-e^{-x}}{2}")  # e is a plain symbol, not Euler's number
        self.assertEqual(hard["status"], "issue_found")
        r = mc.check(r"\sin(3x) = 3\sin x - 4\sin^{3} x")
        self.assertIn(r["status"], ("no_issue_found", "inconclusive"))  # never issue_found for a true identity
        if r["status"] == "inconclusive": self.assertIn("cannot certify", r["reason"])

    def test_chains_report_the_failing_step(self):
        r = mc.check(r"x^2 - 1 = (x-1)(x+1) = x^2 + 1")
        self.assertEqual([s["status"] for s in r["steps"]], ["no_issue_found", "issue_found"])
        self.assertEqual(r["status"], "issue_found")

    def test_undeclared_symbols_are_suggestions_with_ranges(self):
        r = mc.check(r"x + y = y + x", {"symbols": {"x": ["real"]}})
        self.assertEqual(r["status"], "no_issue_found")
        self.assertEqual([s["symbol"] for s in r["suggestions"]], ["y"])
        self.assertEqual(r["suggestions"][0]["range"], [4, 5])
        self.assertEqual(r["assumptions"], {"x": ["real"], "y": []})


class BoundVariables(unittest.TestCase):
    def test_closed_form_sums_and_integrals_compare_with_the_bound_name_local(self):
        # expected values fixed by hand: sum_{i=1}^n i = n(n+1)/2, int_0^1 x dx = 1/2, int_0^t 2x dx = t^2
        for text in [r"\sum_{i=1}^{n} i = \frac{n(n+1)}{2}", r"\int_0^1 x \, dx = \frac{1}{2}", r"\int_{0}^{t} 2x \,dx = t^2",
                     r"\int_0^\infty \exp(-x) \, dx = 1", r"\sum_{k=0}^{3} 2^k = 15", r"\sum_{i=1}^{n} (2i - 1) = n^2"]:
            r = mc.check(text, {"symbols": {"t": ["real"], "n": ["integer", "nonnegative"]}})
            self.assertEqual(r["status"], "no_issue_found", text)
            self.assertTrue(r["bound"], text)
            self.assertFalse(set(r["bound"]) & set(r["assumptions"]), "a bound name is not a free symbol: " + text)

    def test_wrong_closed_forms_get_integer_counterexamples_for_summation_limits(self):
        r = mc.check(r"\sum_{i=1}^{n} i = n^2")
        self.assertEqual(r["status"], "issue_found")
        n = Fraction(r["steps"][0]["counterexample"]["at"]["n"]); self.assertEqual(n.denominator, 1, "n must be sampled at whole numbers")
        self.assertIn("summation_limit", [s["kind"] for s in r["suggestions"]])
        self.assertEqual(mc.check(r"\int_0^1 x \, dx = 1")["status"], "issue_found")

    def test_bound_and_free_use_and_unevaluated_or_divergent_forms(self):
        r = mc.check(r"\sum_{i=1}^{3} i + i = 6 + i")
        self.assertEqual(r["status"], "no_issue_found"); self.assertIn("bound_and_free", [s["kind"] for s in r["suggestions"]])
        self.assertEqual(mc.check(r"\int_1^\infty \frac{1}{x} \, dx = 1")["status"], "inconclusive")
        self.assertEqual(mc.check(r"\sum_{i=1}^{n} \frac{1}{i^{x}} = 1", {"symbols": {"x": ["positive"]}})["status"], "inconclusive")   # no closed form: nothing compared
        nested = mc.check(r"\sum_{i=1}^{2} \sum_{i=1}^{2} i = 6")
        self.assertEqual(nested["status"], "unsupported"); self.assertIn("already bound", nested["reason"])

    def test_batch_and_version_requests(self):
        self.assertEqual(mc.handle({"op": "version"})["status"], "ready")
        out = mc.handle({"op": "batch", "requests": [{"op": "check", "text": "x = x"}, {"op": "batch"}, 3]})
        self.assertEqual([r["status"] for r in out["results"]], ["no_issue_found", "unsupported", "unsupported"])


class Unsupported(unittest.TestCase):
    def test_unknown_malformed_and_ambiguous_notation_is_unsupported_not_an_error(self):
        cases = {
            r"\foo{x} = 1": r"Unsupported macro",
            r"\log x = \ln x": "ambiguous base",
            r"\left| x \right| = x": "absolute value",
            r"x^23 = x": "needs braces",
            r"\sin 2x = 2 \sin x": "Ambiguous argument",
            r"\sin^{-1} x = 1": "ambiguous",
            r"\sum_i i = 1": "needs its range",
            r"\sum_{i=1}^{n} = 1": "needs a term",
            r"\int_0^1 x = 1": "differential",
            r"x_{i+1} = x_i": "Indexed",
            r"\frac{1}{0} = 1": "zero",
            r"x = 1/0": "zero",
            r"\frac{1}{x = 1": "Expected",
            r"x^{9^{9^{9}}} = 1": "Exponent beyond",
            r"x < 1": "Only equalities",
            r"x": "No equation",
            "x = $": "Unsupported character",
        }
        for text, needle in cases.items():
            r = mc.check(text)
            self.assertEqual(r["status"], "unsupported", text)
            self.assertIn(needle, r["reason"], text)
            self.assertEqual(len(r["range"]), 2, text)

    def test_range_points_at_the_offending_token(self):
        text = r"x + \foo{y} = 1"
        r = mc.check(text, base=10)
        self.assertEqual(text[r["range"][0] - 10:r["range"][1] - 10], r"\foo")

    def test_bounded_input_and_no_code_execution(self):
        self.assertEqual(status("x = " + "x+" * 3000 + "1"), "unsupported")
        self.assertEqual(status("(" * 200 + "x" + ")" * 200 + " = x"), "unsupported")
        marker = os.path.join(os.environ.get("TMPDIR", "/tmp"), "mathcheck-marker")
        for hostile in [f"__import__('os').system('touch {marker}') = 1", r"\input{/etc/passwd} = 1", r"\write18{touch x} = 1", "x = x # evil"]:
            self.assertEqual(status(hostile), "unsupported", hostile)
        self.assertFalse(os.path.exists(marker))

    def test_expensive_expression_is_cut_off_inside_the_budget(self):
        started = time.time()
        old, mc.BUDGET_S = mc.BUDGET_S, 1.0
        try:
            with mc.budget(0.3):
                with self.assertRaises(mc.Timeout):
                    while True: pass
        finally: mc.BUDGET_S = old
        self.assertLess(time.time() - started, 2)
        hard = r"\sin(\cos(\tan(x))) + \cos(\sin(\tan(x))) = \tan(\sin(\cos(x))) + \sin(\sin(\sin(x)))"
        started = time.time()
        self.assertIn(status(hard), ("issue_found", "inconclusive"))
        self.assertLess(time.time() - started, 15)


ALL_POS = {"symbols": {n: ["positive"] for n in "abxyz"}}
TRUE = [r"(a+b)^2 = a^2 + 2ab + b^2", r"a^2 - b^2 = (a-b)(a+b)", r"\frac{1}{2} + \frac{1}{3} = \frac{5}{6}", r"\ln(ab) = \ln a + \ln b",
        r"\sqrt{x^2} = x", r"\sqrt{xy} = \sqrt{x}\sqrt{y}", r"\frac{a}{b} + \frac{x}{y} = \frac{ay + bx}{by}", r"(x^2)^3 = x^6", r"x^{a+b} = x^a x^b",
        r"\exp(a+b) = \exp(a)\exp(b)", r"\sin^2 x + \cos^2 x = 1", r"\cosh^2 x - \sinh^2 x = 1", r"\frac{x^3 - y^3}{x - y} = x^2 + xy + y^2",
        r"\frac{d}{1} = d", r"2\sin x \cos x = \sin(2x)", r"\frac{a}{b}\cdot\frac{b}{a} = 1", r"\tan x = \frac{\sin x}{\cos x}",
        r"x(y+z) = xy + xz", r"\frac{d}{dx} x^3 = 3x^2", r"\frac{d}{dx}(xy) = y", r"\frac{d}{dx}\ln x = \frac{1}{x}", r"\frac{d}{dx}(x^2 + x) = 2x + 1", r"\frac{x}{y} / \frac{a}{b} = \frac{xb}{ya}", r"\ln(x^2) = 2\ln x", r"\sqrt{x}^2 = x", r"-(-x) = x", r"\frac{x+y}{2} = \frac{y+x}{2}"]
FALSE = [r"(a+b)^2 = a^2 + b^2", r"\sqrt{a+b} = \sqrt{a} + \sqrt{b}", r"\frac{1}{a+b} = \frac{1}{a} + \frac{1}{b}", r"\ln(a+b) = \ln a + \ln b",
         r"\sin(a+b) = \sin a + \sin b", r"(xy)^2 = xy^2", r"\frac{a+b}{b} = a", r"x^{a}x^{b} = x^{ab}", r"\exp(a+b) = \exp a + \exp b",
         r"\frac{x^2+y^2}{x+y} = x + y", r"\sin^2 x = \sin x^2", r"2^{x}2^{x} = 4^{x} + 1", r"\frac{a}{b} = \frac{b}{a}", r"-(x-y) = -x - y", r"x^2 = 2x", r"\frac{d}{dx} x^3 = 3x", r"\frac{d}{dx}(xy) = x", r"\frac{d}{dx}\ln x = x", r"\frac{d}{dx}(x^2 + x) = 2x"]


class Corpus(unittest.TestCase):
    def test_true_identities_are_never_flagged_and_wrong_ones_always_are(self):
        started, slowest = time.time(), 0.0
        for text in TRUE:
            t0 = time.time(); r = mc.check(text, ALL_POS); slowest = max(slowest, time.time() - t0)
            self.assertNotEqual(r["status"], "issue_found", (text, r))
            self.assertNotEqual(r["status"], "unsupported", (text, r))
        for text in FALSE:
            t0 = time.time(); r = mc.check(text, ALL_POS); slowest = max(slowest, time.time() - t0)
            self.assertEqual(r["status"], "issue_found", text)
        print(f"\ncorpus {len(TRUE)} true / {len(FALSE)} false: {time.time() - started:.2f}s total, slowest {slowest:.2f}s", file=sys.stderr)


class DerivativeClaims(unittest.TestCase):
    def test_derivative_operator_is_evaluated_not_read_as_a_ratio(self):
        for text in [r"\frac{d}{dx} x^3 = 3x^2", r"\frac{d}{dx}\sin x = \cos x", r"\frac{d}{dx}(x\sin x) = \sin x + x\cos x", r"2\frac{d}{dx}x^2 = 4x",
                     r"\frac{d}{d\theta}\theta^2 = 2\theta", r"\frac{d}{dx}5 = 0", r"\frac{d}{dx}\left(\frac{1}{x}\right) = -\frac{1}{x^2}", r"\frac{d}{dx}\sqrt{x} = \frac{1}{2\sqrt{x}}"]:
            self.assertEqual(status(text), "no_issue_found", text)
        for text in [r"\frac{d}{dx} x^3 = 3x", r"\frac{d}{dx}\sin(x^2) = \cos(x^2)", r"\frac{d}{dx}(x\sin x) = x\cos x", r"\frac{d}{dx}e^{x} = e^{x}"]:
            self.assertEqual(status(text), "issue_found", text)   # e is a plain symbol here, so the last claim is also wrong as written

    def test_lookalikes_and_ambiguous_scope_are_unsupported(self):
        cases = {r"\frac{dy}{dx} = 3": "implicit function", r"\frac{d^2}{dx^2} x^3 = 6x": "Higher-order", r"\frac{d}{dx} x y = y": "scope",
                 r"\frac{d}{dx}x^2 \cdot x = 2x^2": "scope", r"\frac{d}{dx} = 1": "needs an expression", r"\int x dx = x": "indefinite", r"\sum_{i=1}^{0} i = 1": "reversed"}
        for text, needle in cases.items():
            r = mc.check(text); self.assertEqual(r["status"], "unsupported", text); self.assertIn(needle, r["reason"], text)
        self.assertEqual(mc.check(r"\frac{d}{dx} x = 1", {"symbols": {"d": ["real"]}})["status"], "unsupported")


class Notation(unittest.TestCase):
    DOC = "Let x be positive. Then x + y = z and x_1 + x = w."
    def run_doc(self, declarations, snippets, aliases=()): return mc.notation(declarations, [{"text": t, "base": b} for t, b in snippets], aliases)

    def test_each_finding_kind_has_a_suggestion_with_an_exact_document_range(self):
        doc = "x + y = 2; x_1 + x = 3; \\alpha + u = v"
        r = self.run_doc([{"symbol": "x", "assumptions": ["positive"], "range": [100, 110]}, {"symbol": "x", "assumptions": ["real"], "range": [200, 210]},
                          {"symbol": "u", "assumptions": ["real"], "range": [5, 6]}, {"symbol": "v", "assumptions": ["real", "positive"], "range": [7, 8]},
                          {"symbol": "k", "assumptions": ["positive", "negative"], "range": [300, 305]}],
                         [("x + y = 2", 0), ("x_1 + x = 3", 11), (r"\alpha + u = v", 24)], aliases=[["u", "v"]])
        self.assertEqual(r["status"], "issue_found"); kinds = {(f["kind"], f["symbol"]) for f in r["findings"]}
        self.assertEqual(kinds, {("use_before_declaration", "x"), ("conflicting_declaration", "x"), ("undeclared_symbol", "y"), ("undeclared_symbol", "x_1"), ("undeclared_symbol", "alpha"),
                                 ("plain_and_indexed", "x"), ("alias_both_used", "v"), ("alias_assumption_mismatch", "v"), ("contradictory_assumptions", "k")})
        self.assertTrue(all(f["severity"] == "suggestion" for f in r["findings"]))
        by = {(f["kind"], f["symbol"]): f for f in r["findings"]}
        self.assertEqual(doc[slice(*by[("undeclared_symbol", "y")]["range"])], "y")
        self.assertEqual(doc[slice(*by[("undeclared_symbol", "alpha")]["range"])], r"\alpha")
        self.assertEqual(doc[slice(*by[("plain_and_indexed", "x")]["range"])], "x_1")
        self.assertEqual(by[("conflicting_declaration", "x")]["range"], [200, 210]); self.assertIn("[100, 110]", by[("conflicting_declaration", "x")]["reason"])
        self.assertEqual(doc[slice(*by[("use_before_declaration", "x")]["range"])], "x")

    def test_consistent_documents_and_aliases_used_once_get_no_findings(self):
        r = self.run_doc([{"symbol": "x", "assumptions": ["real"], "range": [0, 5]}, {"symbol": r"\theta", "assumptions": [], "range": [6, 12]}, {"symbol": "u", "assumptions": ["real"], "range": [13, 14]},
                          {"symbol": "v", "assumptions": ["real"], "range": [15, 16]}], [(r"x + \theta = 1", 20), ("x = 2u", 40)], aliases=[["u", "v"]])
        self.assertEqual((r["status"], r["findings"], r["skipped"]), ("no_issue_found", [], []))
        self.assertEqual(self.run_doc([{"symbol": "x_{12}", "assumptions": [], "range": [0, 1]}], [("x_{12} = 1", 5)])["status"], "no_issue_found")

    def test_unsupported_snippets_are_reported_never_called_consistent(self):
        r = self.run_doc([{"symbol": "x", "assumptions": [], "range": [0, 1]}], [(r"\foo{x} = 1", 10), ("x = 1", 30)])
        self.assertEqual((r["status"], r["findings"]), ("inconclusive", [])); self.assertEqual(r["skipped"][0]["range"], [10, 14])
        bad = [({"symbol": "xy", "assumptions": [], "range": [0, 1]}, "plain letter"), ({"symbol": "x", "assumptions": ["magic"], "range": [0, 1]}, "Unknown assumption"), ({"symbol": "x", "range": [3, 1]}, "Malformed"), ({"nope": 1}, "Malformed")]
        for declaration, needle in bad:
            r = mc.notation([declaration], []); self.assertEqual(r["status"], "unsupported", declaration); self.assertIn(needle, r["reason"])
        self.assertEqual(mc.notation([], [{"text": "x", "base": -1}])["status"], "unsupported")
        self.assertEqual(mc.notation([], [], [["xy", "z"]])["status"], "unsupported")


def fmt(coeffs, op, bound): return (" + ".join(f"{c}{n}" for n, c in zip("xyz", coeffs) if c) or "0") + f" {op} {bound}"


class LinearConstraints(unittest.TestCase):
    def test_contradictions_report_the_contributing_constraints_only(self):
        r = mc.constraints([r"x + y \le 1", r"x - y \le 1", r"x \ge 2", "z > 0"])
        self.assertEqual((r["status"], r["which"]), ("issue_found", [0, 1, 2]))
        self.assertEqual(mc.constraints(["x + y > 0", "x + y < -1"])["which"], [0, 1])
        self.assertEqual(mc.constraints([r"x + y = 2", r"x - y = 0", "x > 1"])["which"], [0, 1, 2])
        self.assertEqual(mc.constraints(["1 < 0"])["which"], [0])
        self.assertEqual(mc.constraints(["x + y = 2", "x + y < 1"])["which"], [0, 1])       # needs the >= half of the equality
        self.assertEqual(mc.constraints(["x + y = 2", "x + y > 3"])["which"], [0, 1])       # needs the <= half

    def test_strictness_and_exact_rational_arithmetic(self):
        self.assertEqual(mc.constraints(["x > y", "y > x"])["status"], "issue_found")
        self.assertEqual(mc.constraints([r"x \ge y", r"y \ge x"])["status"], "no_issue_found")          # x = y
        self.assertEqual(mc.constraints([r"x > y", r"y \ge x"])["status"], "issue_found")
        self.assertEqual(mc.constraints([r"\frac{x}{3} + \frac{y}{3} > 1", r"x + y \le 3"])["status"], "issue_found")   # floats would round this away
        self.assertEqual(mc.constraints([r"\frac{x}{3} + \frac{y}{3} \ge 1", r"x + y \le 3"])["status"], "no_issue_found")
        self.assertEqual(mc.constraints([r"x + y \le 3", r"x - y \ge 1", "x > 0", "y > -5"])["status"], "no_issue_found")

    def test_nonlinear_neq_and_size_limits_are_stated(self):
        self.assertEqual(mc.constraints(["x*y > 1", "x < 0"])["status"], "inconclusive")
        r = mc.constraints([r"x + y \neq 3", r"x + y > 0"]); self.assertEqual(r["status"], "no_issue_found"); self.assertIn("neq", r["reason"])
        self.assertEqual(mc.constraints([r"x + y \neq 3", r"x + y > 3", r"x + y \le 3"])["status"], "issue_found")   # contradiction among the rest still stands
        old = mc.fm_contradiction
        rows = [({f"v{i}": 1, f"v{(i + 1) % 9}": -1, f"v{(i + 2) % 9}": 1}, 1, False, frozenset([i])) for i in range(9)] + [({f"v{i}": -1, f"v{(i + 3) % 9}": 1}, 0, False, frozenset([i + 9])) for i in range(9)]
        with self.assertRaises(OverflowError): old([(c, b, s, src) for c, b, s, src in rows], limit=5)

    def test_matches_an_independent_lp_solver_on_random_systems(self):
        import random
        from scipy.optimize import linprog
        rng = random.Random(5); checked = infeasible = 0
        for _ in range(150):
            rows = [([rng.randint(-3, 3) for _ in range(3)], rng.randint(-3, 3)) for _ in range(rng.randint(3, 8))]
            rows = [(c, b) for c, b in rows if any(c)] or [([1, 0, 0], 0)]
            texts = [fmt(c, r"\le", b) for c, b in rows]
            lp = linprog([0, 0, 0], A_ub=[c for c, _ in rows], b_ub=[b for _, b in rows], bounds=[(None, None)] * 3, method="highs")
            ours = mc.constraints(texts); checked += 1; infeasible += lp.status == 2
            self.assertEqual(ours["status"] == "issue_found", lp.status == 2, (texts, ours, lp.status))
            if ours["status"] == "issue_found":   # the reported subset alone is already contradictory
                self.assertEqual(mc.constraints([texts[i] for i in ours["which"]])["status"], "issue_found", texts)
        self.assertGreater(infeasible, 20); self.assertLess(infeasible, checked - 20)   # both outcomes were exercised


class Optimization(unittest.TestCase):
    def numeric_extrema(self, fn, a, b):
        import numpy as np
        grid = np.linspace(a, b, 400001); v = fn(grid); return float(v.min()), float(v.max())

    def test_unbounded_classification_claims_no_global_optimum(self):
        r = mc.optimize("x^3 - 3x")
        self.assertEqual([(p["x"], p["kind"], p["value"]) for p in r["critical_points"]], [("-1", "local_max", "2"), ("1", "local_min", "-2")])
        self.assertIn("not claimed", r["global"]); self.assertNotIn("extrema", r)
        flat = mc.optimize("x^4")["critical_points"][0]; self.assertEqual((flat["x"], flat["kind"]), ("0", "inconclusive")); self.assertIn("does not decide", flat["reason"])
        self.assertEqual(mc.optimize(r"-(x-2)^2 + 5")["critical_points"][0]["kind"], "local_max")

    def test_closed_interval_extrema_match_a_dense_numeric_scan(self):
        import numpy as np
        cases = [("x^3 - 3x", lambda t: t**3 - 3 * t, -2, 3), ("x^4 - 2x^2", lambda t: t**4 - 2 * t**2, -2, 2), (r"\sin x", np.sin, 0, 7), (r"\ln x", np.log, 1, 3),
                 (r"\sqrt{x}", np.sqrt, 0, 4), (r"\frac{1}{x}", lambda t: 1 / t, 1, 2), (r"x^2", lambda t: t**2, -1, 2), (r"\frac{x}{x^2+1}", lambda t: t / (t**2 + 1), -3, 3)]
        for text, fn, a, b in cases:
            r = mc.optimize(text, "x", [str(a), str(b)]); self.assertEqual(r["status"], "computed", (text, r))
            lo, hi = self.numeric_extrema(fn, a, b)
            self.assertAlmostEqual(mc_value(r["extrema"]["min"]["value"]), lo, places=6, msg=text)
            self.assertAlmostEqual(mc_value(r["extrema"]["max"]["value"]), hi, places=6, msg=text)
        r = mc.optimize("x^3 - 3x", "x", ["-2", "3"]); self.assertEqual((r["extrema"]["min"]["at"], r["extrema"]["max"]["at"]), (["-2", "1"], ["3"]))
        r = mc.optimize(r"\sqrt{x}", "x", ["0", "4"]); self.assertEqual(r["extrema"]["min"]["at"], ["0"])   # boundary and kink are one point

    def test_domain_discontinuity_branches_and_other_limits_are_visible(self):
        r = mc.optimize(r"\frac{1}{x}", "x", ["-1", "1"]); self.assertEqual(r["status"], "inconclusive"); self.assertIn("not continuous", r["reason"])
        self.assertEqual(mc.optimize(r"\ln x", "x", ["-1", "1"])["status"], "inconclusive")
        r = mc.optimize(r"\sqrt{x^2-1}"); self.assertEqual([p["kind"] for p in r["critical_points"]], ["derivative_does_not_exist"] * 2); self.assertIn("dropped", r["notes"][0])
        self.assertEqual(mc.optimize(r"x^{\frac{2}{3}}")["status"], "inconclusive")
        self.assertEqual(mc.optimize(r"\sin x")["status"], "inconclusive")                        # infinitely many critical points
        self.assertEqual(mc.optimize("5")["status"], "inconclusive"); self.assertEqual(mc.optimize("x + y")["status"], "inconclusive")
        for interval in (["2", "1"], ["1"], ["x", "3"], "1,2", ["1", r"\infty"]): self.assertEqual(mc.optimize("x^2", "x", interval)["status"], "unsupported", interval)
        self.assertEqual(mc.optimize(r"\foo x")["status"], "unsupported")


def mc_value(latex_text):
    """Evaluate an exact result string such as \\frac{\\sqrt{2}}{2} or \\log{(3)} through the engine's own parser."""
    return float(sp.N(mc.parse(latex_text.replace(r"\log", r"\ln").replace(r"\left(", "(").replace(r"\right)", ")").replace("{\\pi}", r"\pi"))[0][0][0], 20))


class Constraints(unittest.TestCase):
    def test_explicit_contradictions(self):
        r = mc.constraints(["x > 0", "x < -1"])
        self.assertEqual((r["status"], r["which"]), ("issue_found", [0, 1]))
        self.assertEqual(mc.constraints(["x > 0", "x < 5", r"x \neq 2"])["status"], "no_issue_found")
        self.assertEqual(mc.constraints(["x = 3", "x > 3"])["status"], "issue_found")
        self.assertEqual(mc.constraints(["x^2 < 0"])["status"], "issue_found")

    def test_multivariable_and_malformed_constraints_are_not_guessed(self):
        self.assertEqual(mc.constraints(["x*y > 1", "x < 0"])["status"], "inconclusive")   # nonlinear in several variables
        self.assertEqual(mc.constraints(["x > 0 > y"])["status"], "unsupported")
        self.assertEqual(mc.constraints([r"\foo > 0"])["status"], "unsupported")


class Computations(unittest.TestCase):
    def test_calculus_and_solving_with_independent_expectations(self):
        self.assertEqual(mc.compute("diff", "x^3")["result"], "3 x^{2}")
        self.assertEqual(mc.compute("integrate", "2x")["result"], "x^{2}")
        self.assertEqual(mc.compute("limit", r"\frac{\sin x}{x}", point="0")["result"], "1")
        self.assertEqual(mc.compute("limit", r"\frac{1}{x}", point=r"\infty")["result"], "0")
        self.assertEqual(mc.compute("solve", "x^2 = 4")["result"], r"\left\{-2, 2\right\}")
        self.assertEqual(mc.compute("solve", "x^2 - 5x + 6 = 0")["result"], r"\left\{2, 3\right\}")

    def test_unevaluated_unsupported_and_missing_variables_are_stated(self):
        self.assertEqual(mc.compute("integrate", r"\sin(x^{x})")["status"], "inconclusive")
        self.assertEqual(mc.compute("diff", "5")["status"], "inconclusive")
        self.assertEqual(mc.compute("solve", r"x = \foo")["status"], "unsupported")
        self.assertEqual(mc.compute("frobnicate", "x")["status"], "unsupported")


class CommandLine(unittest.TestCase):
    def run_cli(self, request, stdin=None):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "math-check", "mathcheck.py")
        done = subprocess.run([sys.executable, "-I", script], input=stdin if stdin is not None else json.dumps(request), capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_json_contract_and_garbage_input(self):
        r = self.run_cli({"op": "check", "text": r"\sqrt{x^2} = x", "context": POS, "base": 7})
        self.assertEqual(r["status"], "no_issue_found")
        self.assertEqual(self.run_cli({"op": "nope"})["status"], "unsupported")
        self.assertEqual(self.run_cli(None, stdin="not json")["status"], "unsupported")

    def test_missing_sympy_is_reported_not_crashed(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "math-check", "mathcheck.py")
        shim = f"import importlib.util as u; u.find_spec = lambda name, *a: None; import runpy; runpy.run_path({script!r}, run_name='__main__')"
        done = subprocess.run([sys.executable, "-I", "-c", shim], input="{}", capture_output=True, text=True, timeout=30)
        self.assertEqual((done.returncode, json.loads(done.stdout)["status"]), (0, "unavailable"))



class SeveralVariables(unittest.TestCase):
    """optimize_multi: Hessian classification, and box extrema checked against an independent brute-force grid."""
    def kinds(self, text, var="x, y"): return [(p["x"], p["kind"]) for p in mc.handle({"op": "optimize", "text": text, "var": var})["critical_points"]]

    def grid(self, fn, lo, hi, n, steps=41):
        import itertools, numpy as np
        axis = np.linspace(lo, hi, steps); vals = [fn(*p) for p in itertools.product(axis, repeat=n)]; return min(vals), max(vals)

    def test_hessian_classification(self):
        self.assertEqual(self.kinds("x^2 + y^2"), [(r"\left( 0, \  0\right)", "local_min")])
        self.assertEqual(self.kinds("x^2 - y^2")[0][1], "saddle")
        self.assertEqual(self.kinds("-(x^2) - 2y^2 + 2y")[0][1], "local_max")
        self.assertEqual(self.kinds("x^4 + y^4")[0][1], "inconclusive")
        self.assertEqual(sorted(k for _, k in self.kinds("x^3 - 3x + y^2")), ["local_min", "saddle"])
        r = mc.handle({"op": "optimize", "text": "x^2 + y^2"}| {"var": "x, y"}); self.assertIn("not claimed", r["global"]); self.assertNotIn("extrema", r)

    def test_box_extrema_match_a_brute_force_grid(self):
        cases = [("xy", lambda x, y: x * y, "x, y", -1, 1), ("(x-1)^2 + (y-1)^2", lambda x, y: (x - 1) ** 2 + (y - 1) ** 2, "x, y", 0, 2),
                 ("x^3 - 3x + y^2", lambda x, y: x ** 3 - 3 * x + y ** 2, "x, y", -2, 2),
                 ("x^2 + y^2 + z^2 - 2x", lambda x, y, z: x * x + y * y + z * z - 2 * x, "x, y, z", -1, 2)]
        for text, fn, var, lo, hi in cases:
            r = mc.handle({"op": "optimize", "text": text, "var": var, "interval": [str(lo), str(hi)]}); self.assertEqual(r["status"], "computed", (text, r))
            gmin, gmax = self.grid(fn, lo, hi, var.count(",") + 1)
            vmin, vmax = float(sp.sympify(r["extrema"]["min"]["value"])), float(sp.sympify(r["extrema"]["max"]["value"]))
            self.assertLessEqual(vmin, gmin + 1e-12, text); self.assertGreaterEqual(vmax, gmax - 1e-12, text)   # exact extrema bound every grid value
            self.assertAlmostEqual(vmin, gmin, delta=0.02, msg=text); self.assertAlmostEqual(vmax, gmax, delta=0.02, msg=text)
            for label in ("min", "max"):
                for at in r["extrema"][label]["at"]:
                    pt = [float(sp.sympify(v)) for v in at.replace("\\left(", "").replace("\\right)", "").replace("\\ ", "").split(",")]
                    self.assertAlmostEqual(fn(*pt), (vmin if label == "min" else vmax), places=12, msg=(text, at))
        r = mc.handle({"op": "optimize", "text": "xy", "var": "x, y", "interval": ["-1", "1"]})
        self.assertEqual(sorted(r["extrema"]["max"]["at"]), sorted([r"\left( -1, \  -1\right)", r"\left( 1, \  1\right)"]))

    def test_an_expression_reports_its_variables_for_the_compute_row(self):
        r = mc.check("x^2 + y^2 - 2y", {"symbols": {"x": ["positive"]}}); self.assertEqual(r["status"], "unsupported"); self.assertEqual(r["assumptions"], {"x": ["positive"], "y": []})

    def test_unsupported_and_inconclusive_states(self):
        h = lambda **kw: mc.handle({"op": "optimize", "var": "x, y", **kw})
        self.assertEqual(h(text=r"\sqrt{x} + y")["status"], "inconclusive")
        self.assertEqual(h(text="(x - y)^2")["status"], "inconclusive"); self.assertIn("not isolated", h(text="(x - y)^2")["reason"])
        self.assertEqual(h(text="x + a y")["status"], "inconclusive")
        self.assertEqual(h(text="x^2")["status"], "inconclusive")
        r = h(text=r"\frac{1}{x^2 + y^2 + 1}"); self.assertEqual(r["critical_points"][0]["kind"], "local_max")
        self.assertIn("polynomials only", h(text=r"\frac{1}{x^2 + y^2 + 1}", interval=["-1", "1"])["reason"])
        self.assertEqual(mc.handle({"op": "optimize", "text": "x + y", "var": "x, x"})["status"], "unsupported")
        self.assertEqual(mc.handle({"op": "optimize", "text": "x + y + z + w", "var": "x, y, z, w"})["status"], "unsupported")
        self.assertEqual(h(text="x y", interval=["1", "0"])["status"], "unsupported")


if __name__ == "__main__":
    unittest.main()
