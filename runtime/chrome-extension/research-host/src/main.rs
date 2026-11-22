// SPDX-License-Identifier: AGPL-3.0-only
//! latex-local-research. Started by Chrome (argument: the extension origin) it is the editor's native-messaging host for
//! device-local research settings and confined Jupyter sessions (session.rs). Started any other way it runs ONE script
//! with ONE Python or R interpreter under a macOS sandbox. Protocol: one JSON request line on stdin, then optionally
//! {"op":"cancel"}; stdin EOF also cancels. Output: JSON lines {"ev":"started","pid":n} and {"ev":"result",...}.
//! Confinement claims live in test/research_confinement.test.mjs and test/research_session.test.mjs.
#[allow(dead_code)] mod discover;
mod sandbox;
mod session;
use base64::{engine::general_purpose::STANDARD, Engine};
use sandbox::Kind;
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::{self, BufRead, Read, Write}, os::unix::{fs::{DirBuilderExt, OpenOptionsExt}, process::{CommandExt, ExitStatusExt}},
    path::{Path, PathBuf}, process::Command, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};

const MAX_REQUEST: u64 = 12 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_RESULT_FILES_TOTAL: u64 = 16 * 1024 * 1024;

/// Private job root: `job/` is the only writable/readable-by-script tree; `ctl/` (profile, stdin, captured output) is never granted.
struct Job { root: PathBuf, job: PathBuf, ctl: PathBuf }
impl Drop for Job { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
impl Job {
    fn create() -> Result<Self, String> {
        let mut random = [0u8; 16]; File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut random)).map_err(|_| "Random source unavailable")?;
        let base = fs::canonicalize(std::env::temp_dir()).map_err(|_| "Temporary directory unavailable")?;
        let root = base.join(format!("latex-local-research-{:x}", u128::from_ne_bytes(random)));
        fs::DirBuilder::new().mode(0o700).create(&root).map_err(|_| "Private job directory unavailable")?;
        let job = Job { job: root.join("job"), ctl: root.join("ctl"), root };
        for dir in [&job.job, &job.ctl, &job.job.join("tmp"), &job.job.join("mpl"), &job.job.join("out")] { fs::DirBuilder::new().mode(0o700).create(dir).map_err(|_| "Private job directory unavailable")?; }
        Ok(job)
    }
}
fn number(request: &Value, key: &str, default: u64, max: u64) -> Result<u64, String> {
    match request.get(key) { None => Ok(default), Some(v) => v.as_u64().filter(|n| (1..=max).contains(n)).ok_or_else(|| format!("{key} out of range")) }
}
fn private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = OpenOptions::new().create_new(true).write(true).mode(0o600).open(path).map_err(|_| "Job file unavailable")?;
    f.write_all(bytes).map_err(|_| "Job file write failed".into())
}
fn tree_size(dir: &Path, depth: u32) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten().take(4096) {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if meta.is_file() { total = total.saturating_add(meta.len()); } else if meta.is_dir() && depth < 16 { total = total.saturating_add(tree_size(&entry.path(), depth + 1)); }
    }
    total
}
/// Only regular files directly produced in job/out (no symlinks, no hard-link surprises, bounded count/size) leave the job.
fn collect(out: &Path) -> Value {
    let (mut files, mut total, mut skipped) = (Vec::new(), 0u64, Vec::new());
    let mut names: Vec<_> = fs::read_dir(out).map(|d| d.flatten().map(|e| e.file_name()).collect()).unwrap_or_default(); names.sort();
    for name in names {
        let (path, shown) = (out.join(&name), name.to_string_lossy().into_owned());
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || meta.nlink() > 1 { skipped.push(json!({"path": shown, "why": "not a plain regular file"})); continue; }
        if files.len() >= MAX_FILES || meta.len() > MAX_FILE || total + meta.len() > MAX_RESULT_FILES_TOTAL { skipped.push(json!({"path": shown, "why": "size or count limit"})); continue; }
        let Ok(canonical) = fs::canonicalize(&path) else { continue };
        if !canonical.starts_with(out) { skipped.push(json!({"path": shown, "why": "outside job"})); continue; }
        let mut bytes = Vec::new(); if File::open(&canonical).and_then(|f| f.take(MAX_FILE + 1).read_to_end(&mut bytes)).is_err() { continue; }
        total += bytes.len() as u64; files.push(json!({"path": shown, "size": bytes.len(), "data": STANDARD.encode(&bytes)}));
    }
    json!({"files": files, "skipped": skipped})
}
use std::os::unix::fs::MetadataExt;
fn tail(path: &Path, max: usize) -> (String, bool) {
    let mut bytes = Vec::new(); let _ = File::open(path).and_then(|f| f.take(max as u64 + 1).read_to_end(&mut bytes));
    let cut = bytes.len() > max; bytes.truncate(max); (String::from_utf8_lossy(&bytes).into_owned(), cut)
}
fn emit(value: Value) { let mut out = io::stdout().lock(); let _ = writeln!(out, "{value}"); let _ = out.flush(); }

