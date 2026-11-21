# SPDX-License-Identifier: AGPL-3.0-only
"""Mathematical diagnostics for a declared LaTeX subset (MATH-CHECK-01). Not formal verification.

Runs in the user's own Python with their installed SymPy; nothing is bundled or installed. The input is parsed by
a small recursive-descent parser into SymPy constructors: no eval, sympify or parse_latex ever sees document text.
Every answer is one of: issue_found, no_issue_found (in the supported check only), inconclusive, unsupported.
CLI (for the native bridge):  python -I mathcheck.py < request.json > response.json
"""
import json, random, re, signal, sys
from contextlib import contextmanager
from importlib.util import find_spec

if __name__ == "__main__" and find_spec("sympy") is None:  # report what is missing; never install anything
    json.dump({"status": "unavailable", "reason": "SymPy is not installed in the selected Python environment"}, sys.stdout); sys.exit(0)
import sympy as sp

MAX_TEXT, MAX_OPS, MAX_DEPTH, MAX_EXP, SAMPLES, BUDGET_S = 4000, 300, 40, 1000, 60, 5.0
ASSUMPTIONS = {"real", "positive", "negative", "nonnegative", "nonpositive", "nonzero", "integer"}
GREEK = {m: m[1:] for m in r"\alpha \beta \gamma \delta \epsilon \zeta \eta \theta \kappa \lambda \mu \nu \xi \rho \sigma \tau \phi \chi \psi \omega \Gamma \Delta \Theta \Lambda \Xi \Sigma \Phi \Psi \Omega".split()}
FUNCS = {r"\sin": sp.sin, r"\cos": sp.cos, r"\tan": sp.tan, r"\cot": sp.cot, r"\ln": sp.log, r"\exp": sp.exp, r"\arcsin": sp.asin,
         r"\arccos": sp.acos, r"\arctan": sp.atan, r"\sinh": sp.sinh, r"\cosh": sp.cosh, r"\tanh": sp.tanh}
RELATIONS = {"=": "eq", "<": "lt", ">": "gt", r"\le": "le", r"\leq": "le", r"\ge": "ge", r"\geq": "ge", r"\neq": "ne", r"\ne": "ne"}
SPACING = {r"\,", r"\;", r"\:", r"\!", r"\ ", r"\quad", r"\qquad"}
FACTOR_MACROS = {r"\frac", r"\sqrt", r"\pi", r"\sum", r"\int", *GREEK, *FUNCS}
TOKEN = re.compile(r"\s+|(?P<num>\d+(?:\.\d+)?)|(?P<mac>\\(?:[A-Za-z]+|[,;:! ]))|(?P<ch>[A-Za-z+\-*/^_(){}=<>|\[\]])")


class Unsupported(Exception):
    def __init__(self, reason, start=0, end=0): super().__init__(reason); self.reason, self.span = reason, (start, end)
class Timeout(Exception): pass


@contextmanager
def budget(seconds=BUDGET_S):
    # shortcut: SIGALRM works on the main thread only; the native bridge also enforces a process timeout.
    def fire(*_): raise Timeout()
    try: old = signal.signal(signal.SIGALRM, fire); signal.setitimer(signal.ITIMER_REAL, seconds)
    except (ValueError, AttributeError): yield; return
    try: yield
    finally: signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, old)


def tokenize(text):
    if len(text) > MAX_TEXT: raise Unsupported("Expression is too long to check", 0, len(text))
    out, pos = [], 0
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m: raise Unsupported(f"Unsupported character {text[pos]!r}", pos, pos + 1)
        kind, value = m.lastgroup, m.group()
        if kind and value not in SPACING: out.append((kind, value, pos, m.end()))
        pos = m.end()
    # \left( and \right) are plain parentheses; any other \left/\right delimiter (such as |x|) is ambiguous.
    merged, i = [], 0
    while i < len(out):
        kind, value, s, e = out[i]
        if value in (r"\left", r"\right"):
            nxt = out[i + 1] if i + 1 < len(out) else None
            if not nxt or nxt[1] not in "()": raise Unsupported(f"Unsupported delimiter after {value} (absolute value and norms are not checked)", s, e)
            merged.append(("ch", nxt[1], s, nxt[3])); i += 2; continue
        merged.append(out[i]); i += 1
    return merged


