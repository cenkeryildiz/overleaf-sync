// SPDX-License-Identifier: AGPL-3.0-only
//! Confinement policy and process accounting for one research job. Pattern reused from native/src/tex.rs
//! (sandbox-exec deny-default profile, cleared environment, process-group kill, RSS sampling by group);
//! differences: metadata reads are limited to ancestors of allowed paths, network is denied explicitly, and
//! Python gets no fork permission at all.
use std::{collections::BTreeSet, fs, io, path::{Path, PathBuf}};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { Python, R }

/// Programs R's own launcher script runs (sh -> bash, uname, sed, dirname, basename, rm); nothing else may be executed.
const R_LAUNCHER: [&str; 7] = ["/bin/sh", "/bin/bash", "/bin/rm", "/usr/bin/uname", "/usr/bin/sed", "/usr/bin/dirname", "/usr/bin/basename"];
const SYSTEM_READ: [&str; 4] = ["/System", "/usr/lib", "/usr/share", "/Library/Fonts"];
const DEVICES: [&str; 3] = ["/dev/null", "/dev/random", "/dev/urandom"];

fn q(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("Unsupported path")?;
    if text.is_empty() || text.chars().any(|c| c.is_control() || c == '"' || c == '\\') { return Err("Unsupported character in path".into()); }
    Ok(format!("\"{text}\""))
}
pub fn kind_of(interpreter: &Path) -> Result<Kind, String> {
    let name = interpreter.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name == "Rscript" { Ok(Kind::R) }
    else if name.starts_with("python") && name[6..].chars().all(|c| c.is_ascii_digit() || c == '.') { Ok(Kind::Python) }
    else { Err("Interpreter must be python or Rscript".into()) }
}
/// The interpreter's own installation: an environment root (the parent of bin/) or an R.framework.
pub fn install_tree(canonical: &Path) -> Result<PathBuf, String> {
    let mut root = PathBuf::new();
    for part in canonical.components() {
        root.push(part);
        if part.as_os_str() == "R.framework" { return Ok(root); }
    }
    let bin = canonical.parent().filter(|b| b.file_name().is_some_and(|n| n == "bin")).ok_or("Unrecognized interpreter layout")?;
    let tree = bin.parent().ok_or("Unrecognized interpreter layout")?;
    if tree.components().count() < 3 { return Err("Interpreter installation is too broad to grant".into()); }
    Ok(tree.to_path_buf())
}
/// An explicit extra read-only data file or directory: canonical, deep enough, never the user's home or one of its parents.
pub fn extra_read(path: &str, home: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| "Extra read path does not exist")?;
    if canonical.components().count() < 4 || home.starts_with(&canonical) || canonical.starts_with("/System") || canonical.starts_with("/private/etc") { return Err("Extra read path is too broad".into()); }
    Ok(canonical)
}
fn ancestors(paths: &[&Path]) -> BTreeSet<PathBuf> {
    let mut found = BTreeSet::new();
    for path in paths { let mut at = path.parent(); while let Some(p) = at { if p == Path::new("/") { break; } found.insert(p.to_path_buf()); at = p.parent(); } }
    found
}
pub fn policy(kind: Kind, interpreter: &Path, tree: &Path, job: &Path, extra: &[PathBuf]) -> Result<String, String> {
    let mut read: Vec<String> = SYSTEM_READ.iter().map(|p| format!("(subpath \"{p}\")")).collect();
    read.extend(DEVICES.iter().map(|p| format!("(literal \"{p}\")")));
    read.extend(["(literal \"/private/etc/localtime\")".to_string(), "(subpath \"/private/var/select\")".to_string(), format!("(subpath {})", q(tree)?), format!("(subpath {})", q(job)?)]);
    let mut anchors: Vec<&Path> = vec![interpreter, tree, job];
    for path in extra { read.push(format!("({} {})", if path.is_dir() { "subpath" } else { "literal" }, q(path)?)); anchors.push(path); }
    let mut exec = format!("(literal {})", q(interpreter)?);
    if kind == Kind::R {
        exec.push_str(&format!(" (subpath {})", q(tree)?));
        for p in R_LAUNCHER { exec.push_str(&format!(" (literal \"{p}\")")); read.push(format!("(literal \"{p}\")")); }
    }
    let meta: Vec<String> = ancestors(&anchors).iter().map(|p| q(p).map(|s| format!("(literal {s})"))).collect::<Result<_, _>>()?;
    Ok(format!("(version 1)\n(deny default)\n(allow process-exec {exec})\n{}(allow sysctl-read)\n(allow signal (target self){})\n\
(allow file-read-metadata {} {})\n(allow file-read-data (literal \"/\"))\n\
(allow mach-lookup (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n\
(allow file-read* {})\n(allow file-write* (subpath {}) (literal \"/dev/null\"))\n(deny network*)\n",
        if kind == Kind::R { "(allow process-fork)\n" } else { "" }, if kind == Kind::R { " (target children)" } else { "" },
        meta.join(" "), read.join(" "), read.join(" "), q(job)?))
}