/// `embedded`: the script's bytes when the caller supplies them (the editor's tools) instead of `request.script`;
/// `on_start` receives the job's process group.
fn run(request: &Value, cancel: &Arc<AtomicBool>, embedded: Option<&[u8]>, on_start: &dyn Fn(i32)) -> Result<Value, String> {
    if request["op"] != "run" { return Err("Unknown operation".into()); }
    let interpreter = fs::canonicalize(request["interpreter"].as_str().filter(|p| Path::new(p).is_absolute()).ok_or("Interpreter must be an absolute path")?).map_err(|_| "Interpreter not found")?;
    if !fs::metadata(&interpreter).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0) { return Err("Interpreter is not an executable file".into()); }
    let kind = sandbox::kind_of(&interpreter)?; let tree = sandbox::install_tree(&interpreter)?;
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let home = fs::canonicalize(&home).unwrap_or(home);
    let extra: Vec<PathBuf> = request["extra_read"].as_array().map(|a| a.iter().map(|v| v.as_str().ok_or("Invalid extra read path".to_string()).and_then(|p| sandbox::extra_read(p, &home))).collect::<Result<_, _>>()).transpose()?.unwrap_or_default();
    if extra.len() > 32 { return Err("Too many extra read paths".into()); }
    let timeout = number(request, "timeout_s", 30, 300)?; let max_output = number(request, "max_output", 1 << 20, 8 << 20)? as usize;
    let max_job = number(request, "max_job_bytes", 64 << 20, 256 << 20)?; let max_mem = number(request, "max_memory_mb", 1024, 4096)? << 20;
    let script = match embedded { Some(bytes) => bytes.to_vec(),
        None => fs::read(request["script"].as_str().filter(|p| Path::new(p).is_absolute()).ok_or("Script must be an absolute path")?).map_err(|_| "Script unreadable")? };
    let input = request["stdin"].as_str().unwrap_or("").as_bytes();
    if script.len() > 1 << 20 { return Err("Script exceeds 1 MiB".into()); }

    let job = Job::create()?;
    let (script_name, args): (&str, &[&str]) = if kind == Kind::Python { ("script.py", &["-I", "-B"]) } else { ("script.R", &["--vanilla"]) };
    private_file(&job.job.join(script_name), &script)?; private_file(&job.ctl.join("stdin"), input)?;
    let profile = job.ctl.join("profile.sb"); private_file(&profile, sandbox::policy(kind, &interpreter, &tree, &job.job, &extra)?.as_bytes())?;
    let create = |name: &str| OpenOptions::new().create_new(true).write(true).mode(0o600).open(job.ctl.join(name)).map_err(|_| "Output capture unavailable".to_string());
    let (stdout, stderr) = (create("stdout")?, create("stderr")?);
    let nproc = sandbox::process_total() + 64;
    let id = job.root.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let tag = (kind == Kind::R).then(|| format!("LATEX_LOCAL_JOB={id}")); // only R can fork, so only R needs the lineage-independent sweep
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-f").arg(&profile).arg(&interpreter).args(args).arg(job.job.join(script_name)).current_dir(&job.job).env_clear()
        .env("PATH", "/usr/bin:/bin").env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8").env("HOME", &job.job).env("TMPDIR", job.job.join("tmp"))
        .env("MPLCONFIGDIR", job.job.join("mpl")).env("PYTHONDONTWRITEBYTECODE", "1").env("PYTHONNOUSERSITE", "1").env("LATEX_LOCAL_JOB", &id)
        .stdin(File::open(job.ctl.join("stdin")).map_err(|_| "Job input unavailable")?).stdout(stdout).stderr(stderr).process_group(0);
    unsafe { command.pre_exec(move || sandbox::limits(timeout + 5, nproc, (timeout + 5) as u32)); }
    let started = Instant::now();
    let mut child = command.spawn().map_err(|e| format!("Interpreter did not start (OS error {})", e.raw_os_error().unwrap_or(0)))?;
    let group = child.id() as i32; on_start(group);
    let (mut status, mut exit): (&str, Option<std::process::ExitStatus>) = ("ok", None);
    loop {
        let reason = if cancel.load(Ordering::Relaxed) { Some("canceled") }
            else if started.elapsed() > Duration::from_secs(timeout) { Some("timeout") }
            else if ["stdout", "stderr"].iter().any(|n| fs::metadata(job.ctl.join(n)).map_or(0, |m| m.len()) > max_output as u64) { Some("output_limit") }
            else if tree_size(&job.job, 0) > max_job { Some("job_limit") }
            else { match sandbox::group_memory(group) { Ok(b) if b > max_mem => Some("memory_limit"), Err(e) if e == "process_limit" => Some("process_limit"), _ => None } };
        if let Some(reason) = reason { status = reason; break; }
        match child.try_wait() { Ok(Some(s)) => { exit = Some(s); break; }, Ok(None) => thread::sleep(Duration::from_millis(20)), Err(_) => { status = "error"; break; } }
    }
    let found = sandbox::kill_tree(group, tag.as_deref()); let waited = child.wait().ok(); exit = exit.or(waited);
    let mut orphans = 0usize; for _ in 0..100 { orphans = sandbox::survivors(&found, group, tag.as_deref()); if orphans == 0 { break; } thread::sleep(Duration::from_millis(10)); }
    if status == "ok" && !exit.is_some_and(|s| s.success()) { status = "failed"; }
    let (out, out_cut) = tail(&job.ctl.join("stdout"), max_output); let (err, err_cut) = tail(&job.ctl.join("stderr"), max_output);
    let mut result = collect(&job.job.join("out"));
    result.as_object_mut().unwrap().extend([("ev".to_string(), json!("result")), ("status".into(), json!(status)), ("exit".into(), json!(exit.and_then(|s| s.code()))), ("signal".into(), json!(exit.and_then(|s| s.signal()))),
        ("elapsed_ms".into(), json!(started.elapsed().as_millis() as u64)), ("stdout".into(), json!(out)), ("stderr".into(), json!(err)), ("truncated".into(), json!(out_cut || err_cut)), ("orphans".into(), json!(orphans)), ("kind".into(), json!(if kind == Kind::R { "r" } else { "python" }))]);
    Ok(result)
}
fn main() {
    if std::env::args().nth(1).is_some_and(|origin| origin.starts_with("chrome-extension://")) { session::serve(); std::process::exit(0); }
    if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").is_file() { emit(json!({"ev": "result", "status": "unavailable", "reason": "A supported macOS sandbox is required"})); return; }
    let mut input = io::BufReader::new(io::stdin());
    let mut line = String::new();
    if input.by_ref().take(MAX_REQUEST).read_line(&mut line).unwrap_or(0) == 0 { emit(json!({"ev": "result", "status": "error", "reason": "No request"})); return; }
    let cancel = Arc::new(AtomicBool::new(false)); let flag = Arc::clone(&cancel);
    thread::spawn(move || { let mut next = String::new(); loop { next.clear(); match input.read_line(&mut next) { Ok(0) | Err(_) => break, Ok(_) if next.contains("\"cancel\"") => break, Ok(_) => () } } flag.store(true, Ordering::Relaxed); });
    let reply = match serde_json::from_str::<Value>(&line) { Ok(request) => run(&request, &cancel, None, &|group| emit(json!({"ev": "started", "pid": group}))), Err(_) => Err("Malformed request".into()) };
    emit(reply.unwrap_or_else(|reason| json!({"ev": "result", "status": "error", "reason": reason})));
    std::process::exit(0); // the stdin watcher may still be blocked in read
}
