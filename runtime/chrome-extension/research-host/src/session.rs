// SPDX-License-Identifier: AGPL-3.0-only
//! Native-messaging mode (host com.cenker.latex_research; Chrome starts it with the extension origin as argument).
//! Reached only from the packaged extension page, whose UI calls are the person at this computer (see discover.rs trust
//! boundary). Offers the device-local selection ops and at most ONE confined Jupyter session per connection (DOCEXEC-01):
//! kernel.py (the selected environment's installed jupyter_client) and the selected kernel run together under
//! `sandbox::kernel_policy`: reads only system paths, both interpreters' trees, the kernelspec and a private job directory;
//! writes only the job; no network except this session's five loopback ZMQ ports; cleared environment; memory and job
//! size limits; the whole process tree is killed when the session or the connection ends. The kernel connection file
//! (key, ports) is written by kernel.py inside the job and never leaves it.
//! Protocol (as lan-host.mjs `nativeHelper`): {id, op, ...} -> {id, result} | {id, error}; events {ev, ...} carry no id.
use crate::{discover as d, private_file, sandbox, tree_size, Job};
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, net::TcpListener, os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

const KERNEL_PY: &str = include_str!("../../../research/kernel.py");
/// The editor's script tools (MATH-CHECK-01 / ANALYSIS-01): packaged scripts only, the request travels on stdin.
const TOOLS: [(&str, &str, d::Feature); 3] = [("math", include_str!("../../../math-check/mathcheck.py"), d::Feature::MathCheck),
    ("python", include_str!("../../../research/analysis.py"), d::Feature::PythonAnalysis), ("r", include_str!("../../../research/analysis.R"), d::Feature::RAnalysis)];
const MAX_IN: usize = 4 << 20;         // a run carries at most 1 MiB of code (kernel.py refuses more)
const MAX_OUT: usize = 1_000_000;      // Chrome's limit for one host-to-browser message is 1 MB
const MAX_LINE: u64 = 8 << 20;
const MEMORY: u64 = 2048 << 20;
const MAX_JOB: u64 = 256 << 20;
const RUN_TIMEOUT_MAX: u64 = 300;

static STDOUT: Mutex<()> = Mutex::new(());
fn send(value: &Value) {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    if bytes.len() > MAX_OUT { bytes = serde_json::to_vec(&json!({"id": value.get("id"), "error": "This result is too large to show (over 1 MB)"})).unwrap_or_default(); }
    let _guard = STDOUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = io::stdout().lock();
    let _ = out.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|_| out.write_all(&bytes)).and_then(|_| out.flush());
}
/// None ends the connection: EOF, or a frame that cannot be trusted to resynchronize.
fn receive(input: &mut impl Read) -> Option<Result<Value, String>> {
    let mut len = [0u8; 4]; input.read_exact(&mut len).ok()?;
    let len = u32::from_le_bytes(len) as usize; if len > MAX_IN { return None; }
    let mut body = vec![0u8; len]; input.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice::<Value>(&body).ok().filter(Value::is_object).ok_or_else(|| "Malformed request".to_string()))
}
fn home_relative(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) { Ok(rest) if home.components().count() > 1 => format!("~/{}", rest.display()), _ => path.display().to_string() }
}
/// Jupyter's own search order for the selected environment: the user's kernels, then that environment's, then the rest.
fn roots_for(base: &d::Roots, rec: &d::Record) -> d::Roots {
    let mut roots = base.clone();
    if let Some(prefix) = rec.python.as_ref().and_then(|p| p.path.parent()?.parent().map(Path::to_path_buf)) { roots.kernel_dirs.insert(1.min(roots.kernel_dirs.len()), prefix.join("share/jupyter/kernels")); }
    roots
}
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64) }

