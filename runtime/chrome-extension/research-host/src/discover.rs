// SPDX-License-Identifier: AGPL-3.0-only
//! Runtime discovery, readiness and device-local selection for optional Python/R/Jupyter research tools
//! (RESEARCH-RUNTIME-01). Standard library only; nothing is installed, downloaded or imported.
//!
//! Does: finds candidate Python interpreters and R installations at fixed, listed locations (conda roots,
//! pyenv, Homebrew, /usr/local, /Library/Frameworks) and runs at most one bounded `--version` probe per
//! candidate (absolute path, cleared environment, no shell, 3 s limit). Reads Jupyter kernelspecs as data
//! (kernel.json is parsed, never executed) and accepts only two exact launch shapes: the ipykernel Python
//! launcher and IRkernel. Judges readiness from package directories and dist-info/DESCRIPTION files on disk,
//! with a plain "X is not installed in the selected … environment" reason. Stores a per-user, per-device selection
//! (interpreter, R, kernel, four feature toggles that default OFF, per-project consent) in one atomic 0600
//! file, and re-verifies the recorded identity (canonical path, size, mtime) every time something would run.
//!
//! Does not: execute kernels, run any package code, install anything, or sandbox anything (confinement is
//! RESEARCH-RUNTIME-01's separate job). Environment variables found in a kernel.json are refused, not applied.
//!
//! Trust boundary: every mutating call here (`select_runtime`, `select_kernel`, `set_feature`, `set_consent`)
//! must be reached only from a device-local UI action by the person at this computer. A path, kernel name or
//! project id that arrived from a collaborator, a project file, a room message or an import must never be
//! passed to them. `select_runtime` additionally refuses any path that is not a freshly discovered candidate.
//! `set_consent` takes the LOCAL project identity; a joined or imported project has no consent until the
//! person grants it here.
//!
//! shortcut: the "current user" is taken to be the owner of $HOME (std has no geteuid); group-writable
//! parents are accepted and world-writable ones refused (sticky world-writable ancestors such as /tmp are
//! accepted, since only an entry's owner may replace it); settings writes do not fsync the parent directory.
//! Upgrade if any of that proves too weak.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_JSON: usize = 64 * 1024;
const MAX_STORE: u64 = 256 * 1024;
const MAX_PROJECTS: usize = 1000;
const CONNECTION: &str = "{connection_file}";

// ------------------------------------------------------------------ minimal strict JSON
#[derive(Debug, Clone, PartialEq)]
pub enum J { Null, Bool(bool), Num(f64), Str(String), Arr(Vec<J>), Obj(Vec<(String, J)>) }
impl J {
    fn get(&self, key: &str) -> Option<&J> { if let J::Obj(o) = self { o.iter().find(|(k, _)| k == key).map(|(_, v)| v) } else { None } }
    fn str(&self) -> Option<&str> { if let J::Str(s) = self { Some(s) } else { None } }
    fn int(&self) -> Option<i64> { if let J::Num(n) = self { (n.fract() == 0.0 && n.abs() < 9.0e15).then_some(*n as i64) } else { None } }
    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"), J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(&if n.fract() == 0.0 { format!("{}", *n as i64) } else { format!("{n}") }),
            J::Str(s) => { out.push('"'); for c in s.chars() { match c { '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"), c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)), c => out.push(c) } } out.push('"'); },
            J::Arr(a) => { out.push('['); for (i, v) in a.iter().enumerate() { if i > 0 { out.push(','); } v.write(out); } out.push(']'); },
            J::Obj(o) => { out.push('{'); for (i, (k, v)) in o.iter().enumerate() { if i > 0 { out.push(','); } J::Str(k.clone()).write(out); out.push(':'); v.write(out); } out.push('}'); },
        }
    }
}
struct Parser<'a> { b: &'a [u8], i: usize }
impl Parser<'_> {
    fn ws(&mut self) { while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) { self.i += 1; } }
    fn peek(&self, c: u8) -> bool { self.b.get(self.i) == Some(&c) }
    fn expect(&mut self, c: u8) -> Result<(), String> { if self.peek(c) { self.i += 1; Ok(()) } else { Err(format!("JSON: expected '{}'", c as char)) } }
    fn lit(&mut self, word: &str, value: J) -> Result<J, String> { if self.b[self.i..].starts_with(word.as_bytes()) { self.i += word.len(); Ok(value) } else { Err("JSON: invalid literal".into()) } }
    fn value(&mut self, depth: usize) -> Result<J, String> {
        if depth > 16 { return Err("JSON nested too deeply".into()); }
        self.ws();
        match self.b.get(self.i).copied() {
            Some(b'{') => {
                self.i += 1; let mut o: Vec<(String, J)> = vec![]; self.ws();
                if self.peek(b'}') { self.i += 1; return Ok(J::Obj(o)); }
                loop {
                    self.ws(); let k = self.string()?; self.ws(); self.expect(b':')?; let v = self.value(depth + 1)?;
                    if o.iter().any(|(e, _)| *e == k) { return Err("JSON: duplicate key".into()); }
                    if o.len() >= 256 { return Err("JSON: object too large".into()); }
                    o.push((k, v)); self.ws();
                    if self.peek(b',') { self.i += 1; } else { self.expect(b'}')?; return Ok(J::Obj(o)); }
                }
            },
            Some(b'[') => {
                self.i += 1; let mut a = vec![]; self.ws();
                if self.peek(b']') { self.i += 1; return Ok(J::Arr(a)); }
                loop {
                    a.push(self.value(depth + 1)?); if a.len() > 256 { return Err("JSON: array too large".into()); }
                    self.ws();
                    if self.peek(b',') { self.i += 1; } else { self.expect(b']')?; return Ok(J::Arr(a)); }
                }
            },
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') => self.lit("true", J::Bool(true)), Some(b'f') => self.lit("false", J::Bool(false)), Some(b'n') => self.lit("null", J::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                let start = self.i; while matches!(self.b.get(self.i), Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')) { self.i += 1; }
                std::str::from_utf8(&self.b[start..self.i]).ok().and_then(|t| t.parse::<f64>().ok()).filter(|n| n.is_finite()).map(J::Num).ok_or_else(|| "JSON: invalid number".into())
            },
            _ => Err("JSON: unexpected input".into()),
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).and_then(|s| std::str::from_utf8(s).ok()).and_then(|s| u32::from_str_radix(s, 16).ok()).ok_or("JSON: bad \\u escape")?;
        self.i += 4; Ok(h)
    }
    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?; let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or("JSON: unterminated string")?; self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).map_err(|_| "JSON: invalid UTF-8".into()),
                0..=0x1f => return Err("JSON: control character in string".into()),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or("JSON: bad escape")?; self.i += 1;
                    let ch = match e {
                        b'"' => '"', b'\\' => '\\', b'/' => '/', b'b' => '\u{8}', b'f' => '\u{c}', b'n' => '\n', b'r' => '\r', b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&hi) {
                                if !self.b[self.i..].starts_with(b"\\u") { return Err("JSON: lone surrogate".into()); }
                                self.i += 2; let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) { return Err("JSON: lone surrogate".into()); }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else { hi };
                            char::from_u32(code).ok_or("JSON: lone surrogate")?
                        },
                        _ => return Err("JSON: bad escape".into()),
                    };
                    let mut buf = [0u8; 4]; out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                },
                c => out.push(c),
            }
        }
    }
}
pub fn parse_json(text: &str) -> Result<J, String> {
    if text.len() > MAX_JSON { return Err("JSON file is too large".into()); }
    let mut p = Parser { b: text.as_bytes(), i: 0 }; let v = p.value(0)?; p.ws();
    if p.i != p.b.len() { return Err("JSON: trailing data".into()); }
    Ok(v)
}