class Parser:
    def __init__(self, text, context=None, allow_infinity=False):
        self.tokens, self.i, self.depth, self.text, self.allow_infinity = tokenize(text), 0, 0, text, allow_infinity
        context = context or {}
        self.decl, self.exclusions, self.used = context.get("symbols", {}), context.get("exclusions", {}), {}
        self.denoms, self.part_denoms = [], []   # denominators as written: SymPy cancels x/x, which would hide the exclusion
        self.scope, self.bound, self.sum_limits, self.stop_d = {}, {}, set(), 0   # bound variables of \sum and \int
        for name, flags in self.decl.items():
            bad = set(flags) - ASSUMPTIONS
            if bad: raise Unsupported(f"Unknown assumption {sorted(bad)} for {name}")

    # -- token helpers
    def peek(self, k=0): return self.tokens[self.i + k] if self.i + k < len(self.tokens) else None
    def at(self, value, k=0): t = self.peek(k); return t is not None and t[1] == value
    def take(self): t = self.tokens[self.i]; self.i += 1; return t
    def end_pos(self): return self.tokens[-1][3] if self.tokens else 0
    def expect(self, value):
        t = self.peek()
        if not t or t[1] != value: raise Unsupported(f"Expected {value}", *(t[2:4] if t else (self.end_pos(), self.end_pos())))
        return self.take()
    def nest(self):
        self.depth += 1
        if self.depth > MAX_DEPTH: raise Unsupported("Expression is nested too deeply", *self.peek()[2:4])
    def starts_factor(self, t):
        if self.stop_d and t is not None and t[1] == "d" and self.differential_at(self.i): return False   # the dx that closes an integrand
        return t is not None and (t[0] in ("num",) or t[1] == "(" or t[1] in FACTOR_MACROS or (t[0] == "ch" and t[1].isalpha()) or (self.allow_infinity and t[1] == r"\infty"))

    # -- grammar
    def chain(self):
        """expr (relation expr)*  ->  ([(sympy, start, end)], [relation names with spans])."""
        parts, rels = [], []
        while True:
            first, mark = self.peek(), len(self.denoms); expr = self.expr()
            parts.append((expr, first[2], self.tokens[self.i - 1][3])); self.part_denoms.append(self.denoms[mark:])
            t = self.peek()
            if t and t[1] in RELATIONS: rels.append((RELATIONS[t[1]], t[2], t[3])); self.take(); continue
            break
        if self.peek(): raise Unsupported(f"Unexpected {self.peek()[1]!r}", *self.peek()[2:4])
        return parts, rels

    def expr(self):
        self.nest(); value = self.term()
        while self.peek() and self.peek()[1] in "+-" and self.peek()[0] == "ch":
            op = self.take()[1]; rhs = self.term(); value = value + rhs if op == "+" else value - rhs
        self.depth -= 1; return value

    def term(self):
        value = self.unary()
        while True:
            t = self.peek()
            if t and t[1] in ("*", r"\cdot", r"\times"): self.take(); value = value * self.unary()
            elif t and t[1] == "/":
                self.take(); rhs = self.unary()
                if rhs == 0: raise Unsupported("Division by a literal zero", *t[2:4])
                self.denoms.append(rhs); value = value / rhs
            elif self.starts_factor(t): value = value * self.power()   # implicit multiplication
            else: return value

    def unary(self):
        t = self.peek()
        if t and t[1] in ("-", "+"): self.take(); inner = self.unary(); return -inner if t[1] == "-" else inner
        return self.power()

    def power(self):
        base = self.atom(); t = self.peek()
        if t and t[1] == "^":
            self.take(); exp = self.script(allow_negative=True)
            base = self.make_pow(base, exp, t)
            if self.at("^"): raise Unsupported("Double superscript is ambiguous; add braces", *self.peek()[2:4])
        return base

    def make_pow(self, base, exp, token):
        if exp.is_Number and abs(exp) > MAX_EXP: raise Unsupported(f"Exponent beyond {MAX_EXP} is not evaluated", *token[2:4])
        if sp.count_ops(base) + sp.count_ops(exp) > MAX_OPS: raise Unsupported("Expression is too large to check", *token[2:4])
        return base ** exp

    def script(self, allow_negative=False):
        """A LaTeX superscript: one token, or a braced group. Multi-digit numbers need braces (x^23 means x^2 3)."""
        t = self.peek()
        if not t: raise Unsupported("Missing exponent", self.end_pos(), self.end_pos())
        if t[1] == "{": self.take(); value = self.expr(); self.expect("}"); return value
        if t[0] == "num" and len(t[1]) > 1: raise Unsupported("Multi-digit exponent needs braces", *t[2:4])
        if t[0] == "num" or (t[0] == "ch" and t[1].isalpha()): return self.atom(subscripts=False)
        raise Unsupported("Exponent needs braces", *t[2:4])

    def group(self):
        self.expect("{"); value = self.expr(); self.expect("}"); return value

    def symbol(self, name, token):
        if name in self.scope: return self.scope[name]
        flags = self.decl.get(name)
        sym = sp.Symbol(name, **{f: True for f in (flags or ())})
        self.used.setdefault(name, (token[2], token[3], flags is not None)); return sym

    def atom(self, subscripts=True):
        t = self.peek()
        if not t: raise Unsupported("Expression ends unexpectedly", self.end_pos(), self.end_pos())
        kind, value, s, e = t
        if kind == "num": self.take(); return sp.Rational(value)
        if value == "(": self.take(); inner = self.expr(); self.expect(")"); return inner
        if value == "{": return self.group()
        if value == r"\pi": self.take(); return sp.pi
        if value == r"\infty" and self.allow_infinity: self.take(); return sp.oo
        if value == r"\frac":
            derivative = self.leibniz(s, e)
            if derivative is not None: return derivative
            self.take(); num = self.group(); den = self.group()
            if den == 0: raise Unsupported("Division by a literal zero", s, e)
            self.denoms.append(den); return num / den
        if value == r"\sqrt":
            self.take()
            if self.at("["): raise Unsupported("Root index form is not supported", s, e)
            return sp.sqrt(self.group())
        if value in FUNCS: return self.function(t)
        if value == r"\sum": return self.big_sum(t)
        if value == r"\int": return self.integral(t)
        if value in (r"\log",): raise Unsupported(r"\log has an ambiguous base; use \ln or state the base", s, e)
        if kind == "mac" and value not in GREEK: raise Unsupported(f"Unsupported macro {value}", s, e)
        if kind == "ch" and not value.isalpha() or kind not in ("ch", "mac"): raise Unsupported(f"Unexpected {value!r}", s, e)
        self.take(); name = GREEK.get(value, value)
        if subscripts and self.at("_"):
            self.take(); sub = self.peek()
            if sub and sub[1] == "{":
                self.take(); parts = []
                while self.peek() and self.peek()[1] != "}":
                    p = self.take()
                    if not re.fullmatch(r"[A-Za-z0-9]+", p[1]): raise Unsupported("Indexed expressions are not checked; use a plain subscript", s, p[3])
                    parts.append(p[1])
                self.expect("}"); name += "_" + "".join(parts)
            elif sub and re.fullmatch(r"[A-Za-z0-9]", sub[1]): self.take(); name += "_" + sub[1]
            else: raise Unsupported("Subscript needs braces", *(sub[2:4] if sub else (e, e)))
        return self.symbol(name, (kind, value, s, self.tokens[self.i - 1][3]))

    def leibniz(self, s, e):
        r"""\frac{d}{dx} operand is a derivative. Look-alikes (dy/dx, d^2/dx^2) are refused, never read as a ratio of products."""
        tk = self.tokens[self.i + 1:self.i + 9]; vals = [t[1] for t in tk]
        letter = lambda t: (t[0] == "ch" and t[1].isalpha()) or t[1] in GREEK
        higher = vals[:3] == ["{", "d", "^"]
        leibniz = len(tk) == 8 and vals[:2] == ["{", "d"] and vals[3:6] == ["}", "{", "d"] and vals[7] == "}" and letter(tk[2]) and letter(tk[6])
        operator = len(tk) >= 7 and vals[:5] == ["{", "d", "}", "{", "d"] and vals[6] == "}" and letter(tk[5])
        if not (higher or leibniz or operator): return None
        if "d" in self.decl: raise Unsupported("d is declared as a symbol, so d/dx is ambiguous", s, e)
        if higher or leibniz: raise Unsupported("Higher-order derivatives and dy/dx with an implicit function are not checked; write d/dx with an explicit expression", s, e)
        var = self.symbol(GREEK.get(tk[5][1], tk[5][1]), tk[5]); self.i += 8
        nxt = self.peek()
        if not self.starts_factor(nxt): raise Unsupported("d/dx needs an expression to differentiate", s, tk[6][3])
        operand = self.power(); after = self.peek()
        if after and (self.starts_factor(after) or after[1] in ("*", r"\cdot", r"\times", "/", "^")):
            raise Unsupported("The scope of d/dx is ambiguous; put the expression in parentheses", s, after[3])
        return sp.diff(operand, var)

    # -- bound variables: \sum_{i=a}^{b} term and \int_a^b expr \,dx. The bound name is local: it is not a free symbol,
    # gets no declared assumptions and is never sampled. The body is kept unevaluated so the interpretation shows it.
    def differential_at(self, k):
        nxt = self.peek(k - self.i + 1)
        return nxt is not None and ((nxt[0] == "ch" and nxt[1].isalpha()) or nxt[1] in GREEK)

    def bound_name(self, t, what):
        if not t or not ((t[0] == "ch" and t[1].isalpha()) or t[1] in GREEK): raise Unsupported(f"The {what} must be a single letter", *(t[2:4] if t else (self.end_pos(), self.end_pos())))
        return GREEK.get(t[1], t[1])

    def limit(self):
        if self.at(r"\infty"): self.take(); return sp.oo
        old, self.allow_infinity = self.allow_infinity, True
        try: return self.group() if self.at("{") else self.script()
        finally: self.allow_infinity = old

    def scoped(self, name, sym, parse_body, s, e):
        if name in self.scope: raise Unsupported(f"{name} is already bound by an enclosing sum or integral", s, e)
        mark = len(self.denoms); self.scope[name] = sym; self.bound.setdefault(name, (s, e))
        try: body = parse_body()
        finally: del self.scope[name]
        self.denoms[mark:] = [d for d in self.denoms[mark:] if sym not in d.free_symbols]   # an exclusion on the bound name is not a domain of the result
        return body

    def big_sum(self, token):
        _, _, s, e = token; self.take()
        if not self.at("_"): raise Unsupported(r"\sum needs its range written as _{i=a}^{b}", s, e)
        self.take()
        if not self.at("{"): raise Unsupported(r"\sum needs its range written as _{i=a}^{b}", s, e)
        self.take(); name = self.bound_name(self.take() if self.peek() else None, "summation index")
        self.expect("="); lo = self.expr(); self.expect("}")
        if not self.at("^"): raise Unsupported(r"\sum needs an upper limit ^{b}", s, e)
        self.take(); hi = self.limit()
        for bound in (lo, hi):
            if bound.is_number and not (bound.is_integer or bound in (sp.oo, -sp.oo)): raise Unsupported("Summation limits must be integers", s, e)
        if lo.is_number and hi.is_number and lo > hi: raise Unsupported("An empty or reversed summation range is not checked", s, e)
        self.sum_limits |= {x.name for x in (lo.free_symbols | hi.free_symbols)}
        i = sp.Symbol(name, integer=True)
        if not self.starts_factor(self.peek()): raise Unsupported(r"\sum needs a term to add up", s, e)
        body = self.scoped(name, i, self.term, s, e)   # the summand is the following product: \sum_i a_i + b adds b once
        return sp.Sum(body, (i, lo, hi))

    def integral(self, token):
        _, _, s, e = token; self.take()
        if not self.at("_"): raise Unsupported("An indefinite integral is only defined up to a constant; select the integrand and compute its integral instead", s, e)
        self.take(); lo = self.limit()
        if not self.at("^"): raise Unsupported(r"\int needs an upper limit ^{b}", s, e)
        self.take(); hi = self.limit()
        if "d" in self.decl: raise Unsupported("d is declared as a symbol, so the differential is ambiguous", s, e)
        depth, k = 0, self.i     # find the closing d<var> at this nesting level before parsing, so the integrand knows its bound name
        while k < len(self.tokens):
            v = self.tokens[k][1]
            if v in "{(": depth += 1
            elif v in "})": depth -= 1
            if depth < 0: break
            if depth == 0 and v == "d" and self.differential_at(k): break
            k += 1
        else: k = len(self.tokens)
        if k >= len(self.tokens) or self.tokens[k][1] != "d": raise Unsupported(r"\int needs its differential, such as \,dx", s, e)
        name = self.bound_name(self.tokens[k + 1], "integration variable"); x = sp.Symbol(name, real=True)
        def body():
            self.stop_d += 1
            try: value = self.expr()
            finally: self.stop_d -= 1
            self.expect("d"); self.take(); return value
        return sp.Integral(self.scoped(name, x, body, s, e), (x, lo, hi))

    def function(self, token):
        _, name, s, e = token; self.take(); power = None
        if self.at("^"):
            self.take(); power = self.script(allow_negative=True)
            if power == -1: raise Unsupported(f"{name}^{{-1}} is ambiguous (inverse or reciprocal)", s, self.tokens[self.i - 1][3])
        if self.at("("): self.take(); arg = self.expr(); self.expect(")")
        else:
            nxt = self.peek()
            if not nxt or not (nxt[0] in ("num", "ch") and (nxt[0] == "num" or nxt[1].isalpha() or nxt[1] == "{") or nxt[1] in GREEK or nxt[1] == r"\frac"):
                raise Unsupported(f"{name} needs an argument", s, e)
            arg = self.power()   # \sin x^2 is sin(x^2), the usual reading
            after = self.peek()
            if after and (after[0] == "num" or (after[0] == "ch" and (after[1].isalpha() or after[1] == "(")) or after[1] in GREEK):
                raise Unsupported(f"Ambiguous argument of {name}; add parentheses", s, after[3])
        value = FUNCS[name](arg)
        return value if power is None else self.make_pow(value, power, token)