/// `waiting`: ids sent to kernel.py and not yet answered; answered with an error when the session ends, so no call hangs.
struct Kernel { child: Child, stdin: Option<ChildStdin>, group: i32, marker: String, project: String, ended: Arc<AtomicBool>, waiting: Arc<Mutex<Vec<Value>>>, _job: Job }
impl Kernel {
    fn write(&mut self, value: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("The kernel has stopped; run the cell again to start it")?;
        if let Some(id) = value.get("id").filter(|id| !id.is_null()) { self.waiting.lock().unwrap_or_else(|e| e.into_inner()).push(id.clone()); }
        writeln!(stdin, "{value}").and_then(|_| stdin.flush()).map_err(|_| "The kernel has stopped; run the cell again to start it".into())
    }
}
impl Drop for Kernel {
    /// Graceful first (kernel.py shuts its kernel down on stdin EOF), then the whole tree, then the job directory.
    fn drop(&mut self) {
        drop(self.stdin.take());
        for _ in 0..150 { if !matches!(self.child.try_wait(), Ok(None)) { break; } /* Err: already reaped by the reader */ thread::sleep(Duration::from_millis(20)); }
        let found = sandbox::kill_tree(self.group, Some(&self.marker)); let _ = self.child.wait();
        for _ in 0..100 { if sandbox::survivors(&found, self.group, Some(&self.marker)) == 0 { break; } thread::sleep(Duration::from_millis(10)); }
    }
}

fn free_ports() -> Result<Vec<u16>, String> {
    let listeners: Vec<TcpListener> = (0..5).map(|_| TcpListener::bind("127.0.0.1:0")).collect::<Result<_, _>>().map_err(|_| "No free loopback port")?;
    listeners.iter().map(|l| l.local_addr().map(|a| a.port()).map_err(|_| "No free loopback port".to_string())).collect()
}

