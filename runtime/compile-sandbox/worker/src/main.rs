// SPDX-License-Identifier: AGPL-3.0-only
// Reuses the project's incremental-preview Landlock boundary; no TeX engine logic.
use std::{env, ffi::CString, io, os::unix::process::CommandExt, path::{Path, PathBuf}, process::Command};

fn workspace(path: &Path) -> io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    let parent = canonical.parent().ok_or_else(|| io::Error::other("invalid workspace"))?;
    let allowed = ["/var/lib/overleaf/data/compiles", "/var/lib/overleaf/data/output", "/var/lib/overleaf/data/cache"];
    if path != canonical || !allowed.iter().any(|base| Path::new(base) == parent) {
        return Err(io::Error::other("workspace outside job roots"));
    }
    Ok(canonical)
}

unsafe fn confine(work: &Path) -> io::Result<()> {
    #[repr(C)] struct Rules { fs: u64, net: u64, scoped: u64 }
    #[repr(C, packed)] struct Beneath { access: u64, parent: i32 }
    let abi = libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0, 1);
    if abi < 3 { return Err(io::Error::other(format!("Landlock ABI 3 required (reported {abi})"))); }
    let rules = Rules { fs: if abi >= 5 { 0xffff } else { 0x7fff }, net: if abi >= 4 { 3 } else { 0 }, scoped: if abi >= 6 { 3 } else { 0 } };
    let fd = libc::syscall(libc::SYS_landlock_create_ruleset, &rules, std::mem::size_of::<Rules>(), 0) as i32;
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let result = (|| {
        for path in ["/usr", "/lib", "/lib64", "/opt", "/bin", "/sbin", "/etc/fonts", "/etc/texmf", "/etc/ld.so.cache", "/etc/localtime", "/dev/null", "/dev/urandom", "/opt/rosetta/rosetta", "/proc/sys/vm/mmap_min_addr"].iter().map(Path::new).chain([work]) {
            if !path.exists() { continue; }
            let name = CString::new(path.as_os_str().as_encoded_bytes())?;
            let parent = libc::open(name.as_ptr(), libc::O_PATH | libc::O_CLOEXEC);
            if parent < 0 { return Err(io::Error::last_os_error()); }
            let access = if path == work { rules.fs & !(1 | 64 | 512 | 1024 | 2048 | 32768) }
                else if path == Path::new("/opt/rosetta/rosetta") { 5 } else if path.is_dir() { 13 } else if path == Path::new("/dev/null") { 6 } else { 4 };
            let rule = Beneath { access, parent };
            let added = libc::syscall(libc::SYS_landlock_add_rule, fd, 1, &rule, 0);
            libc::close(parent);
            if added != 0 { return Err(io::Error::last_os_error()); }
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || libc::syscall(libc::SYS_landlock_restrict_self, fd, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    libc::close(fd); result?;
    // Signal syscalls are denied even without ABI6 scopes; the trusted parent reaps jobs.
    // Filters stay valid when the current mixed ARM64/amd64 toolchain execs another architecture.
    let ins = |code, k, jt, jf| libc::sock_filter { code, k, jt, jf };
    let branch = |blocked: &[u32]| {
        let mut code = vec![ins(0x20, 0, 0, 0), ins(0x45, 0x40000000, 0, 1), ins(0x06, 0x80000000, 0, 0)];
        for nr in blocked { code.push(ins(0x15, *nr, 0, 1)); code.push(ins(0x06, 0x00050000 | libc::EACCES as u32, 0, 0)); }
        code.push(ins(0x06, 0x7fff0000, 0, 0)); code
    };
    let arm = branch(&[198,199,154,157,97,268,117,270,271,438,425,280,282,129,130,131,138,240,424,434]);
    let x86 = branch(&[41,53,109,112,272,308,101,310,311,438,425,321,323,62,200,234,129,297,424,434]);
    let mut filter = vec![ins(0x20, 4, 0, 0), ins(0x15, 0xc00000b7, 0, arm.len() as u8)];
    filter.extend(arm); filter.push(ins(0x15, 0xc000003e, 0, x86.len() as u8)); filter.extend(x86); filter.push(ins(0x06, 0x80000000, 0, 0));
    let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
    if libc::prctl(libc::PR_SET_SECCOMP, 2, &program) != 0 { return Err(io::Error::last_os_error()); }
    for (resource, limit) in [(libc::RLIMIT_DATA, 1_073_741_824), (libc::RLIMIT_FSIZE, 67_108_864), (libc::RLIMIT_NOFILE, 128), (libc::RLIMIT_CPU, 60), (libc::RLIMIT_CORE, 0)] {
        if libc::setrlimit(resource, &libc::rlimit { rlim_cur: limit, rlim_max: limit }) != 0 { return Err(io::Error::last_os_error()); }
    }
    Ok(())
}

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() < 3 { return Err(io::Error::other("expected workspace, cwd and command")); }
    let work = workspace(Path::new(&args[0]))?;
    let cwd = Path::new(&args[1]).canonicalize()?;
    if !cwd.starts_with(&work) { return Err(io::Error::other("cwd outside workspace")); }
    if unsafe { libc::geteuid() } == 0 { return Err(io::Error::other("run sandbox as unprivileged service user")); }
    let mut command = Command::new(&args[2]); command.args(&args[3..]).current_dir(&cwd).env_clear();
    command.env("PATH", "/opt/overleaf-native-tex/bin:/usr/local/texlive/2026/bin/x86_64-linux:/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &work).env("TMPDIR", &work).env("LC_ALL", "C.UTF-8").env("openout_any", "p");
    for name in ["max_print_line", "OVERLEAF_PROJECT_ID", "SOURCE_DATE_EPOCH", "FORCE_SOURCE_DATE"] {
        if let Some(value) = env::var_os(name) { command.env(name, value); }
    }
    unsafe { confine(&work)?; }
    Err(command.exec())
}
fn main() { if let Err(error) = run() { eprintln!("Compile confinement unavailable: {error}"); std::process::exit(126); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_roots_and_external_workspaces() {
        for root in ["/", "/usr", "/tmp", "/var/lib/overleaf/data/compiles"] { assert!(workspace(Path::new(root)).is_err()); }
    }
}