def parse(text, context=None, allow_infinity=False):
    parser = Parser(text, context, allow_infinity); parts, rels = parser.chain()
    for expr, s, e in parts:
        if expr.has(sp.zoo, sp.nan): raise Unsupported("Expression is undefined", s, e)
        if sp.count_ops(expr) > MAX_OPS: raise Unsupported("Expression is too large to check", s, e)
    return parts, rels, parser


# ---------------------------------------------------------------- numeric sampling and domain
def sample_point(symbols, rng, decl, exclusions):
    point = {}
    for sym in symbols:
        flags, excluded = set(decl.get(sym.name, ())), {sp.Rational(v) for v in exclusions.get(sym.name, ())}
        for _ in range(20):
            if "integer" in flags:
                lo, hi = (1, 6) if flags & {"positive"} else (0, 6) if "nonnegative" in flags else (-6, -1) if "negative" in flags else (-6, 6)
                v = sp.Integer(rng.randint(lo, hi))
            else:
                mag = sp.Rational(rng.randint(1, 600), 100) if rng.random() < .8 else sp.Rational(rng.choice([1, 2, 3, 1, 5]), rng.choice([1, 2]))
                sign = 1 if flags & {"positive", "nonnegative"} else -1 if flags & {"negative", "nonpositive"} else rng.choice([-1, 1])
                v = sign * mag
            if v not in excluded and not ("nonzero" in flags and v == 0): break
        point[sym] = v
    return point