/// One interpreter a kernel session launches: the listed path, its canonical file and its installation tree.
pub struct Launch { pub path: PathBuf, pub canonical: PathBuf, pub tree: PathBuf, pub kind: Kind }
impl Launch {
    pub fn of(listed: &Path, kind: Kind) -> Result<Launch, String> {
        let canonical = fs::canonicalize(listed).map_err(|_| "Interpreter not found")?;
        Ok(Launch { path: listed.to_path_buf(), tree: install_tree(&canonical)?, canonical, kind })
    }
}
/// Kernel session (DOCEXEC-01): the broker (kernel.py on the selected Python) and the kernel it launches share one
/// deny-default profile. Same reads as `policy` plus the kernel's tree and kernelspec; both may fork (jupyter_client
/// spawns the kernel). Network: everything denied except the five loopback ports this session's ZMQ channels use.
pub fn kernel_policy(broker: &Launch, kernel: &Launch, spec: &Path, job: &Path, ports: &[u16]) -> Result<String, String> {
    let mut read: Vec<String> = SYSTEM_READ.iter().map(|p| format!("(subpath \"{p}\")")).collect();
    read.extend(DEVICES.iter().map(|p| format!("(literal \"{p}\")")));
    read.extend(["(literal \"/private/etc/localtime\")".to_string(), "(subpath \"/private/var/select\")".to_string()]);
    for tree in [&broker.tree, &kernel.tree, &spec.to_path_buf(), &job.to_path_buf()] { read.push(format!("(subpath {})", q(tree)?)); }
    let mut exec: Vec<String> = [&broker.path, &broker.canonical, &kernel.path, &kernel.canonical].iter().map(|p| q(p).map(|s| format!("(literal {s})"))).collect::<Result<_, _>>()?;
    if kernel.kind == Kind::R {
        exec.push(format!("(subpath {})", q(&kernel.tree)?));
        for p in R_LAUNCHER { exec.push(format!("(literal \"{p}\")")); read.push(format!("(literal \"{p}\")")); }
    }
    let anchors: Vec<&Path> = vec![&broker.canonical, &broker.path, &kernel.canonical, &kernel.path, &broker.tree, &kernel.tree, spec, job];
    let meta: Vec<String> = ancestors(&anchors).iter().map(|p| q(p).map(|s| format!("(literal {s})"))).collect::<Result<_, _>>()?;
    if ports.len() != 5 || ports.iter().any(|p| *p < 1024) { return Err("Invalid kernel ports".into()); }
    let net: String = ports.iter().map(|p| format!("(allow network-bind network-inbound (local ip \"localhost:{p}\"))\n(allow network-outbound (remote ip \"localhost:{p}\"))\n")).collect();
    Ok(format!("(version 1)\n(deny default)\n(allow process-exec {})\n(allow process-fork)\n(allow sysctl-read)\n(allow signal (target self) (target children))\n\
(allow file-read-metadata {} {})\n(allow file-read-data (literal \"/\"))\n\
(allow mach-lookup (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n\
(allow file-read* {})\n(allow file-write* (subpath {}) (literal \"/dev/null\"))\n(deny network*)\n{net}",
        exec.join(" "), meta.join(" "), read.join(" "), read.join(" "), q(job)?))
}

