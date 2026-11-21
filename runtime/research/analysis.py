# SPDX-License-Identifier: AGPL-3.0-only
"""Optional Python data-analysis adapter (ANALYSIS-01). Uses the user's installed numpy/pandas/statsmodels; installs nothing.
CLI: python -B -I analysis.py < request.json > result.json. Models are named columns, never formula strings
(patsy formulas evaluate Python). Result fields match analysis.R so one pipeline renders both languages.
Requests: {"op":"describe"|"ols"|"figure"|"optimize", "data":{col:[...]} | "csv":path, "columns":[...] | "y":col,"x":[col,...], "robust":bool,
"figure" takes one regressor "x":[col]; "optimize" takes "objective":"lad"|"bounded_ls" and, for bounded_ls, "bounds":{term:[lo|null,hi|null]}}
"""
import base64, io, json, math, sys
from importlib.util import find_spec

MAX_ROWS, MAX_COLS, MAX_X, MAX_PLOT_POINTS, MAX_LAD_ROWS, MAX_PNG = 200_000, 200, 30, 20_000, 2000, 2 * 1024 * 1024


def out(value): json.dump(value, sys.stdout, allow_nan=False); sys.exit(0)
def fail(status, reason): out({"status": status, "reason": reason})
def num(v): return None if v is None or not math.isfinite(v) else float(v)


def load(request):
    import pandas as pd
    if "csv" in request: frame = pd.read_csv(request["csv"], nrows=MAX_ROWS + 1)   # the path is an explicit user selection made by the bridge
    elif isinstance(request.get("data"), dict): frame = pd.DataFrame(request["data"])
    else: fail("unsupported", "Provide data or csv")
    if len(frame) > MAX_ROWS or frame.shape[1] > MAX_COLS: fail("unsupported", f"Data exceeds {MAX_ROWS} rows or {MAX_COLS} columns")
    return frame


def need(frame, names):
    missing = [n for n in names if n not in frame.columns]
    if missing: fail("unsupported", f"Unknown column {missing[0]!r}")
    bad = [n for n in names if not str(frame[n].dtype).startswith(("int", "float"))]
    if bad: fail("unsupported", f"Column {bad[0]!r} is not numeric")


def describe(frame, columns):
    need(frame, columns)
    rows = []
    for name in columns:
        col = frame[name].dropna()
        rows.append({"column": name, "n": int(col.size), "missing": int(frame[name].isna().sum()), "mean": num(col.mean()) if col.size else None,
                     "sd": num(col.std(ddof=1)) if col.size > 1 else None, "min": num(col.min()) if col.size else None, "max": num(col.max()) if col.size else None})
    return {"status": "computed", "method": "Summary statistics (pandas), sample sd with n-1", "rows": rows}


def complete(frame, y, xs):
    """Validated listwise-complete rows plus the design matrix with intercept; refuses too few rows and collinearity."""
    import numpy as np, statsmodels.api as sm
    if not xs or len(xs) > MAX_X or y in xs or len(set(xs)) != len(xs): fail("unsupported", "Choose one outcome and 1 to 30 distinct regressors")
    need(frame, [y, *xs])
    data = frame[[y, *xs]]; used = data.dropna(); dropped = len(data) - len(used)
    if len(used) <= len(xs) + 1: fail("inconclusive", "Too few complete rows for this model")
    exog = sm.add_constant(used[xs].to_numpy(float), has_constant="add")
    if np.linalg.matrix_rank(exog) < exog.shape[1]: fail("inconclusive", "Regressors are perfectly collinear")
    return used, dropped, exog