fn start(rec: &d::Record, roots: &d::Roots, project: &str, id: &Value) -> Result<Kernel, String> {
    if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").is_file() { return Err("Running cells needs the macOS sandbox, which is not available on this computer".into()); }
    let python = d::authorize(rec, roots, d::Feature::Jupyter, project)?;
    let pick = rec.kernel.as_ref().ok_or("No Jupyter kernel is selected")?;
    let spec = d::read_kernel(roots, &pick.dir)?;
    let kind = if spec.language == "r" { sandbox::Kind::R } else { sandbox::Kind::Python };
    let (broker, kernel) = (sandbox::Launch::of(&python, sandbox::Kind::Python)?, sandbox::Launch::of(Path::new(&spec.argv[0]), kind)?);
    let spec_dir = fs::canonicalize(&spec.dir).map_err(|_| "The kernelspec folder is missing")?;
    let ports = free_ports()?;
    let job = Job::create()?;
    let script = job.job.join("kernel.py"); private_file(&script, KERNEL_PY.as_bytes())?;
    let profile = job.ctl.join("profile.sb"); private_file(&profile, sandbox::kernel_policy(&broker, &kernel, &spec_dir, &job.job, &ports)?.as_bytes())?;
    for dir in ["ipython", "jupyter"] { fs::create_dir(job.job.join(dir)).map_err(|_| "Private job directory unavailable")?; }
    let stderr = OpenOptions::new().create_new(true).write(true).mode(0o600).open(job.ctl.join("stderr")).map_err(|_| "Output capture unavailable")?;
    let marker = job.root.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let nproc = sandbox::process_total() + 64;
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-f").arg(&profile).arg(&broker.path).args(["-I", "-B"]).arg(&script).current_dir(&job.job).env_clear()
        .env("PATH", "/usr/bin:/bin").env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8").env("HOME", &job.job).env("TMPDIR", job.job.join("tmp"))
        .env("MPLCONFIGDIR", job.job.join("mpl")).env("IPYTHONDIR", job.job.join("ipython")).env("JUPYTER_CONFIG_DIR", job.job.join("jupyter"))
        .env("JUPYTER_DATA_DIR", job.job.join("jupyter")).env("JUPYTER_RUNTIME_DIR", job.job.join("tmp")).env("PYTHONNOUSERSITE", "1").env("LATEX_LOCAL_JOB", &marker)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).process_group(0);
    if std::env::var_os("LATEX_RESEARCH_DEBUG").is_some() { command.stderr(Stdio::inherit()); } else { command.stderr(stderr); } // kernel.py tracebacks, for diagnosis only
    unsafe { command.pre_exec(move || sandbox::limits(3600, nproc, 0)); }
    let mut child = command.spawn().map_err(|e| format!("The kernel did not start (OS error {})", e.raw_os_error().unwrap_or(0)))?;
    let group = child.id() as i32; let ended = Arc::new(AtomicBool::new(false)); let reason: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(None));
    let waiting: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let stdout = child.stdout.take().ok_or("Kernel output unavailable")?;
    { // reader: kernel.py replies {id, status, ...} become {id, result}; anything that is not one JSON object per line is dropped
        let (ended, reason, marker, waiting) = (Arc::clone(&ended), Arc::clone(&reason), marker.clone(), Arc::clone(&waiting));
        thread::spawn(move || {
            let mut lines = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match (&mut lines).take(MAX_LINE).read_until(b'\n', &mut line) { Ok(0) | Err(_) => break, Ok(_) => {} }
                if !line.ends_with(b"\n") { *reason.lock().unwrap_or_else(|e| e.into_inner()) = Some("output_limit"); sandbox::kill_tree(group, Some(&marker)); break; }
                if let Ok(Value::Object(mut reply)) = serde_json::from_slice::<Value>(&line) {
                    let id = reply.remove("id").unwrap_or(Value::Null);
                    waiting.lock().unwrap_or_else(|e| e.into_inner()).retain(|w| *w != id);
                    send(&json!({"id": id, "result": Value::Object(reply)}));
                }
            }
            unsafe { libc::waitpid(group, std::ptr::null_mut(), 0); } // reap kernel.py now: a zombie would look alive until the next start
            ended.store(true, Ordering::SeqCst);
            let why = reason.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or("stopped");
            for id in waiting.lock().unwrap_or_else(|e| e.into_inner()).drain(..) { send(&json!({"id": id, "error": format!("The kernel stopped ({})", why.replace('_', " "))})); }
            send(&json!({"ev": "ended", "reason": why}));
        });
    }
    { // monitor: memory of the whole tree (the kernel leaves the process group) and job size
        let (ended, reason, marker, dir) = (Arc::clone(&ended), Arc::clone(&reason), marker.clone(), job.job.clone());
        thread::spawn(move || while !ended.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(250));
            let over = if sandbox::memory_of(&sandbox::tree_pids(group)).is_ok_and(|b| b > MEMORY) { Some("memory_limit") } else if tree_size(&dir, 0) > MAX_JOB { Some("job_limit") } else { None };
            if let Some(why) = over { *reason.lock().unwrap_or_else(|e| e.into_inner()) = Some(why); sandbox::kill_tree(group, Some(&marker)); break; }
        });
    }
    let mut session = Kernel { stdin: child.stdin.take(), child, group, marker, project: project.to_string(), ended, waiting, _job: job };
    session.write(&json!({"id": id, "op": "start", "kernel": spec.name, "spec_dir": spec_dir, "ports": ports}))?;
    Ok(session)
}

fn status(rec: &d::Record, roots: &d::Roots, project: Option<&str>) -> Value {
    let disc = d::discover(roots, true);
    let runtime = |rt: &d::Runtime| { let selected = [&rec.python, &rec.r].into_iter().flatten().any(|s| s.path == rt.id.path); json!({"path": rt.id.path, "label": home_relative(&rt.id.path, &roots.home), "version": rt.version,
        "selected": selected,
        "support": d::runtime_support(rt).into_iter().map(|(f, r)| (f.name().to_string(), json!(r.err()))).collect::<serde_json::Map<_, _>>()}) };
    let kind = |k: d::Kind| disc.runtimes.iter().filter(|r| r.kind == k).map(runtime).collect::<Vec<_>>();
    let kernels: Vec<Value> = disc.kernels.iter().map(|k| json!({"name": k.name, "display": k.display_name, "language": k.language, "usable": k.usable(),
        "interpreter": k.argv.first().map(|p| home_relative(Path::new(p), &roots.home)),
        "reason": (!k.usable()).then(|| k.problems.iter().cloned().chain(k.unavailable.clone()).collect::<Vec<_>>().join("; ")),
        "selected": rec.kernel.as_ref().is_some_and(|p| p.name == k.name)})).collect();
    let features: serde_json::Map<_, _> = d::Feature::ALL.into_iter().map(|f| (f.name().to_string(),
        json!({"on": rec.enabled.contains(&f), "ready": d::ready(rec, roots, f).err().map_or(json!(true), |e| json!(e))}))).collect();
    json!({"sandbox": cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file(), "python": kind(d::Kind::Python), "r": kind(d::Kind::R), "kernels": kernels,
        "features": features, "consent": project.map(|p| d::has_consent(rec, p)), "notes": disc.notes.iter().map(|n| n.replace(&roots.home.display().to_string(), "~")).collect::<Vec<_>>()})
}

