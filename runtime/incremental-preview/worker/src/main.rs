use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{fs, io::{self, BufRead, BufReader, Read, Write}, os::unix::{process::CommandExt, fs::OpenOptionsExt},
    path::{Component, Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicI32, Ordering}, mpsc::{self, Receiver, RecvTimeoutError}}, thread, time::{Duration, Instant}};

static ENGINE: AtomicI32 = AtomicI32::new(0);
extern "C" fn terminate(_: i32) { unsafe { let pid = ENGINE.load(Ordering::Relaxed); if pid > 0 { libc::kill(-pid, libc::SIGKILL); } libc::_exit(0); } }

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> { v[key].as_str().ok_or_else(|| format!("missing {key}")) }
fn number(v: &Value, key: &str) -> Result<u64, String> { v[key].as_u64().filter(|n| *n < 1_000_000_000).ok_or_else(|| format!("invalid {key}")) }
fn relative(name: &str) -> Result<&Path, String> {
    let p = Path::new(name);
    if name.is_empty() || name.len() > 512 || name.contains(['\\', '\0']) || !p.components().all(|c| matches!(c, Component::Normal(_))) { return Err("invalid resource path".into()); } Ok(p)
}

fn record<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let size = reader.take(limit as u64 + 1).read_until(b'\n', &mut bytes)?;
    if size == 0 { return Ok(None); }
    if size > limit || bytes.last() != Some(&b'\n') { return Err(io::Error::new(io::ErrorKind::InvalidData, "record exceeds limit")); }
    String::from_utf8(bytes).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8"))
}
fn artifact(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).map_err(|_| "artifact unavailable")?;
    let metadata = file.metadata().map_err(|_| "artifact metadata unavailable")?;
    if !metadata.is_file() || metadata.len() > limit { return Err("artifact exceeds limit".into()); }
    let mut bytes = Vec::new(); file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "artifact read failed")?;
    if bytes.len() as u64 > limit { return Err("artifact exceeds limit".into()); } Ok(bytes)
}

// Linux Landlock confines every descendant to tool resources and its owned workspace.
unsafe fn filesystem_sandbox(work: &Path, program: &Path) -> io::Result<()> {
    #[repr(C)] struct Rules { access: u64 }
    #[repr(C, packed)] struct Beneath { access: u64, parent: i32 }
    let abi = libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0, 1);
    if abi < 3 { return Err(io::Error::other("Landlock ABI 3 is required")); }
    let rules = Rules { access: 0x7fff };
    let fd = libc::syscall(libc::SYS_landlock_create_ruleset, &rules, std::mem::size_of::<Rules>(), 0) as i32;
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let result = (|| {
        for path in ["/usr", "/lib", "/lib64", "/opt", "/bin", "/sbin", "/etc/fonts", "/etc/texmf", "/etc/ld.so.cache", "/etc/localtime", "/dev/null", "/dev/urandom"].iter().map(Path::new).chain([work, program, Path::new("/opt/texpresso/bin/texpresso-xetex"), Path::new("/usr/local/texlive/2026/bin/aarch64-linux/kpsewhich"), Path::new("/lib/ld-linux-aarch64.so.1")]) {
            if !path.exists() { continue; }
            let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(io::Error::other)?;
            let parent = libc::open(name.as_ptr(), libc::O_PATH | libc::O_CLOEXEC);
            if parent < 0 { return Err(io::Error::last_os_error()); }
            let access = if path == work { 0x7fff & !(1 | 64 | 2048) } else if [program, Path::new("/opt/texpresso/bin/texpresso-xetex"), Path::new("/usr/local/texlive/2026/bin/aarch64-linux/kpsewhich"), Path::new("/lib/ld-linux-aarch64.so.1")].contains(&path) { 5 } else if path.is_dir() { 12 } else if path == Path::new("/dev/null") { 6 } else { 4 };
            let beneath = Beneath { access, parent };
            let added = libc::syscall(libc::SYS_landlock_add_rule, fd, 1, &beneath, 0);
            libc::close(parent);
            if added != 0 { return Err(io::Error::last_os_error()); }
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || libc::syscall(libc::SYS_landlock_restrict_self, fd, 0) != 0 { return Err(io::Error::last_os_error()); }
        Ok(())
    })();
    libc::close(fd); result
}