def value_at(expr, point, denoms=()):
    try:
        if any(d.subs(point) == 0 for d in denoms): return None
        v = sp.N(expr.subs(point), 30)
    except (ZeroDivisionError, TypeError, ValueError): return None
    return None if v.has(sp.zoo, sp.nan, sp.oo, -sp.oo) or not v.is_number else v


def describe(point): return {s.name: str(v) for s, v in point.items()}
def latex(e): return sp.latex(e)


def denominator_candidates(denoms, symbols, exclusions):
    """Real roots of the written denominators for a one-variable pair: where a cancelled factor hides an exclusion."""
    if len(symbols) != 1: return []
    x, found = symbols[0], []
    skip = {sp.Rational(v) for v in exclusions.get(x.name, ())}
    for den in denoms:
        try:
            for root in sp.solve(den, x):
                if root.is_real and root.is_number and root not in skip and root not in found: found.append(root)
        except (NotImplementedError, ValueError): pass
    return found[:5]


def closed_form(expr):
    """Evaluate sums/integrals; None when no closed form was found, False when divergent or undefined."""
    if not expr.has(sp.Sum, sp.Integral): return expr
    value = expr.doit()
    if value.has(sp.Sum, sp.Integral): return None
    return False if value.has(sp.oo, -sp.oo, sp.zoo, sp.nan) else value


def check_pair(lhs, rhs, parser, rng, dl, dr, decl=None):
    try:
        with budget(): lhs, rhs = closed_form(lhs), closed_form(rhs)
    except Timeout: return "inconclusive", "Evaluating the sum or integral took too long", {}
    except Exception: return "inconclusive", "The sum or integral could not be evaluated", {}
    if lhs is False or rhs is False: return "inconclusive", "A sum or integral diverges or is undefined; nothing was compared", {}
    if lhs is None or rhs is None: return "inconclusive", "No closed form was found for a sum or integral; nothing was compared", {}
    symbols = sorted(set().union(lhs.free_symbols, rhs.free_symbols, *(d.free_symbols for d in dl + dr)), key=lambda s: s.name)
    exclusions, decl = parser.exclusions, decl if decl is not None else parser.decl
    if len(symbols) > 6: return "inconclusive", "More than six variables: only symbolic comparison is attempted", {}
    domain_hit = None
    for _ in range(SAMPLES):
        point = sample_point(symbols, rng, decl, exclusions); a, b = value_at(lhs, point, dl), value_at(rhs, point, dr)
        if a is not None and b is not None:
            if abs(a - b) > sp.Float("1e-12") * (1 + abs(a) + abs(b)):
                return "issue_found", "The two sides differ at a point where both are defined", {"counterexample": {"at": describe(point), "left": str(sp.N(a, 8)), "right": str(sp.N(b, 8))}}
        elif (a is None) != (b is None) and domain_hit is None: domain_hit = point
    try:
        with budget(): zero = sp.simplify(lhs - rhs) == 0
    except Timeout: return "inconclusive", "The symbolic comparison took too long", {}
    except Exception: return "inconclusive", "The symbolic comparison failed", {}
    if not zero: return "inconclusive", f"No difference found at {SAMPLES} sampled points, but the identity was not proved symbolically; sampling cannot certify it", {}
    for root in denominator_candidates(dl + dr, symbols, exclusions):
        point = {symbols[0]: root}
        if (value_at(lhs, point, dl) is None) != (value_at(rhs, point, dr) is None): domain_hit = point; break
    if domain_hit:
        at = describe(domain_hit)
        return "issue_found", f"The sides are equal as expressions but not everywhere: one is undefined at {at}. State the exclusion (for example {next(iter(at))} \\neq {next(iter(at.values()))}) if intended", {"kind": "domain", "severity": "suggestion", "at": at}
    return "no_issue_found", "Equal under the stated assumptions in the supported check (not a proof of the surrounding argument)", {}