def ols(frame, y, xs, robust):
    import numpy as np, statsmodels, statsmodels.api as sm
    used, dropped, exog = complete(frame, y, xs)
    fit = sm.OLS(used[y].to_numpy(float), exog).fit(cov_type="HC1" if robust else "nonrobust")
    ci = fit.conf_int(alpha=0.05)
    return {"status": "computed", "method": "OLS (statsmodels), " + ("HC1 robust standard errors" if robust else "classical standard errors"),
            "nobs": int(fit.nobs), "dropped_rows": int(dropped), "missing_policy": "listwise deletion", "df_resid": int(fit.df_resid),
            "r_squared": num(fit.rsquared), "terms": ["(Intercept)", *xs], "estimate": [num(v) for v in fit.params], "std_error": [num(v) for v in fit.bse],
            "t": [num(v) for v in fit.tvalues], "p": [num(v) for v in fit.pvalues], "ci_low": [num(v) for v in ci[:, 0]], "ci_high": [num(v) for v in ci[:, 1]],
            "versions": {"statsmodels": statsmodels.__version__, "numpy": np.__version__}}


def label(name):
    return name if len(name) <= 40 else name[:39] + "…"


def figure(frame, y, xs):
    """Scatter with the OLS line and a residual plot as PNG. Uses Figure directly (no pyplot, so no global figure state) and writes no files."""
    import numpy as np
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
    if len(xs) != 1: fail("unsupported", "A figure needs exactly one regressor")
    used, dropped, _ = complete(frame, y, xs)
    if len(used) > MAX_PLOT_POINTS: fail("unsupported", f"Too many points to plot (more than {MAX_PLOT_POINTS})")
    x, yv = used[xs[0]].to_numpy(float), used[y].to_numpy(float)
    if np.ptp(x) == 0: fail("inconclusive", "The regressor does not vary")
    slope, intercept = np.polyfit(x, yv, 1); fitted = intercept + slope * x
    fig = Figure(figsize=(8, 3.6), dpi=100); FigureCanvasAgg(fig); left, right = fig.subplots(1, 2)
    left.scatter(x, yv, s=12); grid = np.array([x.min(), x.max()]); left.plot(grid, intercept + slope * grid, color="tab:red")
    left.set_xlabel(label(xs[0]), parse_math=False); left.set_ylabel(label(y), parse_math=False); left.set_title("Data and OLS fit", parse_math=False)
    right.scatter(fitted, yv - fitted, s=12); right.axhline(0, color="gray", linewidth=0.8)
    right.set_xlabel("Fitted values"); right.set_ylabel("Residuals"); right.set_title("Residuals", parse_math=False)
    fig.tight_layout(); buf = io.BytesIO(); fig.savefig(buf, format="png"); png = buf.getvalue()
    if len(png) > MAX_PNG: fail("unsupported", "The figure is too large")
    return {"status": "computed", "method": "Scatter with OLS line and residual plot (matplotlib, Agg)", "mime": "image/png", "png_base64": base64.b64encode(png).decode(),
            "width": int.from_bytes(png[16:20], "big"), "height": int.from_bytes(png[20:24], "big"), "nobs": len(used), "dropped_rows": int(dropped), "missing_policy": "listwise deletion",
            "terms": ["(Intercept)", xs[0]], "estimate": [num(intercept), num(slope)], "versions": {"matplotlib": __import__("matplotlib").__version__}}


def bound(value, name):
    if value is None: return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value): fail("unsupported", f"Bound for {name!r} must be a finite number or null")
    return float(value)


