// SPDX-License-Identifier: AGPL-3.0-only
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering}, thread, time::{Duration, Instant}};
use std::os::unix::{fs::OpenOptionsExt, process::{CommandExt, ExitStatusExt}};

pub fn validate_bin(directory: &Path) -> Result<PathBuf, String> {
    let mut candidates = vec![directory.to_path_buf(), directory.join("bin/universal-darwin"), directory.join("bin/aarch64-darwin")];
    if let Ok(entries) = fs::read_dir(directory) {
        candidates.extend(entries.flatten().filter(|entry| entry.file_name().to_str().is_some_and(|name| name.chars().all(|c| c.is_ascii_digit())))
            .map(|entry| entry.path().join("bin/universal-darwin")));
    }
    for bin in candidates {
        let Ok(engine) = fs::canonicalize(bin.join("pdflatex")) else { continue };
        let Some(canonical_bin) = engine.parent() else { continue };
        let Some(root) = canonical_bin.parent().and_then(Path::parent) else { continue };
        if root.join("texmf-dist").is_dir() && bin.join("latexmk").is_file() && bin.join("pdflatex").is_file() {
            return fs::canonicalize(bin).map_err(|_| "TeX bin folder unavailable".into());
        }
    }
    Err("Choose a TeX Live, MacTeX or TinyTeX installation containing pdflatex and latexmk".into())
}
fn read_output(path: &Path, root: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    if !fs::symlink_metadata(path).map_err(|_| "Compiler output is missing")?.file_type().is_file() ||
        !fs::canonicalize(path).map_err(|_| "Compiler output unavailable")?.starts_with(root) { return Err("Unsafe compiler output refused".into()); }
    let mut bytes = Vec::new(); File::open(path).map_err(|_| "Output unavailable")?.take(maximum + 1).read_to_end(&mut bytes).map_err(|_| "Output read failed")?;
    if bytes.len() as u64 > maximum { return Err("Compiler output exceeds supported size".into()); }
    Ok(bytes)
}
fn size(directory: &Path) -> Result<u64, String> {
    let mut total: u64 = 0;
    for entry in fs::read_dir(directory).map_err(|_| "Project directory unavailable")?.take(4097) {
        let entry = entry.map_err(|_| "Project file unavailable")?;
        let kind = entry.file_type().map_err(|_| "Project file unavailable")?;
        if kind.is_dir() { total = total.saturating_add(size(&entry.path())?); }
        else if kind.is_file() { total = total.saturating_add(entry.metadata().map_err(|_| "Project size unavailable")?.len()); }
        if total > 256 * 1024 * 1024 { break; }
    }
    Ok(total)
}
fn quote(path: &Path) -> Result<String, String> { serde_json::to_string(path.to_str().ok_or("Unsupported installation path")?).map_err(|_| "Invalid path".into()) }
fn memory(group: i32) -> Result<u64, String> {
    let mut pids = [0i32; 128];
    let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), std::mem::size_of_val(&pids) as i32) };
    if count < 0 || count as usize >= pids.len() { return Err("Compiler process limit exceeded".into()); }
    let mut bytes = 0u64;
    for pid in pids.into_iter().take(count as usize).filter(|pid| *pid > 0) {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), std::mem::size_of_val(&info) as i32) };
        if read == std::mem::size_of_val(&info) as i32 { bytes = bytes.saturating_add(info.pti_resident_size); }
        else if std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) { return Err("Compiler memory check unavailable".into()); }
    }
    Ok(bytes)
}
fn policy(root: &Path, tex_root: &Path) -> Result<String, String> {
    Ok(format!("(version 1)\n(deny default)\n(allow process-exec process-fork sysctl-read)\n(allow signal (target self) (target children))\n(allow file-read-metadata)\n(allow file-read-data (literal \"/\"))\n(allow mach-lookup (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n(allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/usr/bin\") (subpath \"/bin\") (subpath \"/Library/Fonts\") (subpath {}) (subpath {}) (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\") (literal \"/private/etc/localtime\"))\n(allow file-write* (subpath {}) (literal \"/dev/null\"))\n", quote(tex_root)?, quote(root)?, quote(root)?))
}
pub fn compile(root: &Path, bin: &Path, main: &str, compiler: &str, cancel: &AtomicBool) -> Result<(Vec<u8>, Vec<u8>, String), String> {
    if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").is_file() { return Err("A supported local compiler sandbox is required".into()); }
    let tex_root = bin.parent().and_then(Path::parent).ok_or("Invalid TeX installation")?;
    let out = root.join(".latex-local-output");
    fs::create_dir(&out).map_err(|_| "Reserved output directory conflicts with a source file")?;
    let temporary = out.join("tmp"); fs::create_dir(&temporary).map_err(|_| "Compiler temporary directory unavailable")?;
    let profile = out.join("compile.sb");
    let policy = policy(root, tex_root)?;
    fs::write(&profile, policy).map_err(|_| "Compiler confinement unavailable")?;
    let transcript = out.join("process.log");
    let log = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&transcript).map_err(|_| "Compiler log unavailable")?;
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.args(["-f"]).arg(&profile).arg(bin.join("latexmk"))
        .arg("-norc").arg(match compiler { "xelatex" => "-xelatex", "lualatex" => "-lualatex", _ => "-pdf" })
        .args(["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-synctex=1", "-cd"])
        .arg(format!("-outdir={}", out.display())).arg(root.join(main)).current_dir(root)
        .env_clear().env("PATH", format!("{}:/usr/bin:/bin", bin.display())).env("LANG", "C").env("TMPDIR", &temporary)
        .env("TEXMFOUTPUT", &out).env("TEXMFVAR", &temporary).env("TEXMFCONFIG", &temporary)
        .env("TEXMFHOME", if root.join(crate::PACKAGES).is_dir() { root.join(crate::PACKAGES) } else { temporary.clone() })
        .env("TEXMFCACHE", &temporary).env("VARTEXFONTS", &temporary).env("openin_any", "p").env("openout_any", "p")
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|_| "Log unavailable")?)).stderr(Stdio::from(log)).process_group(0);
    // Limits are inherited by TeX's trusted child tools; the parent also bounds elapsed time and total scratch growth.
    unsafe { command.pre_exec(|| {
        // macOS rejects DATA limits below inherited allocator VM reservations; the parent samples group RSS instead.
        for (resource, limit) in [(libc::RLIMIT_CPU, 60), (libc::RLIMIT_FSIZE, 32 * 1024 * 1024), (libc::RLIMIT_NOFILE, 128)] {
            let value = libc::rlimit { rlim_cur: limit, rlim_max: limit };
            if libc::setrlimit(resource, &value) != 0 { return Err(std::io::Error::last_os_error()); }
        }
        Ok(())
    }); }
    let mut child = command.spawn().map_err(|error| format!("Local compiler did not start (OS error {}). Check TeX setup.", error.raw_os_error().unwrap_or(0)))?;
    let group = child.id() as i32; let start = Instant::now();
    let result: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) { break Err("Compilation canceled. Source files are retained.".into()); }
        if start.elapsed() > Duration::from_secs(120) { break Err("Compilation exceeded two minutes. Source files are retained.".into()); }
        match size(root) { Ok(bytes) if bytes <= 256 * 1024 * 1024 => (), _ => break Err("Compilation scratch limit exceeded".into()) }
        match memory(group) { Ok(bytes) if bytes <= 1024 * 1024 * 1024 => (), Ok(_) => break Err("Compiler memory limit exceeded".into()), Err(error) => break Err(error) }
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { Ok(()) } else { Err(format!("Local TeX compilation failed (exit {}, signal {}). Check packages and source.", status.code().unwrap_or(-1), status.signal().unwrap_or(0))) },
            Ok(None) => thread::sleep(Duration::from_millis(25)), Err(_) => break Err("Compiler status unavailable".into()),
        }
    };
    unsafe { libc::kill(-group, libc::SIGKILL); } let _ = child.wait();
    result?;
    let stem = Path::new(main).file_stem().and_then(|value| value.to_str()).ok_or("Invalid main document")?;
    let pdf = read_output(&out.join(format!("{stem}.pdf")), root, 16 * 1024 * 1024)?;
    if !pdf.starts_with(b"%PDF-") { return Err("Local compiler returned invalid PDF".into()); }
    let compressed = read_output(&out.join(format!("{stem}.synctex.gz")), root, 8 * 1024 * 1024)?;
    let mut decoded = Vec::new();
    GzDecoder::new(compressed.as_slice()).take(32 * 1024 * 1024 + 1).read_to_end(&mut decoded).map_err(|_| "Invalid compiler navigation")?;
    if decoded.len() > 32 * 1024 * 1024 { return Err("Compiler navigation exceeds size limit".into()); }
    let text = String::from_utf8(decoded).map_err(|_| "Invalid compiler navigation encoding")?;
    let mut normalized = String::new();
    for line in text.lines() {
        if line.starts_with("Input:") {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() == 3 {
                let candidate = Path::new(parts[2]);
                let absolute = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(main).parent().ok_or("Invalid main path")?.join(candidate) };
                if let Ok(path) = fs::canonicalize(absolute) {
                    if let Ok(relative) = path.strip_prefix(root) { normalized.push_str(&format!("Input:{}:{}\n", parts[1], relative.display())); continue; }
                }
            }
        }
        normalized.push_str(line); normalized.push('\n');
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast()); encoder.write_all(normalized.as_bytes()).map_err(|_| "Navigation encoding failed")?;
    let synctex = encoder.finish().map_err(|_| "Navigation encoding failed")?;
    let log = String::from_utf8_lossy(&read_output(&transcript, root, 32 * 1024 * 1024)?).into_owned();
    let log = log.chars().rev().take(32000).collect::<String>().chars().rev().collect();
    Ok((pdf, synctex, log))
}