// ------------------------------------------------------------------ model
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Feature { MathCheck, PythonAnalysis, RAnalysis, Jupyter }
impl Feature {
    pub const ALL: [Feature; 4] = [Feature::MathCheck, Feature::PythonAnalysis, Feature::RAnalysis, Feature::Jupyter];
    pub fn name(self) -> &'static str { match self { Feature::MathCheck => "math-check", Feature::PythonAnalysis => "python-analysis", Feature::RAnalysis => "r-analysis", Feature::Jupyter => "jupyter" } }
    pub fn from_name(n: &str) -> Option<Feature> { Feature::ALL.into_iter().find(|f| f.name() == n) }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind { Python, R }

/// Where to look. `Roots::system()` is the real machine; tests build a fake tree.
#[derive(Debug, Clone, Default)]
pub struct Roots {
    pub home: PathBuf, pub uid: u32, pub conda: Vec<PathBuf>, pub pyenv: PathBuf, pub python_bins: Vec<PathBuf>,
    pub r_bins: Vec<PathBuf>, pub r_frameworks: Vec<PathBuf>, pub r_user_libs: Option<PathBuf>, pub kernel_dirs: Vec<PathBuf>,
}
impl Roots {
    pub fn system() -> Roots {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        let uid = fs::metadata(&home).map(|m| m.uid()).unwrap_or(u32::MAX);
        let p = |s: &str| PathBuf::from(s);
        Roots {
            conda: vec![home.join("miniforge3"), home.join("miniconda3"), home.join("anaconda3"), p("/opt/homebrew/Caskroom/miniforge/base")],
            pyenv: home.join(".pyenv/versions"), python_bins: vec![p("/opt/homebrew/bin/python3"), p("/usr/local/bin/python3"), p("/usr/bin/python3")],
            r_bins: vec![p("/usr/local/bin/Rscript"), p("/opt/homebrew/bin/Rscript")], r_frameworks: vec![p("/Library/Frameworks/R.framework")],
            r_user_libs: Some(home.join("Library/R")),
            kernel_dirs: vec![home.join("Library/Jupyter/kernels"), p("/usr/local/share/jupyter/kernels"), p("/usr/share/jupyter/kernels")],
            home, uid,
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Identity { pub path: PathBuf, pub canonical: PathBuf, pub size: u64, pub mtime: i64, pub mtime_nsec: i64 }
#[derive(Debug, Clone)]
pub struct Runtime { pub kind: Kind, pub id: Identity, pub prefixes: Vec<PathBuf>, pub version: Option<String>, pub packages: BTreeMap<String, String> }
#[derive(Debug, Clone)]
pub struct Kernel {
    pub name: String, pub display_name: String, pub language: String, pub dir: PathBuf, pub argv: Vec<String>,
    /// Reasons the kernel.json is refused (unsafe or unsupported launch). Empty means the spec itself is acceptable.
    pub problems: Vec<String>,
    /// Set when the spec is acceptable but its interpreter lacks ipykernel/IRkernel.
    pub unavailable: Option<String>,
}
impl Kernel { pub fn usable(&self) -> bool { self.problems.is_empty() && self.unavailable.is_none() } }
#[derive(Debug, Default)]
pub struct Discovery { pub runtimes: Vec<Runtime>, pub kernels: Vec<Kernel>, pub notes: Vec<String> }

// ------------------------------------------------------------------ safe path checks
fn world_writable(m: &fs::Metadata) -> bool { m.mode() & 0o002 != 0 }
/// Every ancestor must not be writable by everyone (a sticky bit is accepted: only the entry's owner may replace it).
fn ancestors_safe(path: &Path) -> Result<(), String> {
    for a in path.ancestors().skip(1) {
        if let Ok(m) = fs::metadata(a) { if world_writable(&m) && m.mode() & 0o1000 == 0 { return Err(format!("{} is writable by everyone", a.display())); } }
    }
    Ok(())
}
fn identity(listed: &Path) -> Result<Identity, String> {
    if !listed.is_absolute() { return Err("path must be absolute".into()); }
    let canonical = fs::canonicalize(listed).map_err(|_| "path does not exist".to_string())?;
    let m = fs::metadata(&canonical).map_err(|_| "path is unreadable".to_string())?;
    if !m.is_file() || m.mode() & 0o111 == 0 { return Err("not an executable file".into()); }
    if world_writable(&m) { return Err("file is writable by everyone".into()); }
    ancestors_safe(&canonical)?;
    Ok(Identity { path: listed.to_path_buf(), canonical, size: m.len(), mtime: m.mtime(), mtime_nsec: m.mtime_nsec() })
}
/// Use-time check: the listed path must still resolve to the same file, with the same size and mtime.
pub fn verify(id: &Identity) -> Result<PathBuf, String> {
    let now = identity(&id.path)?;
    if now.canonical != id.canonical { return Err("it now points to a different file; choose it again".into()); }
    if now.size != id.size || now.mtime != id.mtime || now.mtime_nsec != id.mtime_nsec { return Err("it changed since it was chosen; choose it again".into()); }
    Ok(id.path.clone())
}

// ------------------------------------------------------------------ probing and package scans
fn probe_raw(path: &Path, limit: Duration) -> Option<String> {
    let mut child = Command::new(path).arg("--version").env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let end = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; } // pipes are not read after a kill
        }
    }
    let mut text = String::new();
    for mut pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read>)].into_iter().flatten() {
        let mut buf = String::new(); let _ = (&mut pipe).take(4096).read_to_string(&mut buf); text.push_str(&buf); text.push('\n');
    }
    Some(text)
}
fn parse_version(text: &str, kind: Kind) -> Option<String> {
    let after = match kind { Kind::Python => text.split("Python ").nth(1)?, Kind::R => text.split("version ").nth(1)? };
    let v: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    (v.chars().next().is_some_and(|c| c.is_ascii_digit())).then_some(v)
}
fn norm(name: &str) -> String { name.to_ascii_lowercase().replace('-', "_") }
fn scan_site(site: &Path, out: &mut BTreeMap<String, String>) {
    for e in fs::read_dir(site).into_iter().flatten().flatten().take(20_000) {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".dist-info") { if let Some((n, v)) = stem.split_once('-') { out.insert(norm(n), v.to_string()); } }
        else if e.file_type().is_ok_and(|t| t.is_dir()) { out.entry(norm(&name)).or_default(); }
    }
}
fn scan_rlib(lib: &Path, out: &mut BTreeMap<String, String>) {
    for e in fs::read_dir(lib).into_iter().flatten().flatten().take(5_000) {
        let Ok(mut f) = File::open(e.path().join("DESCRIPTION")) else { continue };
        let mut head = String::new(); let _ = (&mut f).take(4096).read_to_string(&mut head);
        let v = head.lines().find_map(|l| l.strip_prefix("Version:")).map(|v| v.trim().to_string()).unwrap_or_default();
        out.insert(e.file_name().to_string_lossy().into_owned(), v);
    }
}
fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).take(500).collect();
    v.sort(); v
}

/// Builds a Runtime from one listed absolute path. `probe` runs the single bounded `--version` call.
pub fn inspect(roots: &Roots, listed: &Path, kind: Kind, probe: bool) -> Result<Runtime, String> {
    let id = identity(listed)?;
    let mut packages = BTreeMap::new(); let mut prefixes: Vec<PathBuf> = vec![];
    let version = if probe { probe_raw(listed, PROBE_TIMEOUT).and_then(|t| parse_version(&t, kind)) } else { None };
    match kind {
        Kind::Python => {
            for base in [listed, id.canonical.as_path()] {
                if let Some(p) = base.parent().and_then(Path::parent) { if !prefixes.iter().any(|e| e == p) { prefixes.push(p.to_path_buf()); } }
            }
            for p in &prefixes { for lib in sorted_dirs(&p.join("lib")).into_iter().filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().starts_with("python3"))) { scan_site(&lib.join("site-packages"), &mut packages); } }
        },
        Kind::R => {
            let Some(rhome) = id.canonical.parent().and_then(Path::parent).map(Path::to_path_buf) else { return Err("not an R installation".into()) };
            scan_rlib(&rhome.join("library"), &mut packages);
            let minor = version.as_deref().map(|v| v.split('.').take(2).collect::<Vec<_>>().join("."))
                .or_else(|| id.canonical.components().rev().find_map(|c| { let s = c.as_os_str().to_string_lossy(); (s.len() >= 3 && s.as_bytes()[0].is_ascii_digit() && s.contains('.')).then(|| s.into_owned()) }));
            if let Some(user) = &roots.r_user_libs { for arch in sorted_dirs(user) { for v in sorted_dirs(&arch) {
                if minor.as_deref().is_none_or(|m| v.file_name().is_some_and(|n| n == m)) { scan_rlib(&v.join("library"), &mut packages); }
            } } }
            prefixes.push(rhome);
        },
    }
    Ok(Runtime { kind, id, prefixes, version, packages })
}