def check(text, context=None, base=0):
    """Compare the sides of `a = b = c` under the declared symbol assumptions."""
    context = context or {}
    try: parts, rels, parser = parse(text, context)
    except Unsupported as error: return {"status": "unsupported", "reason": error.reason, "range": [base + error.span[0], base + error.span[1]]}
    if not rels: return {"status": "unsupported", "reason": "No equation found: expected a = b", "range": [base, base + len(text)]}
    if any(kind != "eq" for kind, _, _ in rels):
        s, e = next((s, e) for kind, s, e in rels if kind != "eq")
        return {"status": "unsupported", "reason": "Only equalities are compared here; use constraints for inequalities", "range": [base + s, base + e]}
    rng, steps = random.Random(20261119), []
    # A free summation limit (the n in \sum_{i=1}^{n}) is only meaningful at integers: sample it there unless declared.
    loose = sorted(n for n in parser.sum_limits if "integer" not in parser.decl.get(n, ()))
    decl = {**parser.decl, **{n: ["integer", "nonnegative"] for n in loose}}
    for k, ((left, ls, _), (right, _, re_)) in enumerate(zip(parts, parts[1:])):
        status, reason, extra = check_pair(left, right, parser, rng, parser.part_denoms[k], parser.part_denoms[k + 1], decl)
        steps.append({"status": status, "reason": reason, "range": [base + ls, base + re_], "left": latex(left), "right": latex(right), **extra})
    order = ["issue_found", "inconclusive", "no_issue_found"]
    status = next((s for s in order if any(step["status"] == s for step in steps)), "inconclusive")
    first = next(step for step in steps if step["status"] == status)
    suggestions = [{"kind": "undeclared_symbol", "symbol": n, "range": [base + s, base + e],
                    "reason": f"{n} is not declared; it is treated as an unrestricted complex variable"}
                   for n, (s, e, declared) in parser.used.items() if not declared]
    suggestions += [{"kind": "summation_limit", "symbol": n, "range": [base + parser.used[n][0], base + parser.used[n][1]] if n in parser.used else first["range"],
                     "reason": f"{n} is a summation limit; it was sampled at whole numbers only. Declare it as an integer to make that explicit"} for n in loose]
    suggestions += [{"kind": "bound_and_free", "symbol": n, "range": [base + parser.used[n][0], base + parser.used[n][1]],
                     "reason": f"{n} is bound by a sum or integral and also used outside it; these are different quantities"} for n in parser.bound if n in parser.used]
    assumptions = {n: sorted(parser.decl.get(n, [])) for n in parser.used}
    bound = {n: [base + s, base + e] for n, (s, e) in parser.bound.items()}
    return {"status": status, "reason": first["reason"], "range": first["range"], "steps": steps, "assumptions": assumptions, "bound": bound, "suggestions": suggestions}


# ---------------------------------------------------------------- constraints and computations
def fm_contradiction(rows, limit=4000):
    """Fourier-Motzkin on exact rationals. Rows are (coeffs, bound, strict, sources) meaning sum(coeffs*x) <= bound (< if strict).
    Returns the original constraint indices behind the first impossible row (a contradicting subset, not necessarily minimal) or None."""
    while True:
        for coeffs, bound, strict, sources in rows:
            if not coeffs and (bound < 0 or (bound == 0 and strict)): return sources
        rows = [r for r in rows if r[0]]
        if not rows: return None
        pos_of = lambda v: [r for r in rows if r[0].get(v, 0) > 0]; neg_of = lambda v: [r for r in rows if r[0].get(v, 0) < 0]
        v = min({v for r in rows for v in r[0]}, key=lambda v: len(pos_of(v)) * len(neg_of(v)))
        new = [r for r in rows if v not in r[0]]
        for pc, pb, ps, psrc in pos_of(v):
            for nc, nb, ns, nsrc in neg_of(v):
                kp, kn = 1 / pc[v], 1 / -nc[v]
                coeffs = {n: c for n in (set(pc) | set(nc)) - {v} if (c := pc.get(n, 0) * kp + nc.get(n, 0) * kn)}
                new.append((coeffs, pb * kp + nb * kn, ps or ns, psrc | nsrc))
        best = {}                                  # keep the tightest of identical left sides
        for r in new:
            key = (frozenset(r[0].items()), r[2])
            if key not in best or r[1] < best[key][1]: best[key] = r
        rows = list(best.values())
        if len(rows) > limit: raise OverflowError