/// One packaged tool script through the confined one-shot runner (`crate::run`), on a thread so Stop can reach it.
/// The script's last JSON line is the result. Only `{"op":"version"}` (a readiness probe with no project content) runs
/// without project consent; it still needs a verified, ready selection.
fn script(request: &Value, roots: &d::Roots, store: &d::Store, busy: &Arc<Mutex<Option<Arc<AtomicBool>>>>) -> Result<Option<Value>, String> {
    let tool = request.get("tool").and_then(Value::as_str).unwrap_or("");
    let &(_, source, feature) = TOOLS.iter().find(|(name, _, _)| *name == tool).ok_or("Unknown tool")?;
    let input = request.get("request").filter(|r| r.is_object()).ok_or("Missing request")?;
    let rec = store.load()?;
    let interpreter = if *input == json!({"op": "version"}) { d::ready(&rec, roots, feature)? }
        else { d::authorize(&rec, roots, feature, request.get("project").and_then(Value::as_str).ok_or("Missing project")?)? };
    let cancel = Arc::new(AtomicBool::new(false));
    { let mut slot = busy.lock().unwrap_or_else(|e| e.into_inner()); if slot.is_some() { return Err("Another check or analysis is still running".into()); } *slot = Some(Arc::clone(&cancel)); }
    let job = json!({"op": "run", "interpreter": interpreter, "stdin": input.to_string(), "timeout_s": request.get("timeout").and_then(Value::as_u64).unwrap_or(60).clamp(1, RUN_TIMEOUT_MAX)});
    let (id, busy) = (request["id"].clone(), Arc::clone(busy));
    thread::spawn(move || {
        let reply = match crate::run(&job, &cancel, Some(source.as_bytes()), &|_| {}) {
            Ok(out) => { let parsed = out["stdout"].as_str().and_then(|t| t.trim().lines().last()).and_then(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object);
                match parsed { Some(mut value) => { if out["files"].as_array().is_some_and(|f| !f.is_empty()) { value["files"] = out["files"].clone(); } json!({"id": id, "result": value}) },
                    None => json!({"id": id, "result": {"status": if out["status"] == "ok" { json!("error") } else { out["status"].clone() }, "reason": format!("The tool stopped ({})", out["status"].as_str().unwrap_or("failed"))}}) } },
            Err(error) => json!({"id": id, "error": error}),
        };
        *busy.lock().unwrap_or_else(|e| e.into_inner()) = None; send(&reply);
    });
    Ok(None)
}