// ------------------------------------------------------------------ readiness
fn missing(rt: &Runtime, names: &[&str]) -> Result<(), String> {
    let gone: Vec<&str> = names.iter().copied().filter(|n| !rt.packages.contains_key(*n)).collect();
    // callers prefix "Unavailable:"; no absolute path here, it reaches the page (Settings shows the selection's ~ label)
    if gone.is_empty() { Ok(()) } else { Err(format!("{} {} not installed in the selected {} environment", gone.join(", "), if gone.len() == 1 { "is" } else { "are" }, if rt.kind == Kind::R { "R" } else { "Python" })) }
}
/// What each integration needs from this runtime (the kernel itself is judged separately).
pub fn runtime_support(rt: &Runtime) -> Vec<(Feature, Result<(), String>)> {
    match rt.kind {
        Kind::Python => vec![(Feature::MathCheck, missing(rt, &["sympy"])), (Feature::PythonAnalysis, missing(rt, &["numpy", "pandas", "statsmodels"])), (Feature::Jupyter, missing(rt, &["jupyter_client"]))],
        Kind::R => vec![(Feature::RAnalysis, missing(rt, &["jsonlite"]))],
    }
}
/// Optional extras that unlock sub-features, reported as plain notes.
pub fn optional_notes(rt: &Runtime) -> Vec<String> {
    let note = |names: &[&str], what: &str| names.iter().copied().filter(|n| !rt.packages.contains_key(*n)).map(|n| format!("{n} is not installed: {what} unavailable")).collect::<Vec<_>>();
    match rt.kind {
        Kind::Python => [note(&["scipy"], "optimization"), note(&["matplotlib"], "figures")].concat(),
        Kind::R => note(&["sandwich"], "package-based robust errors (built-in cluster/HAC code still works)").into_iter().chain(note(&["plm"], "plm panel models")).chain(note(&["lmtest", "forecast"], "extra time-series tests")).collect(),
    }
}

// ------------------------------------------------------------------ kernelspecs (read as data, never executed)
fn safe_name(n: &str) -> bool { !n.is_empty() && n.len() <= 64 && n.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) }
fn owned_ok(m: &fs::Metadata, roots: &Roots) -> bool { m.uid() == roots.uid || m.uid() == 0 }
fn shape_problem(language: &str, argv: &[String]) -> Option<String> {
    let base = Path::new(&argv[0]).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rest: Vec<&str> = argv[1..].iter().map(String::as_str).collect();
    match language {
        "python" => {
            if !(base.starts_with("python") && base[6..].chars().all(|c| c.is_ascii_digit() || c == '.')) { return Some("launcher is not a Python interpreter".into()); }
            let rest = rest.strip_prefix(&["-Xfrozen_modules=off"][..]).unwrap_or(&rest);
            (rest != ["-m", "ipykernel_launcher", "-f", CONNECTION]).then(|| "only 'python -m ipykernel_launcher -f {connection_file}' is allowed".into())
        },
        _ => {
            if base != "R" { return Some("launcher is not R".into()); }
            (rest != ["--slave", "-e", "IRkernel::main()", "--args", CONNECTION]).then(|| "only the standard IRkernel launch is allowed".into())
        },
    }
}
/// Reads one kernel directory. Err means "skip silently with a note"; Ok may still carry `problems`.
pub fn read_kernel(roots: &Roots, dir: &Path) -> Result<Kernel, String> {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !safe_name(&name) { return Err("unsafe kernel name".into()); }
    let dm = fs::symlink_metadata(dir).map_err(|_| "unreadable")?;
    if !dm.is_dir() { return Err("kernel directory is a symlink or not a directory".into()); }
    if world_writable(&dm) || !owned_ok(&dm, roots) { return Err("kernel directory is writable by everyone or owned by someone else".into()); }
    let file = dir.join("kernel.json"); let fm = fs::symlink_metadata(&file).map_err(|_| "no kernel.json")?;
    if !fm.is_file() || fm.len() as usize > MAX_JSON || world_writable(&fm) || !owned_ok(&fm, roots) { return Err("kernel.json is a symlink, too large, writable by everyone or owned by someone else".into()); }
    let mut k = Kernel { name, display_name: String::new(), language: String::new(), dir: dir.to_path_buf(), argv: vec![], problems: vec![], unavailable: None };
    let json = fs::read(&file).map_err(|_| "unreadable".to_string()).and_then(|b| String::from_utf8(b).map_err(|_| "not UTF-8".to_string())).and_then(|t| parse_json(&t));
    let json = match json { Ok(j) => j, Err(e) => { k.problems.push(format!("kernel.json is not valid: {e}")); return Ok(k); } };
    k.display_name = json.get("display_name").and_then(J::str).unwrap_or("").chars().filter(|c| !c.is_control()).take(100).collect();
    k.language = json.get("language").and_then(J::str).unwrap_or("").to_ascii_lowercase();
    if !matches!(k.language.as_str(), "python" | "r") { k.problems.push(format!("language {:?} is not supported", k.language)); }
    match json.get("argv") {
        Some(J::Arr(a)) if !a.is_empty() && a.len() <= 16 && a.iter().all(|v| v.str().is_some_and(|s| s.len() <= 1024 && !s.chars().any(char::is_control))) => k.argv = a.iter().filter_map(J::str).map(String::from).collect(),
        _ => k.problems.push("argv must be 1 to 16 plain strings".into()),
    }
    if let Some(J::Obj(env)) = json.get("env") { if !env.is_empty() { k.problems.push("kernel.json sets environment variables, which are never applied".into()); } }
    else if json.get("env").is_some_and(|e| *e != J::Null) { k.problems.push("env must be an object".into()); }
    if k.problems.is_empty() {
        if !Path::new(&k.argv[0]).is_absolute() { k.problems.push("argv[0] must be an absolute path (a bare 'python' would be looked up on PATH)".into()); }
        else if let Err(e) = identity(Path::new(&k.argv[0])) { k.problems.push(format!("argv[0] {e}")); }
        else if let Some(p) = shape_problem(&k.language, &k.argv) { k.problems.push(p); }
    }
    if k.problems.is_empty() {
        let (need, kind) = if k.language == "python" { ("ipykernel", Kind::Python) } else { ("IRkernel", Kind::R) };
        k.unavailable = match inspect(roots, Path::new(&k.argv[0]), kind, false) { Ok(rt) => missing(&rt, &[need]).err(), Err(e) => Some(e) };
    }
    Ok(k)
}