pub fn failure_log(root: &Path) -> String {
    let bytes = read_output(&root.join(".latex-local-output/process.log"), root, 32 * 1024 * 1024).unwrap_or_default();
    String::from_utf8_lossy(&bytes).chars().rev().take(32000).collect::<String>().chars().rev().collect()
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn sandbox_confines_reads_writes_and_network() {
        let files = serde_json::json!({ "files": [{ "path": "main.tex", "size": 0, "digest": "0".repeat(64) }] });
        let project = crate::Job::create(&files).unwrap();
        let outside = crate::Job::create(&files).unwrap();
        fs::write(outside.root.join("main.tex"), "SYNTHETIC PRIVATE SENTINEL").unwrap();
        let bin = crate::detected().into_iter().next().expect("This integration check needs installed TeX");
        let rules = policy(&project.root, bin.parent().unwrap().parent().unwrap()).unwrap();
        let run = |tool: &str, args: &[&std::ffi::OsStr]| Command::new("/usr/bin/sandbox-exec").args(["-p", &rules, tool]).args(args).output().unwrap();
        assert!(run("/bin/cat", &[project.root.join("main.tex").as_os_str()]).status.success());
        let denied = run("/bin/cat", &[outside.root.join("main.tex").as_os_str()]);
        assert!(!denied.status.success()); assert!(!String::from_utf8_lossy(&denied.stdout).contains("SYNTHETIC PRIVATE SENTINEL"));
        assert!(!run("/bin/sh", &["-c".as_ref(), "printf overwritten > \"$1\"".as_ref(), "check".as_ref(), outside.root.join("main.tex").as_os_str()]).status.success());
        assert_eq!(fs::read_to_string(outside.root.join("main.tex")).unwrap(), "SYNTHETIC PRIVATE SENTINEL");
        // A denied connect must report permission failure, not merely an absent listener.
        let network = run("/usr/bin/perl", &["-e".as_ref(), "use Socket; socket(my $s, AF_INET, SOCK_STREAM, 0) or exit 2; connect($s, pack_sockaddr_in(9, inet_aton('127.0.0.1'))) and exit 1; exit($!{EPERM} || $!{EACCES} ? 0 : 3)".as_ref()]);
        assert!(network.status.success(), "{}", String::from_utf8_lossy(&network.stderr));
        assert!(memory(unsafe { libc::getpgrp() }).unwrap() > 0);
    }
    /// TEX-PKG-03: a package absent from the installation compiles only when its files arrive in the job's package tree.
    #[test] fn installed_package_tree_is_used_by_the_native_compile() {
        let bin = crate::detected().into_iter().next().expect("This integration check needs installed TeX");
        let source = b"\\documentclass{article}\\usepackage{olxfixture}\\begin{document}\\olxmark\\end{document}\n".to_vec();
        let style = b"\\ProvidesPackage{olxfixture}\\newcommand\\olxmark{OLXFIXMARK}\n".to_vec();
        let run = |files: &[(&str, &Vec<u8>)]| {
            let manifest: Vec<_> = files.iter().map(|(path, bytes)| serde_json::json!({"path": path, "size": bytes.len(), "digest": format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes))})).collect();
            let mut job = crate::Job::create(&serde_json::json!({"files": manifest})).unwrap();
            for (path, bytes) in files { job.chunk(&serde_json::json!({"path": path, "offset": 0, "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)})).unwrap(); }
            job.seal().unwrap(); let start = Instant::now();
            let result = compile(&job.root, &bin, "main.tex", "pdflatex", &AtomicBool::new(false)).map(|(pdf, _, _)| pdf.len());
            (result, start.elapsed(), failure_log(&job.root))
        };
        let (without, _, log) = run(&[("main.tex", &source)]);
        assert!(without.is_err() && log.contains("olxfixture.sty"), "the package is not in the installation: {log}");
        let (with, elapsed, _) = run(&[("main.tex", &source), (".latex-local-texmf/tex/latex/olxfixture/olxfixture.sty", &style)]);
        assert!(with.unwrap() > 0); eprintln!("compile with package tree: {elapsed:?}");
    }
}