def optimize(frame, y, xs, objective, bounds):
    """Named objectives only (never an expression string): least absolute deviations (linear program) or bounded least squares."""
    import numpy as np, scipy
    from scipy import optimize as so
    used, dropped, X = complete(frame, y, xs); yv = used[y].to_numpy(float); n, k = X.shape; terms = ["(Intercept)", *xs]
    base = {"status": "computed", "nobs": int(n), "dropped_rows": int(dropped), "missing_policy": "listwise deletion", "terms": terms, "versions": {"scipy": scipy.__version__}}
    if objective == "lad":
        if bounds: fail("unsupported", "Bounds are only available for bounded_ls")
        if n > MAX_LAD_ROWS: fail("unsupported", f"Least absolute deviations is limited to {MAX_LAD_ROWS} rows")   # shortcut: dense LP, upgrade to a sparse LP for more rows
        # min sum(t) subject to -t <= y - Xb <= t, b free, t >= 0
        A = np.block([[-X, -np.eye(n)], [X, -np.eye(n)]]); res = so.linprog(np.r_[np.zeros(k), np.ones(n)], A_ub=A, b_ub=np.r_[-yv, yv], bounds=[(None, None)] * k + [(0, None)] * n, method="highs")
        if res.status != 0: fail("inconclusive", f"The solver did not converge: {res.message}")
        return {**base, "method": "Least absolute deviations (scipy linprog, HiGHS)", "objective_name": "sum of absolute deviations", "objective": num(res.fun), "estimate": [num(v) for v in res.x[:k]],
                "converged": True, "solver_status": int(res.status), "iterations": int(res.nit), "note": "The minimiser may not be unique when several lines tie."}
    if objective == "bounded_ls":
        spec = bounds if isinstance(bounds, dict) else {}
        unknown = [t for t in spec if t not in terms]
        if unknown: fail("unsupported", f"Bound for unknown term {unknown[0]!r}")
        lo, hi = np.full(k, -np.inf), np.full(k, np.inf)
        for t, pair in spec.items():
            if not isinstance(pair, list) or len(pair) != 2: fail("unsupported", f"Bounds for {t!r} must be [lower, upper]")
            a, b = bound(pair[0], t), bound(pair[1], t); i = terms.index(t)
            if a is not None and b is not None and a > b: fail("unsupported", f"Lower bound exceeds upper bound for {t!r}")
            lo[i], hi[i] = -np.inf if a is None else a, np.inf if b is None else b
        res = so.lsq_linear(X, yv, bounds=(lo, hi), method="bvls", max_iter=1000)
        if not res.success: fail("inconclusive", f"The solver did not converge: {res.message}")
        return {**base, "method": "Bounded least squares (scipy lsq_linear, BVLS)", "objective_name": "residual sum of squares", "objective": num(2 * res.cost), "estimate": [num(v) for v in res.x],
                "converged": True, "solver_status": int(res.status), "iterations": int(res.nit), "active_bounds": [terms[i] for i in range(k) if res.active_mask[i] != 0]}
    fail("unsupported", "Unknown objective; choose lad or bounded_ls")


def handle(request):
    missing = [m for m in ("numpy", "pandas", "statsmodels") if find_spec(m) is None]
    if missing: return {"status": "unavailable", "reason": f"{', '.join(missing)} not installed in the selected Python environment"}
    op = request.get("op")
    extra = {"figure": ("matplotlib",), "optimize": ("scipy",)}.get(op, ())
    absent = [m for m in extra if find_spec(m) is None]
    if absent: return {"status": "unavailable", "reason": f"{', '.join(absent)} not installed in the selected Python environment"}
    try:
        if op == "describe": return describe(load(request), [str(c) for c in request.get("columns", [])][:MAX_COLS])
        if op == "figure": return figure(load(request), str(request.get("y", "")), [str(c) for c in request.get("x", [])])
        if op == "optimize": return optimize(load(request), str(request.get("y", "")), [str(c) for c in request.get("x", [])], str(request.get("objective", "")), request.get("bounds"))
        if op == "ols": return ols(load(request), str(request.get("y", "")), [str(c) for c in request.get("x", [])], bool(request.get("robust")))
    except SystemExit: raise
    except (OSError, ValueError, KeyError, TypeError) as error: return {"status": "unsupported", "reason": f"Could not use this data: {type(error).__name__}"}
    return {"status": "unsupported", "reason": "Unknown operation"}


if __name__ == "__main__":
    try: request = json.loads(sys.stdin.read(50_000_000))
    except ValueError: request = {}
    out(handle(request if isinstance(request, dict) else {}))