// ------------------------------------------------------------------ discovery
pub fn discover(roots: &Roots, probe: bool) -> Discovery {
    let mut d = Discovery::default(); let mut seen = HashSet::new();
    let mut py: Vec<PathBuf> = vec![];
    for c in &roots.conda { py.push(c.join("bin/python")); for e in sorted_dirs(&c.join("envs")) { py.push(e.join("bin/python")); } }
    for v in sorted_dirs(&roots.pyenv) { py.push(v.join("bin/python")); }
    py.extend(roots.python_bins.iter().cloned());
    let mut r: Vec<PathBuf> = roots.r_bins.clone();
    for fw in &roots.r_frameworks { r.push(fw.join("Resources/bin/Rscript")); for v in sorted_dirs(&fw.join("Versions")) { r.push(v.join("Resources/bin/Rscript")); } }
    for (kind, list) in [(Kind::Python, py), (Kind::R, r)] {
        for p in list.into_iter().filter(|p| p.exists()) {
            match inspect(roots, &p, kind, probe) {
                Ok(rt) => if seen.insert(rt.id.canonical.clone()) { d.runtimes.push(rt); },
                Err(e) => d.notes.push(format!("Skipped {}: {e}", p.display())),
            }
        }
    }
    let mut dirs = roots.kernel_dirs.clone();
    for rt in d.runtimes.iter().filter(|r| r.kind == Kind::Python) { if let Some(p) = rt.prefixes.first() { dirs.push(p.join("share/jupyter/kernels")); } }
    let mut done = HashSet::new();
    for dir in dirs.into_iter().filter(|p| done.insert(p.clone())) {
        for k in sorted_dirs_nofollow(&dir) {
            match read_kernel(roots, &k) {
                Ok(kernel) => if !d.kernels.iter().any(|e| e.name == kernel.name) { d.kernels.push(kernel); } else { d.notes.push(format!("Kernel {} in {} is shadowed by an earlier one", kernel.name, dir.display())); },
                Err(e) => d.notes.push(format!("Ignored kernel {}: {e}", k.display())),
            }
        }
    }
    if d.runtimes.iter().any(|r| r.kind == Kind::R) && !d.kernels.iter().any(|k| k.language == "r" && k.usable()) {
        d.notes.push("An R installation was found, but no usable R Jupyter kernel is installed: an R executable alone does not provide one, so R notebook cells are unavailable (R analysis scripts are unaffected)".into());
    }
    d
}
/// Kernel directories as listed, including symlinks (so read_kernel can refuse them with a reason).
fn sorted_dirs_nofollow(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir() || t.is_symlink())).map(|e| e.path()).take(200).collect();
    v.sort(); v
}
pub fn report(d: &Discovery) -> String {
    let mut s = String::new();
    for rt in &d.runtimes {
        s += &format!("{:?} {} (version {})\n  prefixes: {}\n", rt.kind, rt.id.path.display(), rt.version.as_deref().unwrap_or("unknown"), rt.prefixes.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "));
        for (f, r) in runtime_support(rt) { s += &format!("  {}: {}\n", f.name(), match r { Ok(()) => "ready".into(), Err(e) => e }); }
        for n in optional_notes(rt) { s += &format!("  note: {n}\n"); }
    }
    for k in &d.kernels { s += &format!("kernel {} [{}] {}: {}\n", k.name, k.language, k.dir.display(), if k.usable() { "usable".into() } else { k.problems.iter().cloned().chain(k.unavailable.clone()).collect::<Vec<_>>().join("; ") }); }
    for n in &d.notes { s += &format!("note: {n}\n"); }
    s
}

// ------------------------------------------------------------------ device-local selection record
#[derive(Debug, Clone, PartialEq)]
pub struct KernelPick { pub name: String, pub dir: PathBuf, pub id: Identity }
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    pub python: Option<Identity>, pub r: Option<Identity>, pub kernel: Option<KernelPick>,
    /// Enabled features; empty (all OFF) by default.
    pub enabled: std::collections::BTreeSet<Feature>,
    /// Local project id -> (granted, unix seconds). Absent means no consent.
    pub consent: BTreeMap<String, (bool, i64)>,
}
fn id_json(i: &Identity) -> J {
    J::Obj(vec![("path".into(), J::Str(i.path.to_string_lossy().into_owned())), ("canonical".into(), J::Str(i.canonical.to_string_lossy().into_owned())),
        ("size".into(), J::Num(i.size as f64)), ("mtime".into(), J::Num(i.mtime as f64)), ("mtime_nsec".into(), J::Num(i.mtime_nsec as f64))])
}
fn id_from(j: &J) -> Result<Identity, String> {
    let bad = || "settings file is damaged".to_string();
    Ok(Identity { path: PathBuf::from(j.get("path").and_then(J::str).ok_or_else(bad)?), canonical: PathBuf::from(j.get("canonical").and_then(J::str).ok_or_else(bad)?),
        size: j.get("size").and_then(J::int).and_then(|n| u64::try_from(n).ok()).ok_or_else(bad)?, mtime: j.get("mtime").and_then(J::int).ok_or_else(bad)?, mtime_nsec: j.get("mtime_nsec").and_then(J::int).ok_or_else(bad)? })
}
impl Record {
    pub fn to_json(&self) -> String {
        let opt = |i: &Option<Identity>| i.as_ref().map_or(J::Null, id_json);
        let kernel = self.kernel.as_ref().map_or(J::Null, |k| J::Obj(vec![("name".into(), J::Str(k.name.clone())), ("dir".into(), J::Str(k.dir.to_string_lossy().into_owned())), ("id".into(), id_json(&k.id))]));
        let features = J::Obj(Feature::ALL.iter().map(|f| (f.name().to_string(), J::Bool(self.enabled.contains(f)))).collect());
        let consent = J::Obj(self.consent.iter().map(|(k, (g, at))| (k.clone(), J::Obj(vec![("granted".into(), J::Bool(*g)), ("at".into(), J::Num(*at as f64))]))).collect());
        let mut out = String::new();
        J::Obj(vec![("version".into(), J::Num(1.0)), ("python".into(), opt(&self.python)), ("r".into(), opt(&self.r)), ("kernel".into(), kernel), ("features".into(), features), ("consent".into(), consent)]).write(&mut out);
        out
    }
    pub fn from_json(text: &str) -> Result<Record, String> {
        let bad = || "settings file is damaged".to_string();
        let j = parse_json(text)?; if j.get("version").and_then(J::int) != Some(1) { return Err("settings file has an unknown version".into()); }
        let mut rec = Record::default();
        let sel = |k: &str| -> Result<Option<Identity>, String> { match j.get(k) { None | Some(J::Null) => Ok(None), Some(v) => id_from(v).map(Some) } };
        rec.python = sel("python")?; rec.r = sel("r")?;
        if let Some(k @ J::Obj(_)) = j.get("kernel") {
            rec.kernel = Some(KernelPick { name: k.get("name").and_then(J::str).ok_or_else(bad)?.into(), dir: PathBuf::from(k.get("dir").and_then(J::str).ok_or_else(bad)?), id: id_from(k.get("id").ok_or_else(bad)?)? });
        }
        if let Some(J::Obj(f)) = j.get("features") { for (name, v) in f { if let (Some(feature), J::Bool(true)) = (Feature::from_name(name), v) { rec.enabled.insert(feature); } } }
        if let Some(J::Obj(c)) = j.get("consent") {
            if c.len() > MAX_PROJECTS { return Err(bad()); }
            for (id, v) in c { if !valid_project_id(id) { return Err(bad()); } let granted = matches!(v.get("granted"), Some(J::Bool(true))); rec.consent.insert(id.clone(), (granted, v.get("at").and_then(J::int).ok_or_else(bad)?)); }
        }
        Ok(rec)
    }
}
fn valid_project_id(id: &str) -> bool { !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)) }

/// Settings location: `LATEX_LOCAL_RESEARCH_SETTINGS` when set (tests), otherwise beside the TeX helper's settings.
pub fn settings_path(home: &Path, overridden: Option<std::ffi::OsString>) -> PathBuf {
    overridden.map(PathBuf::from).unwrap_or_else(|| home.join("Library/Application Support/LaTeX Local/research.json"))
}
pub struct Store { path: PathBuf }
impl Store {
    pub fn new(path: PathBuf) -> Store { Store { path } }
    pub fn from_env(home: &Path) -> Store { Store::new(settings_path(home, std::env::var_os("LATEX_LOCAL_RESEARCH_SETTINGS"))) }
    fn parent(&self) -> Result<&Path, String> { self.path.parent().ok_or_else(|| "invalid settings path".to_string()) }
    pub fn load(&self) -> Result<Record, String> {
        let m = match fs::symlink_metadata(&self.path) { Ok(m) => m, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()), Err(_) => return Err("settings unavailable".into()) };
        if !m.is_file() { return Err("settings path is not a regular file".into()); }
        if m.mode() & 0o022 != 0 { return Err("settings file is writable by others; refusing to read it".into()); }
        if m.len() > MAX_STORE { return Err("settings file is too large".into()); }
        if let Ok(pm) = fs::metadata(self.parent()?) { if world_writable(&pm) { return Err("settings folder is writable by everyone".into()); } }
        Record::from_json(&String::from_utf8(fs::read(&self.path).map_err(|_| "settings unreadable")?).map_err(|_| "settings file is damaged")?)
    }
    /// Atomic: write a private temporary file, flush it, rename over the old one. An interrupted save leaves the old file intact.
    pub fn save(&self, rec: &Record) -> Result<(), String> {
        let parent = self.parent()?;
        if !parent.exists() { fs::create_dir_all(parent).map_err(|_| "settings folder unavailable")?; let _ = fs::set_permissions(parent, std::os::unix::fs::PermissionsExt::from_mode(0o700)); }
        if world_writable(&fs::metadata(parent).map_err(|_| "settings folder unavailable")?) { return Err("settings folder is writable by everyone".into()); }
        if let Ok(m) = fs::symlink_metadata(&self.path) { if !m.is_file() { return Err("settings path is not a regular file".into()); } }
        let tmp = self.path.with_extension("json.new");
        match fs::symlink_metadata(&tmp) { Ok(m) if m.is_file() || m.file_type().is_symlink() => { let _ = fs::remove_file(&tmp); }, _ => {} } // a stale file from an interrupted save
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(|_| "settings write unavailable")?;
        f.write_all(rec.to_json().as_bytes()).map_err(|_| "settings write failed")?; f.sync_all().map_err(|_| "settings sync failed")?;
        fs::rename(&tmp, &self.path).map_err(|_| "settings update failed".into())
    }
}