fn handle(request: &Value, base: &d::Roots, store: &d::Store, kernel: &mut Option<Kernel>, busy: &Arc<Mutex<Option<Arc<AtomicBool>>>>) -> Result<Option<Value>, String> {
    let roots = &roots_for(base, &store.load()?);
    let text = |key: &str| request.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing {key}"));
    let project = || text("project").map(str::to_string);
    let save = |change: &dyn Fn(&mut d::Record) -> Result<(), String>| -> Result<Option<Value>, String> { let mut rec = store.load()?; change(&mut rec)?; store.save(&rec)?; Ok(Some(json!({"ok": true}))) };
    match request.get("op").and_then(Value::as_str).unwrap_or("") {
        "status" => Ok(Some(status(&store.load()?, roots, request.get("project").and_then(Value::as_str)))),
        "select" => { let kind = match text("kind")? { "python" => d::Kind::Python, "r" => d::Kind::R, _ => return Err("Unknown runtime kind".into()) }; let path = PathBuf::from(text("path")?);
            save(&|rec| { d::select_runtime(rec, &d::discover(roots, false), kind, &path)?;
                // the same kernel name may now resolve to the new environment's kernelspec: never keep a pick from another one
                let now = d::discover(&roots_for(base, rec), false);
                if rec.kernel.as_ref().is_some_and(|p| !now.kernels.iter().any(|k| k.name == p.name && k.dir == p.dir)) { rec.kernel = None; }
                Ok(()) }) },
        "kernel" => { let name = text("name")?.to_string(); save(&|rec| d::select_kernel(rec, &d::discover(roots, false), &name)) },
        "feature" => { let f = d::Feature::from_name(text("name")?).ok_or("Unknown feature")?; let on = request.get("on").and_then(Value::as_bool).ok_or("Missing on")?;
            if !on && f == d::Feature::Jupyter { *kernel = None; }
            save(&|rec| d::set_feature(rec, roots, f, on)) },
        "consent" => { let (p, granted) = (project()?, request.get("granted").and_then(Value::as_bool).ok_or("Missing granted")?);
            if !granted && kernel.as_ref().is_some_and(|k| k.project == p) { *kernel = None; }
            save(&|rec| d::set_consent(rec, &p, granted, now())) },
        "start" => {
            if kernel.as_ref().is_some_and(|k| !k.ended.load(Ordering::SeqCst)) { return Err("A kernel is already running".into()); }
            *kernel = None; *kernel = Some(start(&store.load()?, roots, &project()?, &request["id"])?); Ok(None) // kernel.py answers with this id
        },
        "run" => {
            let k = kernel.as_mut().filter(|k| !k.ended.load(Ordering::SeqCst)).ok_or("No kernel is running; run the cell again to start it")?;
            if project()? != k.project { return Err("This kernel belongs to another project".into()); }
            d::authorize(&store.load()?, roots, d::Feature::Jupyter, &k.project)?; // toggle, consent and identities re-checked on every run
            let timeout = request.get("timeout").and_then(Value::as_u64).unwrap_or(30).clamp(1, RUN_TIMEOUT_MAX);
            k.write(&json!({"id": request["id"], "op": "run", "cell": request["cell"], "code": request["code"], "seed": request.get("seed"), "timeout": timeout}))?; Ok(None)
        },
        "interrupt" => { if let Some(k) = kernel.as_mut() { let _ = k.write(&json!({"op": "interrupt"})); } Ok(Some(json!({"ok": true}))) },
        "restart" => { let k = kernel.as_mut().filter(|k| !k.ended.load(Ordering::SeqCst)).ok_or("No kernel is running")?; k.write(&json!({"id": request["id"], "op": "restart"}))?; Ok(None) },
        "script" => script(request, roots, store, busy),
        "cancel-script" => { if let Some(flag) = busy.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { flag.store(true, Ordering::SeqCst); } Ok(Some(json!({"ok": true}))) },
        "shutdown" => { *kernel = None; Ok(Some(json!({"ok": true}))) },
        _ => Err("Unknown operation".into()),
    }
}

pub fn serve() {
    let roots = d::Roots::system(); let store = d::Store::from_env(&roots.home);
    let mut kernel: Option<Kernel> = None; let mut input = io::stdin().lock(); let busy = Arc::new(Mutex::new(None));
    while let Some(request) = receive(&mut input) {
        let request = match request { Ok(r) => r, Err(e) => { send(&json!({"ev": "error", "error": e})); continue; } };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        match handle(&request, &roots, &store, &mut kernel, &busy) {
            Ok(Some(result)) => send(&json!({"id": id, "result": result})),
            Ok(None) => {},
            Err(error) => send(&json!({"id": id, "error": error})),
        }
    }
    if let Some(flag) = busy.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { flag.store(true, Ordering::SeqCst); }
    drop(kernel); // the page closed the port: nothing outlives it
    for _ in 0..300 { if busy.lock().unwrap_or_else(|e| e.into_inner()).is_none() { break; } thread::sleep(Duration::from_millis(10)); } // a canceled tool cleans up its job
}