// Checkpoints are bounded by upstream MAX_PROCESS=32 and four host sessions.
// A shared-UID RLIMIT_NPROC would also count unrelated web-service threads.
// Preserve checkpoint Unix sockets; deny networking and cross-process inspection.
unsafe fn sandbox(work: &Path, uid: u32, program: &Path) -> io::Result<()> {
    if libc::geteuid() == 0 {
        if libc::setgroups(0, std::ptr::null()) != 0 || libc::setgid(uid) != 0 || libc::setuid(uid) != 0 { return Err(io::Error::last_os_error()); }
    }
    filesystem_sandbox(work, program)?;
    if libc::setsid() < 0 { return Err(io::Error::last_os_error()); }
    for (resource, limit) in [(libc::RLIMIT_AS, 2_147_483_648), (libc::RLIMIT_NOFILE, 256), (libc::RLIMIT_CPU, 60)] {
        if libc::setrlimit(resource, &libc::rlimit { rlim_cur: limit, rlim_max: limit }) != 0 { return Err(io::Error::last_os_error()); }
    }
    let ins = |code, k, jt, jf| libc::sock_filter { code, k, jt, jf };
    let mut filter = vec![
        ins(0x20, 0, 0, 0),
    ];
    for syscall in [libc::SYS_ptrace, libc::SYS_process_vm_readv, libc::SYS_process_vm_writev, libc::SYS_pidfd_getfd, libc::SYS_setsid, libc::SYS_setpgid] {
        filter.push(ins(0x15, syscall as u32, 0, 1));
        filter.push(ins(0x06, 0x00050000 | libc::EACCES as u32, 0, 0));
    }
    filter.extend([
        ins(0x15, libc::SYS_socket as u32, 0, 4),
        ins(0x20, 16, 0, 0), // first argument: socket domain
        ins(0x15, libc::AF_UNIX as u32, 2, 0),
        ins(0x06, 0x00050000 | libc::EACCES as u32, 0, 0),
        ins(0x06, 0x7fff0000, 0, 0),
        ins(0x06, 0x7fff0000, 0, 0),
    ]);
    let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || libc::prctl(libc::PR_SET_SECCOMP, 2, &program) != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

struct Session { child: Child, input: ChildStdin, events: Receiver<Value>, root: PathBuf, active: String, source: String, revision: u64, page: Option<(u64, f64, f64)> }
impl Drop for Session { fn drop(&mut self) { unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL); } let _ = self.child.wait(); ENGINE.store(0, Ordering::Relaxed); } }
impl Session {
    fn send(&mut self, command: Value) -> Result<(), String> { writeln!(self.input, "{command}").and_then(|_| self.input.flush()).map_err(|_| "engine unavailable".into()) }
    fn start(work: &Path, request: &Value) -> Result<Self, String> {
        let project = work.join("project"); let frames = work.join("frames");
        fs::create_dir(&project).map_err(|_| "workspace exists")?; fs::create_dir(&frames).map_err(|_| "frame workspace exists")?;
        let resources = request["resources"].as_array().filter(|r| r.len() <= 1000).ok_or("invalid resources")?;
        let mut total = 0;
        for resource in resources {
            let name = text(resource, "path")?; let file = project.join(relative(name)?);
            let bytes = if let Some(content) = resource["content"].as_str() { content.as_bytes().to_vec() } else { B64.decode(text(resource, "data")?).map_err(|_| "invalid resource encoding")? };
            total += bytes.len(); if total > 64 * 1024 * 1024 || bytes.len() > 20 * 1024 * 1024 { return Err("project exceeds preview limit".into()); }
            fs::create_dir_all(file.parent().unwrap()).map_err(|_| "resource directory failed")?;
            if file.exists() { return Err("duplicate resource".into()); }
            fs::write(file, bytes).map_err(|_| "resource write failed")?;
        }
        let main = text(request, "main")?; relative(main)?;
        let active = text(request, "active")?.to_string(); let active_path = project.join(relative(&active)?);
        if !active_path.is_file() { return Err("active document not in snapshot".into()); }
        let source = text(request, "text")?.to_string(); if source.contains('\0') || source.len() > 2 * 1024 * 1024 { return Err("document exceeds preview limit".into()); }
        fs::write(&active_path, &source).map_err(|_| "candidate write failed")?;
        let uid = number(request, "uid")? as u32;
        if !(61000..61004).contains(&uid) { return Err("invalid worker slot".into()); }
        if unsafe { libc::geteuid() } == 0 {
            fn own(path: &Path, uid: u32) -> Result<(), String> {
                let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "invalid workspace path")?;
                if unsafe { libc::chown(name.as_ptr(), uid, uid) } != 0 { return Err("workspace ownership failed".into()); }
                if path.is_dir() { for entry in fs::read_dir(path).map_err(|_| "workspace read failed")?.flatten() { own(&entry.path(), uid)?; } } Ok(())
            }
            own(work, uid)?;
        }
        let mut cmd = Command::new("/opt/texpresso/bin/texpresso");
        cmd.args(["-texlive", "-json"]).arg(project.join(main)).current_dir(&project)
            .env_clear().env("PATH", "/usr/local/bin:/usr/bin:/bin").env("LC_ALL", "C.UTF-8").env("openin_any", "p").env("openout_any", "p")
            .env("SDL_VIDEODRIVER", "dummy").env("SDL_RENDER_DRIVER", "software").env("TEXPRESSO_FRAME_DIR", &frames)
            .env("TEXPRESSO_BITMAP_FONTS", "/opt/texpresso/fonts").env("HOME", work)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let sandbox_root = work.to_path_buf();
        unsafe { cmd.pre_exec(move || sandbox(&sandbox_root, uid, Path::new("/opt/texpresso/bin/texpresso"))); }
        let mut child = cmd.spawn().map_err(|error| format!("renderer startup failed: errno {}", error.raw_os_error().unwrap_or(0)))?; ENGINE.store(child.id() as i32, Ordering::Relaxed);
        let input = child.stdin.take().unwrap(); let stdout = child.stdout.take().unwrap(); let stderr = child.stderr.take().unwrap();
        let (tx, events) = mpsc::sync_channel(16); let errors = tx.clone();
        thread::spawn(move || { let mut reader = BufReader::new(stderr); while let Ok(Some(line)) = record(&mut reader, 65536) { if line.contains("No fz nor vf font") || line.contains("could not represent character") || line.contains("bitmap font resource rejected") { let _ = errors.try_send(json!({"error":"font unavailable"})); } } });
        thread::spawn(move || { let mut reader = BufReader::new(stdout); while let Ok(Some(line)) = record(&mut reader, 16 * 1024 * 1024) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) { if value[0] == "frame" || value[0] == "frame-error" || value[0] == "synctex" { if tx.send(value).is_err() { break; } } }
        } });
        let mut session = Self { child, input, events, root: work.into(), active, source, revision: 0, page: None };
        session.send(json!(["open", active_path, session.source]))?;
        session.send(json!(["browser", 0, active_path, 0, 0, "", number(request, "line")?]))?;
        Ok(session)
    }
    fn frame(&mut self, timeout: Duration) -> Result<Value, String> {
        let until = Instant::now() + timeout;
        loop {
            let message = self.events.recv_timeout(until.saturating_duration_since(Instant::now())).map_err(|error| match error { RecvTimeoutError::Timeout => "preview timed out", RecvTimeoutError::Disconnected => "renderer stopped" })?;
            if message[0] == "frame-error" || message["error"].is_string() { return Err("font unavailable; use PDF".into()); }
            if message[0] != "frame" || message[6].as_u64() != Some(self.revision) { continue; }
            let serial = message[1].as_u64().ok_or("invalid frame")?;
            let file = self.root.join("frames").join(format!("{serial}.png"));
            let png = artifact(&file, 8 * 1024 * 1024)?;
            let json_path = file.with_extension("json");
            let layer: Value = serde_json::from_slice(&artifact(&json_path, 16 * 1024 * 1024)?).map_err(|_| "text layer invalid")?;
            for entry in fs::read_dir(self.root.join("frames")).map_err(|_| "frame directory unavailable")?.flatten() { let _ = fs::remove_file(entry.path()); }
            self.page = Some((message[2].as_u64().ok_or("invalid page")?, message[3].as_f64().ok_or("invalid width")?, message[4].as_f64().ok_or("invalid height")?));
            return Ok(json!({"revision":self.revision,"page":message[2],"width":message[3],"height":message[4],"pagesRendered":message[5],"png":B64.encode(png),"text":layer}));
        }
    }
    fn jump(&mut self, request: &Value) -> Result<Value, String> {
        if number(request, "revision")? != self.revision { return Err("stale source mapping".into()); }
        let (page, width, height) = self.page.ok_or("no visible page")?;
        let x = request["x"].as_f64().ok_or("invalid x")?; let y = request["y"].as_f64().ok_or("invalid y")?;
        if number(request, "page")? != page || !x.is_finite() || !y.is_finite() || x < 0.0 || x > width || y < 0.0 || y > height { return Err("invalid coordinates".into()); }
        while self.events.try_recv().is_ok() {}
        self.send(json!(["browser-jump", page, x, y]))?;
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            let message = self.events.recv_timeout(until.saturating_duration_since(Instant::now())).map_err(|_| "source mapping unavailable")?;
            if message[0] != "synctex" { continue; }
            let path = Path::new(message[1].as_str().ok_or("invalid mapped source")?);
            let path = path.strip_prefix(self.root.join("project")).map_err(|_| "mapping outside project")?;
            let name = path.to_str().ok_or("invalid mapped path")?; relative(name)?;
            return Ok(json!({"path":name,"line":message[2],"column":message[3]}));
        }
    }
    fn update(&mut self, request: &Value) -> Result<Value, String> {
        if number(request, "base")? != self.revision || number(request, "revision")? != self.revision + 1 { return Err("stale revision".into()); }
        let offset = number(request, "offset")? as usize; let remove = number(request, "remove")? as usize; let insert = text(request, "insert")?;
        let end = offset.checked_add(remove).ok_or("invalid edit")?;
        if insert.contains('\0') || end > self.source.len() || !self.source.is_char_boundary(offset) || !self.source.is_char_boundary(end) || self.source.len() - remove + insert.len() > 2 * 1024 * 1024 { return Err("invalid edit".into()); }
        while self.events.try_recv().is_ok() {}
        self.send(json!(["browser", self.revision+1, self.root.join("project").join(&self.active), offset, remove, insert, number(request,"line")?]))?;
        self.source.replace_range(offset..end, insert); self.revision += 1;
        self.frame(Duration::from_secs(12))
    }
}
fn run() -> Result<(), String> {
    let work = PathBuf::from(std::env::args().nth(1).ok_or("workspace missing")?);
    if !work.is_absolute() || !work.is_dir() || fs::read_dir(&work).map_err(|_| "workspace unavailable")?.next().is_some() { return Err("workspace must be owned and empty".into()); }
    unsafe { libc::signal(libc::SIGTERM, terminate as libc::sighandler_t); libc::signal(libc::SIGINT, terminate as libc::sighandler_t); }
    let mut session: Option<Session> = None;
    let mut input = io::stdin().lock();
    while let Some(line) = record(&mut input, 96 * 1024 * 1024).map_err(|_| "request exceeds limit")? {
        let result = match serde_json::from_str::<Value>(&line) {
            Ok(request) => match request["op"].as_str() {
                Some("start") if session.is_none() => Session::start(&work, &request).and_then(|s| { session=Some(s); session.as_mut().unwrap().frame(Duration::from_secs(30)) }),
                Some("jump") => session.as_mut().ok_or("preview not started".into()).and_then(|s| s.jump(&request).map(|jump| json!({"jump":jump}))),
                Some("edit") => session.as_mut().ok_or("preview not started".into()).and_then(|s| s.update(&request)),
                Some("close") => break,
                _ => Err("invalid operation".into())
            }, Err(_) => Err("invalid JSON".into())
        };
        let failed = result.is_err();
        let reply = match result { Ok(frame) if frame.get("jump").is_some()=>json!({"ok":true,"jump":frame["jump"]}), Ok(frame)=>json!({"ok":true,"frame":frame}),Err(error)=>json!({"ok":false,"error":error}) };
        println!("{reply}"); io::stdout().flush().map_err(|_| "response write failed")?;
        if failed { break; }
    }
    Ok(())
}
fn main() { let work = std::env::args().nth(1); let result = run(); if let Some(work) = work { let path = Path::new(&work); if path.parent() == Some(Path::new("/var/lib/overleaf/data")) && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("live-preview-")) { let _ = fs::remove_dir_all(path); } } if result.is_err() { println!("{{\"ok\":false,\"error\":\"preview unavailable\"}}"); std::process::exit(1); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_and_artifacts_are_bounded_and_do_not_follow_links() {
        let mut input = io::Cursor::new(b"ok\nlonger\n");
        assert_eq!(record(&mut input, 3).unwrap().unwrap(), "ok\n");
        assert!(record(&mut input, 3).is_err());
        let work = std::env::temp_dir().join(format!("preview-files-{}", std::process::id()));
        fs::create_dir(&work).unwrap();
        fs::write(work.join("regular"), b"bytes").unwrap();
        std::os::unix::fs::symlink(work.join("regular"), work.join("link")).unwrap();
        assert_eq!(artifact(&work.join("regular"), 8).unwrap(), b"bytes");
        assert!(artifact(&work.join("regular"), 2).is_err());
        assert!(artifact(&work.join("link"), 8).is_err());
        assert!(relative("../outside").is_err()); assert!(relative("/outside").is_err());
        fs::remove_dir_all(work).unwrap();
    }
    #[test]
    fn sandbox_child() {
        let Some(work) = std::env::var_os("PREVIEW_SANDBOX_TEST_ROOT") else { return };
        let work = PathBuf::from(work);
        assert!(fs::read(work.with_extension("outside")).is_err());
        fs::write(work.join("inside"), b"owned").unwrap();
        assert_eq!(unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EACCES));
        std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(unsafe { libc::setsid() }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EACCES));
        for program in [Path::new("/bin/sh").to_path_buf(), work.join("blocked-exe")] {
            assert_eq!(Command::new(program).status().unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        }
    }
    #[test]
    fn sandbox_confines_descendants_without_global_uid_process_limits() {
        let work = std::env::temp_dir().join(format!("preview-sandbox-{}", std::process::id()));
        fs::create_dir(&work).unwrap(); fs::write(work.with_extension("outside"), b"outside-fixture").unwrap();
        let program = std::env::current_exe().unwrap(); fs::copy(&program, work.join("blocked-exe")).unwrap();
        let mut command = Command::new(&program);
        command.args(["--exact", "tests::sandbox_child", "--nocapture"]).env("PREVIEW_SANDBOX_TEST_ROOT", &work);
        let root = work.clone(); let executable = program.clone(); let uid = unsafe { libc::geteuid() };
        unsafe { command.pre_exec(move || sandbox(&root, uid, &executable)); }
        let result = command.status();
        fs::remove_dir_all(&work).unwrap(); fs::remove_file(work.with_extension("outside")).unwrap();
        assert!(result.unwrap().success());
    }
}