def linear_rows(items):
    """(index, left, right, relation) -> Fraction rows, or (None, index) for the first constraint that is not linear."""
    from fractions import Fraction
    rows, ignored = [], []
    for index, left, right, rel in items:
        if rel == "ne": ignored.append(index); continue
        expr = sp.expand(left - right); names = sorted(expr.free_symbols, key=lambda x: x.name)
        poly = expr.as_poly(*names) if names else None
        if names and (poly is None or poly.total_degree() > 1): return None, index
        coeffs = {x.name: poly.coeff_monomial(x) for x in names}; const = poly.coeff_monomial(1) if names else expr
        if not all(c.is_Rational for c in [*coeffs.values(), const]): return None, index
        fr = lambda r: Fraction(int(r.p), int(r.q)); coeffs = {n: fr(c) for n, c in coeffs.items()}; bound = -fr(const)
        sign = -1 if rel in ("ge", "gt") else 1; strict = rel in ("lt", "gt")
        rows.append(({n: sign * c for n, c in coeffs.items()}, sign * bound, strict, frozenset([index])))
        if rel == "eq": rows.append(({n: -c for n, c in coeffs.items()}, -bound, False, frozenset([index])))
    return rows, ignored


def constraints(texts, context=None):
    """Detect explicit contradictions among constraints. One variable per constraint: exact interval solving.
    Several variables: only when every constraint is linear (exact Fourier-Motzkin). Variables are treated as real."""
    items = []
    for index, text in enumerate(texts):
        try: parts, rels, parser = parse(text, {"symbols": {}})
        except Unsupported as error: return {"status": "unsupported", "reason": error.reason, "which": index}
        if len(rels) != 1: return {"status": "unsupported", "reason": "Each constraint must have exactly one relation", "which": index}
        items.append((index, parts[0][0], parts[1][0], rels[0][0]))
    if any(len((left.free_symbols | right.free_symbols)) != 1 for _, left, right, _ in items):
        rows, extra = linear_rows(items)
        if rows is None: return {"status": "inconclusive", "reason": "Constraints with several variables are checked only when they are linear", "which": extra}
        try: culprit = fm_contradiction(rows)
        except OverflowError: return {"status": "inconclusive", "reason": "The system is too large to eliminate exactly"}
        if culprit: return {"status": "issue_found", "reason": "No real values satisfy these linear constraints together (exact check)", "which": sorted(culprit)}
        return {"status": "no_issue_found", "reason": "No contradiction among the supported linear constraints" + (" (\\neq constraints were not included)" if extra else "")}
    groups = {}
    for index, left, right, rel in items:
        names = left.free_symbols | right.free_symbols; x = sp.Symbol(next(iter(names)).name, real=True); sub = {n: x for n in names}
        groups.setdefault(x, []).append((index, {"eq": sp.Eq, "lt": sp.Lt, "gt": sp.Gt, "le": sp.Le, "ge": sp.Ge, "ne": sp.Ne}[rel](left.subs(sub), right.subs(sub))))
    for x, group in groups.items():
        try:
            with budget(): solved = sp.reduce_inequalities([rel for _, rel in group], x)
        except Timeout: return {"status": "inconclusive", "reason": "The constraint check took too long"}
        except (NotImplementedError, TypeError, ValueError): return {"status": "inconclusive", "reason": f"Constraints on {x.name} are outside the supported solver"}
        if solved is sp.false or solved == False: # noqa: E712
            return {"status": "issue_found", "reason": f"No real value of {x.name} satisfies all of these constraints (variables treated as real)", "which": [i for i, _ in group]}
    return {"status": "no_issue_found", "reason": "No contradiction among the supported explicit constraints"}


# ---------------------------------------------------------------- notation consistency (suggestions only)
CONTRADICTORY = ({"positive", "negative"}, {"positive", "nonpositive"}, {"negative", "nonnegative"})


def symbol_name(raw):
    m = re.fullmatch(r"(\\[A-Za-z]+|[A-Za-z])(?:_\{?([A-Za-z0-9]+)\}?)?", str(raw).strip())
    if not m or (m.group(1).startswith("\\") and m.group(1) not in GREEK): return None
    return GREEK.get(m.group(1), m.group(1)) + (f"_{m.group(2)}" if m.group(2) else "")