// ------------------------------------------------------------------ selection (device-local UI calls only)
/// A candidate is selectable only if its listed path is one just discovered. Changing it switches dependent features off.
pub fn select_runtime(rec: &mut Record, d: &Discovery, kind: Kind, listed: &Path) -> Result<(), String> {
    let rt = d.runtimes.iter().find(|r| r.kind == kind && r.id.path == listed).ok_or("That is not a discovered Python or R installation")?;
    let id = verify(&rt.id).and(Ok(rt.id.clone()))?;
    match kind {
        Kind::Python => { rec.python = Some(id); for f in [Feature::MathCheck, Feature::PythonAnalysis, Feature::Jupyter] { rec.enabled.remove(&f); } },
        Kind::R => { rec.r = Some(id); rec.enabled.remove(&Feature::RAnalysis); },
    }
    Ok(())
}
pub fn select_kernel(rec: &mut Record, d: &Discovery, name: &str) -> Result<(), String> {
    let k = d.kernels.iter().find(|k| k.name == name).ok_or("That is not a discovered kernel")?;
    if !k.usable() { return Err(k.problems.iter().cloned().chain(k.unavailable.clone()).collect::<Vec<_>>().join("; ")); }
    rec.kernel = Some(KernelPick { name: k.name.clone(), dir: k.dir.clone(), id: identity(Path::new(&k.argv[0]))? });
    rec.enabled.remove(&Feature::Jupyter); Ok(())
}
/// Everything that must hold right now for a feature to run: selection verified, readiness from disk, kernel re-read.
pub fn ready(rec: &Record, roots: &Roots, f: Feature) -> Result<PathBuf, String> {
    let (id, kind) = if f == Feature::RAnalysis { (rec.r.as_ref().ok_or("No R installation is selected")?, Kind::R) } else { (rec.python.as_ref().ok_or("No Python environment is selected")?, Kind::Python) };
    let path = verify(id).map_err(|e| format!("The selected {} {e}", if kind == Kind::R { "R" } else { "Python" }))?;
    let rt = inspect(roots, &id.path, kind, false)?;
    runtime_support(&rt).into_iter().find(|(x, _)| *x == f).map(|(_, r)| r).unwrap_or(Err("unsupported feature".into()))?;
    if f == Feature::Jupyter {
        let pick = rec.kernel.as_ref().ok_or("No Jupyter kernel is selected")?;
        let k = read_kernel(roots, &pick.dir)?;
        if !k.usable() { return Err(k.problems.iter().cloned().chain(k.unavailable).collect::<Vec<_>>().join("; ")); }
        if k.name != pick.name || Path::new(&k.argv[0]) != pick.id.path { return Err("The selected kernel was edited; choose it again".into()); }
        verify(&pick.id).map_err(|e| format!("The kernel interpreter {e}"))?;
    }
    Ok(path)
}
/// Turning a feature on needs a verified selection and readiness. Turning it off always works. Defaults are all OFF.
pub fn set_feature(rec: &mut Record, roots: &Roots, f: Feature, on: bool) -> Result<(), String> {
    if on { ready(rec, roots, f)?; rec.enabled.insert(f); } else { rec.enabled.remove(&f); }
    Ok(())
}
pub fn set_consent(rec: &mut Record, local_project_id: &str, granted: bool, now: i64) -> Result<(), String> {
    if !valid_project_id(local_project_id) { return Err("invalid project id".into()); }
    if !rec.consent.contains_key(local_project_id) && rec.consent.len() >= MAX_PROJECTS { return Err("too many projects with a recorded decision".into()); }
    rec.consent.insert(local_project_id.to_string(), (granted, now)); Ok(())
}
pub fn has_consent(rec: &Record, local_project_id: &str) -> bool { rec.consent.get(local_project_id).is_some_and(|(g, _)| *g) }
/// The single gate before any research code runs: toggle on, project consented, identity re-verified, readiness re-read.
/// Returns the verified interpreter path to launch directly (no shell).
pub fn authorize(rec: &Record, roots: &Roots, f: Feature, local_project_id: &str) -> Result<PathBuf, String> {
    if !rec.enabled.contains(&f) { return Err(format!("{} is turned off on this device", f.name())); }
    if !has_consent(rec, local_project_id) { return Err("This project has not been approved to run code on this device".into()); }
    ready(rec, roots, f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);
    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Tmp { let p = std::env::temp_dir().join(format!("research-discover-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))); fs::create_dir_all(&p).unwrap(); Tmp(fs::canonicalize(p).unwrap()) }
        fn p(&self, rel: &str) -> PathBuf { self.0.join(rel) }
    }
    impl Drop for Tmp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn script(path: &Path, body: &str) { fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap(); fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap(); }
    fn pkgs(site: &Path, names: &[&str]) { for n in names { fs::create_dir_all(site.join(format!("{n}-1.2.3.dist-info"))).unwrap(); fs::create_dir_all(site.join(n)).unwrap(); } }
    /// A fake conda root with a base and named envs; `envs` = (name, packages).
    fn conda(t: &Tmp, envs: &[(&str, &[&str])]) -> PathBuf {
        let root = t.p("miniforge3");
        script(&root.join("bin/python"), "echo \"Python 3.99.0\"");
        pkgs(&root.join("lib/python3.99/site-packages"), &["jupyter_client", "ipykernel"]);
        for (name, p) in envs { let e = root.join("envs").join(name); script(&e.join("bin/python"), "echo \"Python 3.98.1\""); pkgs(&e.join("lib/python3.98/site-packages"), p); }
        root
    }
    fn fake_r(t: &Tmp, libs: &[&str]) -> PathBuf {
        let fw = t.p("R.framework");
        script(&fw.join("Versions/4.9/Resources/bin/Rscript"), "echo \"Rscript (R) version 4.9.9 (2099-01-01)\" >&2");
        script(&fw.join("Versions/4.9/Resources/bin/R"), "exit 0");
        for l in libs { fs::create_dir_all(fw.join("Versions/4.9/Resources/library").join(l)).unwrap(); fs::write(fw.join("Versions/4.9/Resources/library").join(l).join("DESCRIPTION"), format!("Package: {l}\nVersion: 7.7.7\n")).unwrap(); }
        std::os::unix::fs::symlink("4.9", fw.join("Versions/Current")).unwrap();
        std::os::unix::fs::symlink("Versions/Current/Resources", fw.join("Resources")).unwrap();
        fw
    }
    fn roots(t: &Tmp) -> Roots { Roots { home: t.0.clone(), uid: fs::metadata(&t.0).unwrap().uid(), ..Default::default() } }
    fn kernel(dir: &Path, name: &str, json: &str) -> PathBuf { let d = dir.join(name); fs::create_dir_all(&d).unwrap(); fs::write(d.join("kernel.json"), json).unwrap(); d }
    fn py_kernel_json(py: &Path) -> String { format!(r#"{{"argv":["{}","-Xfrozen_modules=off","-m","ipykernel_launcher","-f","{{connection_file}}"],"display_name":"Py","language":"python"}}"#, py.display()) }
    fn r_kernel_json(r: &Path) -> String { format!(r#"{{"argv":["{}","--slave","-e","IRkernel::main()","--args","{{connection_file}}"],"display_name":"R","language":"R"}}"#, r.display()) }

    #[test] fn json_parser_is_strict_and_bounded() {
        assert_eq!(parse_json(r#"{"a":"é😀\n","b":[1,-2.5,true,null]}"#).unwrap().get("a").and_then(J::str), Some("é😀\n"));
        for bad in [r#"{"a":1,"a":2}"#, "[1,]", r#"{"a":}"#, r#""\ud800""#, "{\"a\":\"x\ny\"}", "1 2", "nul", r#"{"a":1e999}"#] { assert!(parse_json(bad).is_err(), "{bad}"); }
        assert!(parse_json(&format!("{}{}", "[".repeat(100), "]".repeat(100))).is_err()); assert!(parse_json(&format!("{}{}", "[".repeat(10), "]".repeat(10))).is_ok());   // depth bound, no stack overflow
        assert!(parse_json(&format!("\"{}\"", "x".repeat(MAX_JSON))).is_err());
        let mut s = String::new(); parse_json(r#"{"k":"a\"b\\c\u0001"}"#).unwrap().write(&mut s); assert_eq!(parse_json(&s).unwrap().get("k").and_then(J::str), Some("a\"b\\c\u{1}"));
    }

    #[test] fn discovers_conda_envs_probes_versions_and_reports_missing_packages() {
        let t = Tmp::new(); let c = conda(&t, &[("full", &["sympy", "numpy", "pandas", "statsmodels", "scipy", "matplotlib", "jupyter_client", "ipykernel"]), ("bare", &["numpy"])]);
        let mut r = roots(&t); r.conda = vec![c];
        let d = discover(&r, true);
        assert_eq!(d.runtimes.len(), 3); assert_eq!(d.runtimes[0].version.as_deref(), Some("3.99.0")); assert_eq!(d.runtimes[1].version.as_deref(), Some("3.98.1"));
        let find = |name: &str| d.runtimes.iter().find(|x| x.id.path.to_string_lossy().contains(name)).unwrap();
        assert!(runtime_support(find("envs/full")).iter().all(|(_, s)| s.is_ok()));
        assert_eq!(find("envs/full").packages.get("numpy").map(String::as_str), Some("1.2.3"));
        let bare = runtime_support(find("envs/bare"));
        let e = bare.iter().find(|(f, _)| *f == Feature::MathCheck).unwrap().1.clone().unwrap_err();
        assert_eq!(e, "sympy is not installed in the selected Python environment");
        assert!(bare.iter().find(|(f, _)| *f == Feature::PythonAnalysis).unwrap().1.clone().unwrap_err().contains("pandas, statsmodels are not installed"));
        assert_eq!(optional_notes(find("envs/bare")).len(), 2); assert!(optional_notes(find("envs/full")).is_empty());
        let none = discover(&roots(&t), false); assert!(none.runtimes.is_empty());
    }

    #[test] fn dedupes_by_canonical_path_and_skips_unsafe_candidates() {
        let t = Tmp::new(); let c = conda(&t, &[]);
        let alias = t.p("bin/python3"); fs::create_dir_all(alias.parent().unwrap()).unwrap(); std::os::unix::fs::symlink(c.join("bin/python"), &alias).unwrap();
        let mut r = roots(&t); r.conda = vec![c.clone()]; r.python_bins = vec![alias];
        assert_eq!(discover(&r, false).runtimes.len(), 1);
        fs::set_permissions(c.join("bin/python"), fs::Permissions::from_mode(0o757)).unwrap();                // world-writable binary
        let d = discover(&r, false); assert!(d.runtimes.is_empty() && d.notes.iter().any(|n| n.contains("writable by everyone")), "{:?}", d.notes);
    }

    #[test] fn world_writable_ancestor_is_refused_but_sticky_is_accepted() {
        let t = Tmp::new(); let c = conda(&t, &[]);
        let mut r = roots(&t); r.conda = vec![c];
        fs::set_permissions(&t.0, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(discover(&r, false).runtimes.is_empty());
        fs::set_permissions(&t.0, fs::Permissions::from_mode(0o1777)).unwrap();
        assert_eq!(discover(&r, false).runtimes.len(), 1);
        fs::set_permissions(&t.0, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test] fn probe_is_bounded_unshelled_and_runs_with_a_cleared_environment() {
        let t = Tmp::new(); let slow = t.p("slow"); script(&slow, "exec sleep 30");
        let started = Instant::now(); assert!(probe_raw(&slow, Duration::from_millis(300)).is_none()); assert!(started.elapsed() < Duration::from_secs(2));
        let env = t.p("env"); script(&env, "if [ -z \"${HOME+x}\" ]; then echo \"Python 9.9.9 nohome\"; else echo \"Python 9.9.9 home\"; fi");
        let raw = probe_raw(&env, Duration::from_secs(3)).unwrap(); assert!(raw.contains("nohome"), "{raw}");
        assert_eq!(parse_version("Rscript (R) version 4.6.1 (2026-06-24)", Kind::R).as_deref(), Some("4.6.1")); assert_eq!(parse_version("garbage", Kind::Python), None);
        let big = t.p("big"); script(&big, "head -c 200000 /dev/zero | tr '\\0' 'x'");   // output flood: killed at the limit, never hangs or fills memory
        let started = Instant::now(); assert!(probe_raw(&big, Duration::from_millis(500)).is_none()); assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test] fn r_discovery_reads_libraries_and_user_library_for_the_matching_minor_only() {
        let t = Tmp::new(); let fw = fake_r(&t, &["jsonlite", "stats"]);
        fs::create_dir_all(t.p("ul/arm64/4.9/library/plm")).unwrap(); fs::write(t.p("ul/arm64/4.9/library/plm/DESCRIPTION"), "Version: 2.6\n").unwrap();
        fs::create_dir_all(t.p("ul/arm64/4.1/library/sandwich")).unwrap(); fs::write(t.p("ul/arm64/4.1/library/sandwich/DESCRIPTION"), "Version: 3\n").unwrap();
        let mut r = roots(&t); r.r_frameworks = vec![fw]; r.r_user_libs = Some(t.p("ul"));
        let d = discover(&r, true); assert_eq!(d.runtimes.len(), 1);
        let rt = &d.runtimes[0]; assert_eq!(rt.version.as_deref(), Some("4.9.9"));
        assert!(rt.packages.contains_key("jsonlite") && rt.packages.contains_key("plm") && !rt.packages.contains_key("sandwich"));
        assert!(runtime_support(rt)[0].1.is_ok());
        let notes = optional_notes(rt); assert!(notes.iter().any(|n| n.contains("sandwich")) && !notes.iter().any(|n| n.contains("plm is")));
        let t2 = Tmp::new(); let no_json = fake_r(&t2, &[]); let mut r2 = roots(&t2); r2.r_frameworks = vec![no_json];
        assert!(runtime_support(&discover(&r2, false).runtimes[0])[0].1.clone().unwrap_err().contains("jsonlite is not installed"));
    }

    #[test] fn kernelspecs_are_data_and_only_two_launch_shapes_are_accepted() {
        let t = Tmp::new(); let c = conda(&t, &[]); let py = c.join("bin/python"); let fw = fake_r(&t, &["IRkernel"]); let rbin = fw.join("Versions/4.9/Resources/bin/R");
        let kd = t.p("kernels"); fs::create_dir_all(&kd).unwrap();
        let marker = t.p("executed");
        kernel(&kd, "good-py", &py_kernel_json(&py)); kernel(&kd, "good-r", &r_kernel_json(&rbin));
        kernel(&kd, "relative", r#"{"argv":["python","-m","ipykernel_launcher","-f","{connection_file}"],"language":"python"}"#);
        kernel(&kd, "shell", &format!(r#"{{"argv":["/bin/sh","-c","touch {}"],"language":"python"}}"#, marker.display()));
        kernel(&kd, "dash-c", &format!(r#"{{"argv":["{}","-c","import os","-f","{{connection_file}}"],"language":"python"}}"#, py.display()));
        kernel(&kd, "other-module", &format!(r#"{{"argv":["{}","-m","evil","-f","{{connection_file}}"],"language":"python"}}"#, py.display()));
        kernel(&kd, "with-env", &format!(r#"{{"argv":["{}","-m","ipykernel_launcher","-f","{{connection_file}}"],"language":"python","env":{{"PYTHONPATH":"/tmp/x"}}}}"#, py.display()));
        kernel(&kd, "wrong-lang", &format!(r#"{{"argv":["{}","-m","ipykernel_launcher","-f","{{connection_file}}"],"language":"julia"}}"#, py.display()));
        kernel(&kd, "missing-exe", r#"{"argv":["/nonexistent/python","-m","ipykernel_launcher","-f","{connection_file}"],"language":"python"}"#);
        kernel(&kd, "bad-json", "{not json"); kernel(&kd, "dup-keys", r#"{"language":"python","language":"r"}"#);
        kernel(&kd, "argv-types", r#"{"argv":[1,2],"language":"python"}"#); kernel(&kd, "meta;chars", &py_kernel_json(&py)); kernel(&kd, "huge", &" ".repeat(MAX_JSON + 1));
        std::os::unix::fs::symlink(kd.join("good-py"), kd.join("linked")).unwrap();
        let mut r = roots(&t); r.conda = vec![c]; r.r_frameworks = vec![fw]; r.kernel_dirs = vec![kd.clone()];
        let d = discover(&r, false);
        let usable: Vec<&str> = d.kernels.iter().filter(|k| k.usable()).map(|k| k.name.as_str()).collect(); assert_eq!(usable, ["good-py", "good-r"], "{}", report(&d));
        for bad in ["relative", "shell", "dash-c", "other-module", "with-env", "wrong-lang", "missing-exe", "bad-json", "dup-keys", "argv-types"] {
            let k = d.kernels.iter().find(|k| k.name == bad).unwrap_or_else(|| panic!("{bad} missing")); assert!(!k.usable() && !k.problems.is_empty(), "{bad}");
        }
        assert!(d.kernels.iter().find(|k| k.name == "relative").unwrap().problems[0].contains("looked up on PATH"));
        assert!(d.kernels.iter().all(|k| !["meta;chars", "huge", "linked"].contains(&k.name.as_str())));
        assert!(d.notes.iter().any(|n| n.contains("unsafe kernel name")) && d.notes.iter().any(|n| n.contains("symlink")) && d.notes.iter().any(|n| n.contains("too large")));
        assert!(!marker.exists());
    }

    #[test] fn kernel_directories_that_anyone_can_write_are_ignored_and_first_name_wins() {
        let t = Tmp::new(); let c = conda(&t, &[]); let py = c.join("bin/python");
        let a = t.p("a"); let b = t.p("b"); kernel(&a, "k", &py_kernel_json(&py)); kernel(&b, "k", &py_kernel_json(&py)); kernel(&b, "second", &py_kernel_json(&py));
        let mut r = roots(&t); r.conda = vec![c]; r.kernel_dirs = vec![a.clone(), b.clone()];
        let d = discover(&r, false); assert_eq!(d.kernels.len(), 2); assert!(d.notes.iter().any(|n| n.contains("shadowed")));
        fs::set_permissions(b.join("second"), fs::Permissions::from_mode(0o777)).unwrap(); fs::set_permissions(a.join("k/kernel.json"), fs::Permissions::from_mode(0o666)).unwrap();
        let d = discover(&r, false); assert!(d.kernels.iter().all(|k| k.name != "second") && d.kernels.iter().all(|k| k.dir != a.join("k")), "{}", report(&d));
        let mut other = roots(&t); other.uid = other.uid.wrapping_add(1000); assert!(read_kernel(&other, &b.join("k")).is_err());        // owned by someone else
    }

    #[test] fn missing_kernel_packages_and_an_r_without_kernel_are_reported_separately() {
        let t = Tmp::new(); let c = conda(&t, &[("nokernel", &["jupyter_client"])]); let py = c.join("envs/nokernel/bin/python"); let fw = fake_r(&t, &["jsonlite"]); let rbin = fw.join("Versions/4.9/Resources/bin/R");
        let kd = t.p("k"); kernel(&kd, "py", &py_kernel_json(&py)); kernel(&kd, "ir", &r_kernel_json(&rbin));
        let mut r = roots(&t); r.conda = vec![c]; r.r_frameworks = vec![fw]; r.kernel_dirs = vec![kd];
        let d = discover(&r, false);
        let pk = d.kernels.iter().find(|k| k.name == "py").unwrap(); assert!(pk.problems.is_empty() && pk.unavailable.as_deref().unwrap().contains("ipykernel is not installed"));
        assert!(d.kernels.iter().find(|k| k.name == "ir").unwrap().unavailable.as_deref().unwrap().contains("IRkernel is not installed"));
        assert!(d.notes.iter().any(|n| n.contains("R executable alone does not provide one")));
        assert!(runtime_support(d.runtimes.iter().find(|r| r.kind == Kind::R).unwrap())[0].1.is_ok());       // R analysis is independent of the kernel
    }

    /// A fully ready fake machine: python env, R, a usable kernel, all selected through the public API.
    fn machine() -> (Tmp, Roots, Discovery, PathBuf, PathBuf) {
        let t = Tmp::new(); let c = conda(&t, &[("work", &["sympy", "numpy", "pandas", "statsmodels", "jupyter_client", "ipykernel"])]); let py = c.join("envs/work/bin/python");
        let fw = fake_r(&t, &["jsonlite"]); let kd = t.p("kernels"); kernel(&kd, "work", &py_kernel_json(&py));
        let mut r = roots(&t); r.conda = vec![c]; r.r_frameworks = vec![fw.clone()]; r.kernel_dirs = vec![kd];
        let d = discover(&r, false); let rs = fw.join("Resources/bin/Rscript"); (t, r, d, py, rs)
    }

    #[test] fn defaults_are_off_and_selection_only_accepts_discovered_candidates() {
        let (t, roots, d, py, _) = machine();
        let mut rec = Record::default(); assert!(rec.enabled.is_empty() && rec.python.is_none() && rec.consent.is_empty());
        for f in Feature::ALL { assert!(authorize(&rec, &roots, f, "p1").is_err()); }
        for foreign in [Path::new("/bin/sh"), Path::new("/usr/bin/python3"), Path::new("relative/python"), &t.p("miniforge3/envs/../bin/python")] { assert!(select_runtime(&mut rec, &d, Kind::Python, foreign).is_err(), "{foreign:?}"); }
        assert!(select_runtime(&mut rec, &d, Kind::R, &py).is_err());                                  // wrong kind
        select_runtime(&mut rec, &d, Kind::Python, &py).unwrap(); assert!(rec.enabled.is_empty());
        assert!(select_kernel(&mut rec, &d, "nope").is_err()); select_kernel(&mut rec, &d, "work").unwrap();
        assert_eq!(set_feature(&mut rec, &roots, Feature::RAnalysis, true).unwrap_err(), "No R installation is selected");
        for f in [Feature::MathCheck, Feature::PythonAnalysis, Feature::Jupyter] { set_feature(&mut rec, &roots, f, true).unwrap(); }
        assert_eq!(rec.enabled.len(), 3);
        select_runtime(&mut rec, &d, Kind::Python, &py).unwrap(); assert!(rec.enabled.is_empty(), "changing the interpreter switches dependent features off");
        set_feature(&mut rec, &roots, Feature::MathCheck, true).unwrap(); set_feature(&mut rec, &roots, Feature::MathCheck, false).unwrap(); assert!(rec.enabled.is_empty());
    }

    #[test] fn feature_cannot_be_enabled_when_packages_are_missing() {
        let t = Tmp::new(); let c = conda(&t, &[("lean", &["numpy"])]); let py = c.join("envs/lean/bin/python"); let mut r = roots(&t); r.conda = vec![c];
        let d = discover(&r, false); let mut rec = Record::default(); select_runtime(&mut rec, &d, Kind::Python, &py).unwrap();
        let e = set_feature(&mut rec, &r, Feature::MathCheck, true).unwrap_err(); assert!(e.starts_with("sympy is not installed in the selected Python environment"), "{e}"); assert!(rec.enabled.is_empty());
        assert!(set_feature(&mut rec, &r, Feature::Jupyter, true).is_err());
    }

    #[test] fn a_swapped_binary_or_retargeted_symlink_or_touched_file_is_detected_at_use_time() {
        let t = Tmp::new(); let e = t.p("env/bin"); fs::create_dir_all(&e).unwrap(); let (a, b) = (e.join("python-a"), e.join("python-b"));
        script(&a, "echo \"Python 3.1.0\""); script(&b, "echo \"Python 3.1.1\" # different");
        let link = e.join("python"); std::os::unix::fs::symlink(&a, &link).unwrap(); pkgs(&t.p("env/lib/python3.1/site-packages"), &["sympy"]);
        let mut r = roots(&t); r.python_bins = vec![link.clone()];
        let d = discover(&r, false); let mut rec = Record::default(); select_runtime(&mut rec, &d, Kind::Python, &link).unwrap();
        let id = rec.python.clone().unwrap(); assert!(verify(&id).is_ok());
        fs::remove_file(&link).unwrap(); std::os::unix::fs::symlink(&b, &link).unwrap();                // symlink retarget
        assert!(verify(&id).unwrap_err().contains("different file")); assert!(authorize(&{ let mut x = rec.clone(); x.enabled.insert(Feature::MathCheck); set_consent(&mut x, "p", true, 1).unwrap(); x }, &r, Feature::MathCheck, "p").is_err());
        fs::remove_file(&link).unwrap(); std::os::unix::fs::symlink(&a, &link).unwrap(); assert!(verify(&id).is_ok());
        let body = fs::read(&a).unwrap(); fs::write(&a, [body.clone(), b"#x\n".to_vec()].concat()).unwrap(); assert!(verify(&id).unwrap_err().contains("changed"));        // content swap (size)
        std::thread::sleep(Duration::from_millis(20)); fs::write(&a, &body).unwrap(); assert!(verify(&id).unwrap_err().contains("changed"));            // same bytes, new mtime
        // documented limit: an in-place edit that restores both size and mtime is not detected (no content hash)
    }

    #[test] fn consent_defaults_to_none_is_local_and_gates_authorization() {
        let (_t, roots, d, py, _) = machine(); let mut rec = Record::default();
        select_runtime(&mut rec, &d, Kind::Python, &py).unwrap(); select_kernel(&mut rec, &d, "work").unwrap();
        for f in [Feature::MathCheck, Feature::Jupyter] { set_feature(&mut rec, &roots, f, true).unwrap(); }
        assert!(!has_consent(&rec, "imported-project"));
        assert_eq!(authorize(&rec, &roots, Feature::MathCheck, "imported-project").unwrap_err(), "This project has not been approved to run code on this device");
        set_consent(&mut rec, "mine-1", true, 1_700_000_000).unwrap();
        assert_eq!(authorize(&rec, &roots, Feature::MathCheck, "mine-1").unwrap(), py); assert!(authorize(&rec, &roots, Feature::Jupyter, "mine-1").is_ok());
        assert!(authorize(&rec, &roots, Feature::PythonAnalysis, "mine-1").unwrap_err().contains("turned off"));              // consent never enables a feature
        assert!(authorize(&rec, &roots, Feature::MathCheck, "other").is_err());
        set_consent(&mut rec, "mine-1", false, 2).unwrap(); assert!(authorize(&rec, &roots, Feature::MathCheck, "mine-1").is_err());
        for bad in ["", "a b", "../x", "x/y", &"x".repeat(129), "é"] { assert!(set_consent(&mut rec, bad, true, 1).is_err(), "{bad:?}"); }
        for i in 0..MAX_PROJECTS { let _ = set_consent(&mut rec, &format!("p{i}"), true, 1); } assert!(set_consent(&mut rec, "overflow", true, 1).is_err()); assert!(set_consent(&mut rec, "p1", false, 1).is_ok());
    }

    #[test] fn a_kernel_json_edited_after_selection_is_refused_at_use_time() {
        let (_t, roots, d, py, _) = machine(); let mut rec = Record::default(); select_runtime(&mut rec, &d, Kind::Python, &py).unwrap(); select_kernel(&mut rec, &d, "work").unwrap();
        set_feature(&mut rec, &roots, Feature::Jupyter, true).unwrap(); set_consent(&mut rec, "p", true, 1).unwrap(); assert!(authorize(&rec, &roots, Feature::Jupyter, "p").is_ok());
        let kj = rec.kernel.as_ref().unwrap().dir.join("kernel.json");
        fs::write(&kj, r#"{"argv":["/bin/sh","-c","evil"],"language":"python"}"#).unwrap(); assert!(authorize(&rec, &roots, Feature::Jupyter, "p").is_err());
        fs::write(&kj, py_kernel_json(Path::new("/usr/bin/python3"))).unwrap(); assert!(authorize(&rec, &roots, Feature::Jupyter, "p").is_err());
        fs::write(&kj, py_kernel_json(&py)).unwrap(); assert!(authorize(&rec, &roots, Feature::Jupyter, "p").is_ok());
    }

    #[test] fn settings_round_trip_with_private_permissions_and_survive_corruption_and_unsafe_paths() {
        let (t, roots, d, py, rs) = machine(); let path = t.p("cfg/research.json"); let store = Store::new(path.clone());
        assert_eq!(store.load().unwrap(), Record::default());
        let mut rec = Record::default(); select_runtime(&mut rec, &d, Kind::Python, &py).unwrap(); select_runtime(&mut rec, &d, Kind::R, &rs).unwrap(); select_kernel(&mut rec, &d, "work").unwrap();
        set_feature(&mut rec, &roots, Feature::MathCheck, true).unwrap(); set_feature(&mut rec, &roots, Feature::RAnalysis, true).unwrap(); set_consent(&mut rec, "mine:1", true, 42).unwrap();
        store.save(&rec).unwrap(); assert_eq!(store.load().unwrap(), rec);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600); assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o700);
        let text = fs::read_to_string(&path).unwrap(); assert!(!text.contains("project content") && text.contains("\"jupyter\":false"));
        fs::write(&path, "{broken").unwrap(); fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap(); assert!(store.load().is_err());
        fs::write(&path, r#"{"version":2}"#).unwrap(); assert!(store.load().is_err());
        fs::write(&path, r#"{"version":1,"consent":{"../x":{"granted":true,"at":1}}}"#).unwrap(); assert!(store.load().is_err());
        store.save(&rec).unwrap(); fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap(); assert!(store.load().unwrap_err().contains("writable by others"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o777)).unwrap(); assert!(store.save(&rec).is_err() && store.load().is_err()); fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        let link = t.p("cfg/link.json"); std::os::unix::fs::symlink(&path, &link).unwrap(); let s2 = Store::new(link); assert!(s2.load().is_err() && s2.save(&rec).is_err());
        assert_eq!(settings_path(Path::new("/h"), Some("/x/y.json".into())), PathBuf::from("/x/y.json")); assert_eq!(settings_path(Path::new("/h"), None), PathBuf::from("/h/Library/Application Support/LaTeX Local/research.json"));
    }

    #[test] fn an_interrupted_save_never_damages_the_previous_settings() {
        let t = Tmp::new(); let path = t.p("cfg/research.json"); let store = Store::new(path.clone()); let mut rec = Record::default(); set_consent(&mut rec, "a", true, 1).unwrap(); store.save(&rec).unwrap();
        let tmp = path.with_extension("json.new");
        fs::write(&tmp, b"{\"version\":1,\"consent\":{\"a\":{\"gran").unwrap();                        // killed mid-write: partial temporary file left behind
        assert_eq!(store.load().unwrap(), rec);
        let mut next = rec.clone(); set_consent(&mut next, "b", true, 2).unwrap(); store.save(&next).unwrap(); assert_eq!(store.load().unwrap(), next); assert!(!tmp.exists());
        fs::create_dir(&tmp).unwrap(); fs::write(tmp.join("x"), "x").unwrap();                           // an unremovable obstacle: save fails, old file intact
        assert!(store.save(&rec).is_err()); assert_eq!(store.load().unwrap(), next); fs::remove_dir_all(&tmp).unwrap();
        std::os::unix::fs::symlink("/tmp/redirect-target", &tmp).unwrap(); store.save(&rec).unwrap(); assert!(!Path::new("/tmp/redirect-target").exists()); assert_eq!(store.load().unwrap(), rec);   // a planted symlink is replaced, not followed
    }

    #[test] #[ignore = "reads the real machine; prints, stores nothing"] fn real_machine_smoke() {
        let roots = Roots::system(); let started = Instant::now(); let d = discover(&roots, true); println!("{}", report(&d)); println!("discovery+probes took {:?}", started.elapsed());
        let again = Instant::now(); let _ = discover(&roots, false); println!("discovery without probes took {:?}", again.elapsed());
    }
}