/// Applied in the child between fork and exec. NPROC is per user on macOS, so it is relative to the current process count.
pub fn limits(cpu_seconds: u64, nproc: u64, alarm_seconds: u32) -> io::Result<()> {
    for (resource, limit) in [(libc::RLIMIT_CPU, cpu_seconds), (libc::RLIMIT_FSIZE, 32 * 1024 * 1024), (libc::RLIMIT_NOFILE, 512), (libc::RLIMIT_NPROC, nproc), (libc::RLIMIT_CORE, 0)] {
        let value = libc::rlimit { rlim_cur: limit, rlim_max: limit };
        if unsafe { libc::setrlimit(resource, &value) } != 0 { return Err(io::Error::last_os_error()); }
    }
    unsafe { libc::alarm(alarm_seconds); } // survives exec: reaps the job if the helper itself is killed
    Ok(())
}
pub fn process_total() -> u64 { unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) }.max(0) as u64 }
/// Group members; an error when the group no longer fits the buffer (a fork storm).
pub fn group_pids(group: i32) -> Result<Vec<i32>, String> {
    let mut pids = [0i32; 128];
    let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), std::mem::size_of_val(&pids) as i32) };
    if count < 0 || count as usize >= pids.len() { return Err("process_limit".into()); }
    Ok(pids.into_iter().take(count as usize).filter(|pid| *pid > 0).collect())
}
fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    (unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) } == size).then_some(info)
}
fn all_pids() -> Vec<i32> {
    let mut pids = vec![0i32; 16384];
    let bytes = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
    pids.truncate(bytes.max(0) as usize); pids.retain(|p| *p > 1); pids
}
/// Processes of this user whose environment carries `marker` (inherited by every descendant, so it finds processes that
/// left both the process group and the parent chain). Shortcut: a descendant that clears its environment is not found.
fn tagged(marker: &str, me: i32) -> Vec<i32> {
    let (needle, mut found, mut buffer) = (marker.as_bytes(), Vec::new(), vec![0u8; 1 << 20]);
    for pid in all_pids() {
        if pid == me { continue; }
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid]; let mut len = buffer.len();
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } == 0 && buffer[..len].windows(needle.len()).any(|w| w == needle) { found.push(pid); }
    }
    found
}
/// Freeze, then kill, the job's whole tree, including descendants that left the process group (a shell with job
/// control, `set -m`, gives each background job its own group). Stopping first keeps parent links intact while the tree is walked.
/// Returns every pid found; shortcut: a process that double-forks faster than the freeze loop (50 passes) can still escape.
pub fn kill_tree(root: i32, marker: Option<&str>) -> Vec<i32> {
    let me = unsafe { libc::getpid() };
    let mut seen: BTreeSet<i32> = BTreeSet::new(); seen.insert(root);
    for _ in 0..50 {
        unsafe { libc::kill(-root, libc::SIGSTOP); libc::kill(root, libc::SIGSTOP); }
        let mut grew = false;
        for pid in all_pids() {
            if pid == me || seen.contains(&pid) { continue; }
            let Some(info) = bsd_info(pid) else { continue };
            if info.pbi_pgid as i32 == root || seen.contains(&(info.pbi_ppid as i32)) { seen.insert(pid); unsafe { libc::kill(pid, libc::SIGSTOP); } grew = true; }
        }
        for pid in marker.map(|m| tagged(m, me)).unwrap_or_default() { if seen.insert(pid) { unsafe { libc::kill(pid, libc::SIGSTOP); } grew = true; } }
        if !grew { break; }
    }
    for pid in &seen { unsafe { libc::kill(*pid, libc::SIGKILL); } }
    unsafe { libc::kill(-root, libc::SIGKILL); }
    seen.into_iter().collect()
}
/// Pids from `kill_tree` (plus the group) that are still alive and not zombies.
pub fn survivors(found: &[i32], group: i32, marker: Option<&str>) -> usize {
    let mut alive: BTreeSet<i32> = found.iter().copied().filter(|p| bsd_info(*p).is_some_and(|i| i.pbi_status != 5 && i.pbi_status != 0)).collect();
    alive.extend(group_pids(group).unwrap_or_else(|_| vec![-1]).into_iter().filter(|p| bsd_info(*p).is_none_or(|i| i.pbi_status != 5)));
    alive.extend(marker.map(|m| tagged(m, unsafe { libc::getpid() })).unwrap_or_default().into_iter().filter(|p| bsd_info(*p).is_some_and(|i| i.pbi_status != 5)));
    alive.len()
}
pub fn group_memory(group: i32) -> Result<u64, String> { memory_of(&group_pids(group)?) }
/// The session's processes: its group plus every descendant by parent link (jupyter_client starts the kernel in a new
/// session, so it leaves the group but keeps the broker as parent).
pub fn tree_pids(root: i32) -> Vec<i32> {
    let infos: Vec<(i32, i32, i32)> = all_pids().into_iter().filter_map(|p| bsd_info(p).map(|i| (p, i.pbi_ppid as i32, i.pbi_pgid as i32))).collect();
    let mut found: BTreeSet<i32> = BTreeSet::from([root]);
    for _ in 0..16 {
        let before = found.len();
        for (pid, ppid, pgid) in &infos { if *pgid == root || found.contains(ppid) { found.insert(*pid); } }
        if found.len() == before { break; }
    }
    found.into_iter().collect()
}
pub fn memory_of(pids: &[i32]) -> Result<u64, String> {
    let mut bytes = 0u64;
    for &pid in pids {
        // physical footprint, not resident size: compressible pages (b"\1" * n) barely count as resident
        let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        if unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast()) } == 0 { bytes = bytes.saturating_add(info.ri_phys_footprint); }
        else if io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) { return Err("memory_unavailable".into()); }
    }
    Ok(bytes)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_python_and_rscript_are_launchable() {
        assert_eq!(kind_of(Path::new("/x/bin/python3.15")), Ok(Kind::Python)); assert_eq!(kind_of(Path::new("/x/bin/python")), Ok(Kind::Python));
        assert_eq!(kind_of(Path::new("/x/bin/Rscript")), Ok(Kind::R));
        for bad in ["/bin/sh", "/x/bin/python3-config", "/x/bin/pythonw; rm", "/x/bin/R", "/x/bin/perl"] { assert!(kind_of(Path::new(bad)).is_err(), "{bad}"); }
    }
    #[test] fn install_trees_are_the_interpreters_own() {
        assert_eq!(install_tree(Path::new("/Users/u/miniforge3/envs/e/bin/python3.15")).unwrap(), Path::new("/Users/u/miniforge3/envs/e"));
        assert_eq!(install_tree(Path::new("/Library/Frameworks/R.framework/Versions/4.6/Resources/bin/Rscript")).unwrap(), Path::new("/Library/Frameworks/R.framework"));
        for bad in ["/bin/python3", "/usr/python", "/python3"] { assert!(install_tree(Path::new(bad)).is_err(), "{bad}"); }
    }
    #[test] fn paths_with_policy_syntax_are_refused() {
        for bad in ["/a\"b", "/a\\b", "/a\nb"] { assert!(q(Path::new(bad)).is_err()); }
        assert!(policy(Kind::Python, Path::new("/x/bin/python"), Path::new("/x"), Path::new("/tmp/j\"); (allow default"), &[]).is_err());
    }
    #[test] fn profile_denies_by_default_and_grants_only_named_paths() {
        let p = policy(Kind::Python, Path::new("/Users/u/e/bin/python3.15"), Path::new("/Users/u/e"), Path::new("/private/tmp/job"), &[PathBuf::from("/Users/u/data/d.csv")]).unwrap();
        assert!(p.starts_with("(version 1)\n(deny default)\n") && p.contains("(deny network*)") && !p.contains("process-fork"));
        assert!(p.contains("(subpath \"/private/tmp/job\")") && p.contains("(literal \"/Users/u/data/d.csv\")"));
        assert!(!p.contains("(allow file-read-metadata)") && !p.contains("(allow file-read*)") && !p.contains("(subpath \"/Users\")") && !p.contains("(subpath \"/Users/u\")"));
        let r = policy(Kind::R, Path::new("/Library/Frameworks/R.framework/Versions/4.6/Resources/bin/Rscript"), Path::new("/Library/Frameworks/R.framework"), Path::new("/private/tmp/job"), &[]).unwrap();
        assert!(r.contains("(allow process-fork)") && r.contains("(literal \"/bin/sh\")") && !r.contains("(subpath \"/bin\")") && !r.contains("(subpath \"/usr/bin\")"));
    }
    #[test] fn kernel_profile_grants_only_both_trees_the_spec_the_job_and_five_loopback_ports() {
        let b = Launch { path: "/Users/u/e/bin/python".into(), canonical: "/Users/u/e/bin/python3.15".into(), tree: "/Users/u/e".into(), kind: Kind::Python };
        let k = Launch { path: "/Library/Frameworks/R.framework/Resources/bin/R".into(), canonical: "/Library/Frameworks/R.framework/Versions/4.6/Resources/bin/R".into(), tree: "/Library/Frameworks/R.framework".into(), kind: Kind::R };
        let p = kernel_policy(&b, &k, Path::new("/Users/u/Library/Jupyter/kernels/ir"), Path::new("/private/tmp/job"), &[50001, 50002, 50003, 50004, 50005]).unwrap();
        assert!(p.starts_with("(version 1)\n(deny default)\n") && p.contains("(allow process-fork)") && p.contains("(subpath \"/Users/u/Library/Jupyter/kernels/ir\")"));
        let deny = p.find("(deny network*)").unwrap();
        assert_eq!(p.matches("network-outbound (remote ip \"localhost:").count(), 5); assert!(p.find("localhost:50001").unwrap() > deny);
        assert!(!p.contains("(remote ip \"*") && !p.contains("(subpath \"/Users/u\")") && !p.contains("(subpath \"/Users\")"));
        assert!(kernel_policy(&b, &k, Path::new("/s"), Path::new("/j"), &[1, 2, 3, 4, 5]).is_err() && kernel_policy(&b, &k, Path::new("/s"), Path::new("/j"), &[5000]).is_err());
    }
    #[test] fn extra_reads_are_never_broad_or_the_home() {
        let home = fs::canonicalize(std::env::temp_dir()).unwrap();
        for bad in ["/", "/Users", "/etc", "/private/etc/hosts", "/System"] { assert!(extra_read(bad, &home).is_err(), "{bad}"); }
        assert!(extra_read("/nonexistent/path/x", &home).is_err());
        assert!(extra_read(std::env::temp_dir().to_str().unwrap(), &home).is_err()); // the (fake) home and its parents
    }
    #[test] fn environment_marker_finds_a_process_outside_the_group_and_lineage() {
        // setsid-style escape: the child gets its own session/group and is orphaned by a short-lived parent.
        let marker = format!("LATEX_LOCAL_JOB=unit-{}", std::process::id());
        let status = std::process::Command::new("/bin/sh").arg("-c").arg("(set -m; sleep 30 & ) ; exit 0").env(&marker[..15], &marker[16..]).status().unwrap();
        assert!(status.success()); std::thread::sleep(std::time::Duration::from_millis(300));
        let found = tagged(&marker, unsafe { libc::getpid() });
        assert!(!found.is_empty(), "marker not found: environment reads of other processes may be blocked in this context");
        for pid in found { unsafe { libc::kill(pid, libc::SIGKILL); } }
    }
    #[test] fn process_accounting_sees_this_process_group() {
        assert!(process_total() > 1);
        assert!(group_memory(unsafe { libc::getpgrp() }).unwrap() > 0);
        assert!(tree_pids(unsafe { libc::getpgrp() }).contains(&(std::process::id() as i32)));
    }
}