def notation(declarations, snippets, aliases=()):
    """Cross-snippet notation findings. Every finding is a suggestion with a document range: it never says a symbol is wrong.
    declarations: [{symbol, assumptions, range}] ; snippets: [{text, base}] ; aliases: [[a, b]] explicitly declared as one quantity."""
    findings, skipped, decls, uses = [], [], {}, {}
    def add(kind, symbol, span, reason): findings.append({"kind": kind, "severity": "suggestion", "symbol": symbol, "range": list(span), "reason": reason})
    def span_of(raw):
        ok = isinstance(raw, (list, tuple)) and len(raw) == 2 and all(isinstance(v, int) and v >= 0 for v in raw) and raw[0] <= raw[1]
        if not ok: raise ValueError("range")
        return raw
    try:
        decl_list = sorted(((symbol_name(d["symbol"]), set(d.get("assumptions", [])), span_of(d["range"])) for d in list(declarations)[:200]), key=lambda d: (d[2][0], d[0] or ""))
        snippet_list = [(str(t["text"]), span_of([int(t.get("base", 0)), int(t.get("base", 0))])[0]) for t in list(snippets)[:200]]
        alias_list = [(symbol_name(a), symbol_name(b)) for a, b in list(aliases)[:50]]
    except (KeyError, TypeError, ValueError): return {"status": "unsupported", "reason": "Malformed notation request"}
    if any(n is None for n, _, _ in decl_list) or any(a is None or b is None for a, b in alias_list): return {"status": "unsupported", "reason": "A declared symbol or alias is not a plain letter, Greek letter or subscripted symbol"}
    for name, flags, span in decl_list:
        if flags - ASSUMPTIONS: return {"status": "unsupported", "reason": f"Unknown assumption {sorted(flags - ASSUMPTIONS)} for {name}"}
        if any(pair <= flags for pair in CONTRADICTORY): add("contradictory_assumptions", name, span, f"{name} is declared with assumptions that cannot all hold: {sorted(flags)}")
        if name in decls and decls[name][0] != flags: add("conflicting_declaration", name, span, f"{name} was declared {sorted(decls[name][0])} at {decls[name][1]} and is now declared {sorted(flags)}")
        decls.setdefault(name, (flags, span))
    for text, base in snippet_list:
        try: _, _, parser = parse(text, {"symbols": {}})
        except Unsupported as error: skipped.append({"range": [base + error.span[0], base + error.span[1]], "reason": error.reason}); continue
        for name, (a, b, _) in parser.used.items(): uses.setdefault(name, []).append((base + a, base + b))
    first = {name: min(places) for name, places in uses.items()}
    for name, span in sorted(first.items(), key=lambda kv: kv[1]):
        if name not in decls: add("undeclared_symbol", name, span, f"{name} is not declared; it is treated as an unrestricted complex variable")
        elif span[0] < decls[name][1][0]: add("use_before_declaration", name, span, f"{name} is used here before its declaration at {decls[name][1]}")
    for base in sorted({n.split("_")[0] for n in uses}):
        plain, indexed = first.get(base), sorted((p, n) for n, p in first.items() if n != base and n.split("_")[0] == base)
        if plain and indexed:
            later = max([plain, indexed[0][0]]); other = indexed[0][1] if later == plain else base
            add("plain_and_indexed", base, later, f"{base} is used both on its own and with an index ({indexed[0][1]}); {other} appears earlier")
    for a, b in alias_list:
        if a in first and b in first: add("alias_both_used", b, max(first[a], first[b]), f"{a} and {b} are declared aliases of one quantity but both appear in the document")
        if a in decls and b in decls and decls[a][0] != decls[b][0]: add("alias_assumption_mismatch", b, decls[b][1], f"{a} and {b} are aliases but are declared with different assumptions")
    findings.sort(key=lambda f: (f["range"][0], f["kind"]))
    status = "issue_found" if findings else "inconclusive" if skipped else "no_issue_found"
    return {"status": status, "reason": f"{len(findings)} notation suggestion(s)" + (f"; {len(skipped)} snippet(s) not checked" if skipped else ""), "findings": findings, "skipped": skipped}


# ---------------------------------------------------------------- single-variable optimization
def optimize(text, var="x", interval=None):
    """Critical points, second-derivative classification and, on a given closed interval where f is continuous, exact extrema.
    The variable is real. Global optimality is claimed only on such an interval; otherwise the result says it is not claimed."""
    from sympy.calculus.util import continuous_domain
    try:
        parts, rels, parser = parse(text, {"symbols": {var: ["real"]}})
        if len(parts) != 1: return {"status": "unsupported", "reason": "Expected a single expression"}
        x = sp.Symbol(var, real=True); f = parts[0][0]
        if f.has(sp.Sum, sp.Integral): return {"status": "unsupported", "reason": "Optimization of sums and integrals is not supported"}
        if f.free_symbols != {x}: return {"status": "inconclusive", "reason": f"Only functions of {var} alone are optimized; other symbols: {sorted(n.name for n in f.free_symbols - {x})}" if f.free_symbols - {x} else f"{var} does not appear in the expression"}
        if any(p.exp.is_Rational and not p.exp.is_Integer and p.exp.q != 2 for p in f.atoms(sp.Pow)): return {"status": "inconclusive", "reason": "Fractional powers other than square roots are branch-sensitive for negative values; no real-root convention is assumed"}
        region, bounds = sp.S.Reals, None
        if interval is not None:
            if not isinstance(interval, (list, tuple)) or len(interval) != 2: return {"status": "unsupported", "reason": "The interval needs two endpoints"}
            ends = [parse(str(raw), {"symbols": {}})[0][0][0] for raw in interval]
            if any(v.free_symbols or not v.is_real for v in ends) or not sp.N(ends[0]) < sp.N(ends[1]): return {"status": "unsupported", "reason": "The interval needs two real numeric endpoints with a < b"}
            bounds = sp.Interval(*ends); region = bounds
        with budget():
            domain = continuous_domain(f, x, sp.S.Reals); fp = sp.diff(f, x); fpp = sp.diff(fp, x)
            if fp == 0: return {"status": "inconclusive", "reason": "The function is constant: every point is critical"}
            roots = sp.solveset(fp, x, region)
            if not isinstance(roots, sp.FiniteSet) and roots is not sp.S.EmptySet: return {"status": "inconclusive", "reason": "The critical points are not a finite set that could be solved exactly"}
            kinks = sp.Intersection(sp.Complement(domain, continuous_domain(fp, x, sp.S.Reals)), region)
            if not isinstance(kinks, sp.FiniteSet) and kinks is not sp.S.EmptySet: return {"status": "inconclusive", "reason": "Points where the derivative fails to exist could not be listed exactly"}
            points, notes = [], []
            for c in roots:
                if domain.contains(c) is not sp.true: notes.append(f"critical point {latex(c)} is outside the domain of the function and was dropped"); continue
                second = sp.simplify(fpp.subs(x, c)); kind = "inconclusive"
                n = None if second.is_zero or second.has(sp.zoo, sp.nan) else sp.N(second, 30)
                if second.is_positive or (n is not None and second.is_positive is None and n > 1e-15): kind = "local_min"
                elif second.is_negative or (n is not None and second.is_negative is None and n < -1e-15): kind = "local_max"
                points.append({"x": latex(c), "value": latex(sp.simplify(f.subs(x, c))), "kind": kind, "second_derivative": latex(second),
                               **({"reason": "second derivative is zero or undefined: the test does not decide"} if kind == "inconclusive" else {})})
            for c in kinks: points.append({"x": latex(c), "value": latex(sp.simplify(f.subs(x, c))), "kind": "derivative_does_not_exist", "reason": "candidate extremum; the derivative test does not apply"})
            result = {"status": "computed", "function": latex(f), "assumptions": {var: ["real"]}, "domain": latex(domain), "critical_points": points, "notes": notes}
            if bounds is None: result["global"] = "not claimed: no interval was given"; return result
            if not bounds.is_subset(domain): return {**result, "status": "inconclusive", "reason": f"f is not continuous on all of {latex(bounds)}; the extreme value theorem does not apply", "global": "not claimed"}
            cands = list(dict.fromkeys([*bounds.boundary, *roots, *kinks])); values = [(c, sp.simplify(f.subs(x, c))) for c in cands]
            if any(not v.is_number or v.has(sp.zoo, sp.nan) for _, v in values): return {**result, "status": "inconclusive", "reason": "A candidate value is undefined", "global": "not claimed"}
            ordered = sorted(values, key=lambda cv: sp.N(cv[1], 30)); out = {}
            for label, target in (("min", ordered[0][1]), ("max", ordered[-1][1])):
                tied = [c for c, v in values if sp.simplify(v - target) == 0]
                if any(sp.simplify(v - target) != 0 and abs(sp.N(v - target, 30)) < 1e-12 for _, v in values): return {**result, "status": "inconclusive", "reason": "Two candidate values are too close to separate exactly", "global": "not claimed"}
                out[label] = {"value": latex(target), "at": [latex(c) for c in tied]}
            return {**result, "interval": latex(bounds), "extrema": out, "global": f"minimum and maximum on {latex(bounds)} (closed interval, f continuous there)"}
    except Unsupported as error: return {"status": "unsupported", "reason": error.reason, "range": list(error.span)}
    except Timeout: return {"status": "inconclusive", "reason": "The optimization took too long"}
    except (NotImplementedError, ValueError, TypeError): return {"status": "inconclusive", "reason": "This optimization is outside the supported cases"}


