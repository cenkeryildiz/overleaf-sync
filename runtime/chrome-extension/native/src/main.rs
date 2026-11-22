// SPDX-License-Identifier: AGPL-3.0-only
mod tex;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{self, Read, Write}, path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
const ORIGIN: &str = "chrome-extension://oekjjadnainlmdbgbdjokegaikafafke/";
const HOST: &str = "com.cenker.latex_local";
const MAX: usize = 64 * 1024 * 1024;
type Output = Arc<Mutex<io::Stdout>>;
struct Running { cancel: Arc<AtomicBool>, thread: Option<thread::JoinHandle<()>> }
impl Drop for Running {
    fn drop(&mut self) { self.cancel.store(true, Ordering::Relaxed); if let Some(thread) = self.thread.take() { let _ = thread.join(); } }
}

fn send(output: &Output, value: Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() > 900_000 { return Err(io::Error::other("Output frame too large")); }
    let mut out = output.lock().map_err(|_| io::Error::other("Output closed"))?;
    out.write_all(&(bytes.len() as u32).to_ne_bytes())?; out.write_all(&bytes)?; out.flush()
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> { value[key].as_str().ok_or_else(|| format!("Missing {key}")) }
fn safe_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(|c| c.is_control() || "\\:\"`$;&|<>".contains(c)) &&
        value.split('/').all(|part| !part.is_empty() && part != "." && part != "..") &&
        Path::new(value).components().all(|part| matches!(part, Component::Normal(_)))
}
fn settings_path() -> PathBuf {
    std::env::var_os("LATEX_LOCAL_SETTINGS").map(PathBuf::from).unwrap_or_else(||
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/LaTeX Local/settings.json"))
}
fn save_directory(directory: &Path) -> Result<Value, String> {
    let bin = tex::validate_bin(directory)?;
    let path = settings_path(); fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|_| "Settings directory unavailable")?;
    let temporary = path.with_extension("json.new");
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_| "Settings write unavailable")?;
    file.write_all(json!({"tex_directory": bin}).to_string().as_bytes()).map_err(|_| "Settings write failed")?;
    file.sync_all().map_err(|_| "Settings sync failed")?; fs::rename(temporary, path).map_err(|_| "Settings update failed")?;
    Ok(json!({"directory": bin}))
}
/// The installation the participant chose explicitly (never a guess); None until they choose one.
fn configured() -> Option<PathBuf> {
    fs::read(settings_path()).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["tex_directory"].as_str().map(PathBuf::from)).and_then(|path| tex::validate_bin(&path).ok())
}
/// Installations found in the usual places, offered for an explicit choice; nothing is selected or installed here.
fn detected() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("/Library/TeX/texbin"), PathBuf::from("/usr/texbin")];
    if let Some(paths) = std::env::var_os("PATH") { candidates.extend(std::env::split_paths(&paths)); }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    candidates.push(home.join("Library/TinyTeX/bin/universal-darwin"));
    let mut roots = vec![PathBuf::from("/usr/local/texlive")];
    if let Ok(entries) = fs::read_dir(&home) {
        roots.extend(entries.flatten().filter(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with("texlive")))
            .map(|entry| entry.path()));
    }
    for root in roots {
        candidates.push(root.join("bin/universal-darwin"));
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten().filter(|entry| entry.file_name().to_str().is_some_and(|name| name.chars().all(|c| c.is_ascii_digit()))) {
                candidates.push(entry.path().join("bin/universal-darwin"));
            }
        }
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for bin in candidates.into_iter().filter_map(|path| tex::validate_bin(&path).ok()) { if !found.contains(&bin) { found.push(bin); } }
    found
}
fn engines(bin: &Path) -> Vec<&'static str> { ["pdflatex", "xelatex", "lualatex"].into_iter().filter(|name| bin.join(name).is_file()).collect() }
struct InputFile { file: File, expected: usize, written: usize, hash: Sha256, digest: String }
pub struct Job { pub root: PathBuf, files: HashMap<String, InputFile>, total: usize }
impl Drop for Job { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
impl Job {
    fn create(value: &Value) -> Result<Self, String> {
        let entries = value["files"].as_array().filter(|files| !files.is_empty() && files.len() <= 1000).ok_or("Invalid file count")?;
        let mut random = [0u8; 16]; File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut random)).map_err(|_| "Random source unavailable")?;
        let root = std::env::temp_dir().join(format!("latex-local-{:x}", u128::from_ne_bytes(random)));
        fs::DirBuilder::new().mode(0o700).create(&root).map_err(|_| "Private project directory unavailable")?;
        let root = fs::canonicalize(root).map_err(|_| "Private directory unavailable")?;
        let mut job = Self { root, files: HashMap::new(), total: 0 };
        for entry in entries {
            let path = text(entry, "path")?;
            let size = entry["size"].as_u64().and_then(|size| usize::try_from(size).ok()).ok_or("Invalid file size")?;
            let digest = text(entry, "digest")?;
            if !safe_path(path) || job.files.contains_key(path) || digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { return Err("Invalid project file".into()); }
            job.total = job.total.checked_add(size).filter(|size| *size <= MAX).ok_or("Project exceeds 64 MB")?;
            let target = job.root.join(path);
            fs::create_dir_all(target.parent().ok_or("Invalid project path")?).map_err(|_| "Conflicting project paths")?;
            let file = OpenOptions::new().create_new(true).write(true).mode(0o600).open(target).map_err(|_| "Duplicate or invalid project path")?;
            job.files.insert(path.to_string(), InputFile { file, expected: size, written: 0, hash: Sha256::new(), digest: digest.to_string() });
        }
        Ok(job)
    }
    fn chunk(&mut self, value: &Value) -> Result<(), String> {
        let file = self.files.get_mut(text(value, "path")?).ok_or("Unknown project file")?;
        let data = text(value, "data")?;
        if data.len() > 360_000 || value["offset"].as_u64() != Some(file.written as u64) { return Err("Invalid file chunk".into()); }
        let bytes = STANDARD.decode(data).map_err(|_| "Invalid chunk encoding")?;
        if bytes.len() > file.expected - file.written { return Err("Unexpected file length".into()); }
        file.file.write_all(&bytes).map_err(|_| "Project staging write failed")?;
        file.hash.update(&bytes); file.written += bytes.len(); Ok(())
    }
    fn seal(&mut self) -> Result<(), String> {
        for file in self.files.values_mut() {
            if file.written != file.expected || format!("{:x}", file.hash.clone().finalize()) != file.digest { return Err("Incomplete or mismatched project files".into()); }
            file.file.flush().map_err(|_| "Project staging failed")?;
        }
        Ok(())
    }
}
fn install(args: &[String]) -> Result<(), String> {
    let directory = if args.get(1).map(String::as_str) == Some("--profile") {
        PathBuf::from(args.get(2).ok_or("Missing test profile")?).join("NativeMessagingHosts")
    } else { PathBuf::from(std::env::var_os("HOME").ok_or("Home unavailable")?).join("Library/Application Support/Google/Chrome/NativeMessagingHosts") };
    fs::create_dir_all(&directory).map_err(|_| "Chrome helper directory unavailable")?;
    let destination = directory.join(format!("{HOST}.json"));
    let manifest = json!({"name": HOST, "description": "Local TeX compiler for LaTeX Local", "path": std::env::current_exe().map_err(|_| "Helper path unavailable")?, "type": "stdio", "allowed_origins": [ORIGIN]});
    if destination.exists() {
        if fs::read(&destination).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).as_ref() == Some(&manifest) { println!("Local TeX helper is already registered."); return Ok(()); }
        return Err("A different helper registration already exists; preserve it before updating".into());
    }
    let mut file = OpenOptions::new().create_new(true).write(true).mode(0o600).open(destination).map_err(|_| "Helper registration failed")?;
    file.write_all(manifest.to_string().as_bytes()).map_err(|_| "Helper registration failed")?;
    println!("Local TeX helper registered. Return to the extension and check TeX setup."); Ok(())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--install") { if install(&args).is_err() { eprintln!("Helper registration failed; existing files were preserved"); std::process::exit(1); } return; }
    if args.first().map(String::as_str) != Some(ORIGIN) { eprintln!("Unrecognized extension origin"); std::process::exit(1); }
    if serve().is_err() { eprintln!("Local TeX helper disconnected"); std::process::exit(1); }
}
fn serve() -> Result<(), String> {
    let output: Output = Arc::new(Mutex::new(io::stdout()));
    let mut input = io::stdin().lock(); let mut stage: Option<Job> = None;
    let mut running: Option<Running> = None;
    loop {
        let mut header = [0; 4];
        match input.read_exact(&mut header) { Ok(()) => (), Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break, Err(_) => return Err("Input closed".into()) }
        let length = u32::from_ne_bytes(header) as usize;
        if length == 0 || length > 1_000_000 { return Err("Invalid frame length".into()); }
        let mut bytes = vec![0; length]; input.read_exact(&mut bytes).map_err(|_| "Incomplete frame")?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid message")?;
        let id = value["id"].as_u64().ok_or("Invalid request ID")?;
        // Checked after the frame arrives: a compile that ended while this loop waited must not block the next one.
        if running.as_ref().is_some_and(|job| job.thread.as_ref().is_some_and(|thread| thread.is_finished())) { running = None; }
        let result: Result<Value, String> = (|| {
            match text(&value, "op")? {
                "status" => { let directory = configured(); Ok(json!({"directory": directory, "engines": directory.as_deref().map(engines).unwrap_or_default(),
                    "detected": detected(), "sandbox": Path::new("/usr/bin/sandbox-exec").exists()})) },
                "select" => { // an explicit choice from the detected list or a typed folder
                    if running.is_some() { return Err("Stop compilation before choosing TeX".into()); }
                    let path = Path::new(text(&value, "path")?);
                    if !path.is_absolute() { return Err("Choose a full folder path".into()); }
                    save_directory(path)
                },
                "choose" => {
                    if running.is_some() { return Err("Stop compilation before choosing TeX".into()); }
                    let selected = std::process::Command::new("/usr/bin/osascript").args(["-e", "POSIX path of (choose folder with prompt \"Choose your TeX installation or its bin folder\")"]).output().map_err(|_| "Folder picker unavailable")?;
                    if !selected.status.success() { return Err("TeX selection canceled".into()); }
                    save_directory(Path::new(String::from_utf8_lossy(&selected.stdout).trim()))
                },
                "begin" => { if running.is_some() { return Err("Compilation already running".into()); } stage = Some(Job::create(&value)?); Ok(json!({"ready": true})) },
                "chunk" => { stage.as_mut().ok_or("No staged project")?.chunk(&value)?; Ok(json!({"saved": true})) },
                "cancel" => { if let Some(job) = &running { job.cancel.store(true, Ordering::Relaxed); } stage = None; Ok(json!({"canceled": true})) },
                "compile" => {
                    if running.is_some() { return Err("Compilation already running".into()); }
                    let bin = configured().ok_or("Choose a TeX installation under This computer first")?;
                    let mut job = stage.take().ok_or("No staged project")?; job.seal()?;
                    let main = text(&value, "main")?.to_string();
                    if !safe_path(&main) || !job.files.contains_key(&main) { return Err("Invalid main source".into()); }
                    let compiler = text(&value, "compiler")?.to_string();
                    if !engines(&bin).contains(&compiler.as_str()) { return Err(format!("The chosen TeX installation has no {compiler}")); }
                    let cancel = Arc::new(AtomicBool::new(false)); let flag = Arc::clone(&cancel); let out = Arc::clone(&output);
                    running = Some(Running { cancel, thread: Some(thread::spawn(move || {
                        match tex::compile(&job.root, &bin, &main, &compiler, &flag) {
                            Ok((pdf, synctex, log)) => {
                                for (kind, bytes) in [("pdf", pdf), ("synctex", synctex)] {
                                    for (part, bytes) in bytes.chunks(256 * 1024).enumerate() { if send(&out, json!({"id": id, "part": kind, "offset": part * 256 * 1024, "data": STANDARD.encode(bytes)})).is_err() { return; } }
                                }
                                let _ = send(&out, json!({"id": id, "done": true, "log": log}));
                            },
                            Err(error) => { let _ = send(&out, json!({"id": id, "error": error, "log": tex::failure_log(&job.root)})); }
                        }
                    })) });
                    return Ok(Value::Null);
                },
                _ => Err("Unknown local TeX operation".into()),
            }
        })();
        match result {
            Ok(value) if !value.is_null() => { send(&output, json!({"id": id, "result": value})).map_err(|_| "Output closed")?; },
            Err(error) => { send(&output, json!({"id": id, "error": error})).map_err(|_| "Output closed")?; }, _ => (),
        }
    }
    drop(running);
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn paths_cannot_escape_the_private_copy() {
        for path in ["/secret", "../secret", "a/../b", "a\\b", "a//b", "a:b", "a\0b", ".", "$(command).tex", "`command`.tex", "a\".tex", "a;b.tex"] { assert!(!safe_path(path)); }
        assert!(safe_path("chapters/Türkçe notes.tex"));
    }
    #[test] fn only_an_explicit_valid_choice_is_used() {
        let dir = std::env::temp_dir().join(format!("latex-local-settings-{}", std::process::id())); fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LATEX_LOCAL_SETTINGS", dir.join("settings.json"));
        assert!(configured().is_none(), "nothing is chosen until the participant chooses");
        assert!(save_directory(&dir).is_err(), "a folder without pdflatex/latexmk/texmf-dist is refused");
        if let Some(bin) = detected().into_iter().next() {
            assert_eq!(save_directory(&bin).unwrap()["directory"], json!(bin)); assert_eq!(configured(), Some(bin.clone()));
            assert!(engines(&bin).contains(&"pdflatex"));
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn staged_source_requires_exact_lengths_and_hashes() {
        let digest = format!("{:x}", Sha256::digest(b"source"));
        let mut job = Job::create(&json!({"files": [{"path":"main.tex","size":6,"digest":digest}]})).unwrap();
        assert!(job.seal().is_err());
        assert!(job.chunk(&json!({"path":"main.tex","offset":1,"data":STANDARD.encode(b"source")})).is_err());
        job.chunk(&json!({"path":"main.tex","offset":0,"data":STANDARD.encode(b"source")})).unwrap();
        assert!(job.seal().is_ok());
    }
}