def compute(op, text, var="x", context=None, point=None, direction="+"):
    """Derivative, antiderivative, limit or real solutions of one expression; unevaluated results are inconclusive."""
    try:
        parts, rels, parser = parse(text, context)
        x = sp.Symbol(var, **{f: True for f in (parser.decl.get(var) or ())})
        if len(parts) != 1 and op != "solve" or len(parts) > 2: return {"status": "unsupported", "reason": "Expected a single expression" if op != "solve" else "Expected an expression or an equation"}
        expr = parts[0][0] if len(parts) == 1 else parts[0][0] - parts[1][0]
        if var not in {s.name for s in expr.free_symbols} and op != "solve": return {"status": "inconclusive", "reason": f"{var} does not appear in the expression"}
        with budget():
            expr = closed_form(expr)
            if expr is None or expr is False: return {"status": "inconclusive", "reason": "A sum or integral has no closed form or diverges"}
            if op == "diff": out = sp.diff(expr, x)
            elif op == "integrate": out = sp.integrate(expr, x)
            elif op == "limit":
                out = sp.limit(expr, x, parse(point, context, allow_infinity=True)[0][0][0], dir=direction)
            elif op == "solve": out = sp.FiniteSet(*sp.solve(expr, x))
            else: return {"status": "unsupported", "reason": f"Unknown computation {op}"}
        if out.has(sp.Integral, sp.Limit, sp.Derivative) or (op == "solve" and not isinstance(out, sp.FiniteSet)):
            return {"status": "inconclusive", "reason": "No closed form was found"}
        return {"status": "computed", "result": latex(out), "assumptions": {n: sorted(parser.decl.get(n, [])) for n in parser.used}}
    except Unsupported as error: return {"status": "unsupported", "reason": error.reason, "range": list(error.span)}
    except Timeout: return {"status": "inconclusive", "reason": "The computation took too long"}
    except (NotImplementedError, ValueError, TypeError): return {"status": "inconclusive", "reason": "This computation is outside the supported cases"}


def handle(request):
    op = request.get("op")
    if op == "version": return {"status": "ready", "sympy": sp.__version__}   # readiness probe: imports SymPy, parses nothing
    if op == "batch": return {"status": "batch", "results": [handle(r) if isinstance(r, dict) and r.get("op") != "batch" else {"status": "unsupported", "reason": "Malformed request"} for r in list(request.get("requests", []))[:5]]}
    if op == "check": return check(str(request.get("text", "")), request.get("context"), int(request.get("base", 0)))
    if op == "constraints": return constraints([str(t) for t in request.get("texts", [])][:50], request.get("context"))
    if op == "compute": return compute(str(request.get("name", "")), str(request.get("text", "")), str(request.get("var", "x")), request.get("context"), request.get("point"), request.get("direction", "+"))
    if op == "notation": return notation(request.get("declarations", []), request.get("snippets", []), request.get("aliases", []))
    if op == "optimize": return optimize(str(request.get("text", "")), str(request.get("var", "x")), request.get("interval"))
    return {"status": "unsupported", "reason": "Unknown operation"}


if __name__ == "__main__":
    try: request = json.loads(sys.stdin.read(1_000_000))
    except ValueError: request = {}
    json.dump(handle(request), sys.stdout)
