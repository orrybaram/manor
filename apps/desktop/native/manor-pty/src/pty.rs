//! Open a PTY and start the pane's shell on it, the way node-pty does:
//! a new session with the slave as controlling terminal, argv[0] = the shell
//! as given, the spawn payload's env and cwd.

use std::ffi::CString;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

pub struct Child {
    pub pid: i32,
    pub master: OwnedFd,
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// The terminal settings node-pty gives a new pty (`src/unix/pty.cc`), so a
/// pane behaves the same under either helper: UTF-8 aware line editing
/// (IUTF8), ^C/^Z/^\\, 38400 baud.
fn node_pty_termios() -> libc::termios {
    // SAFETY: termios is plain data; every field we rely on is set below.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    t.c_iflag = libc::ICRNL | libc::IXON | libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8;
    t.c_oflag = libc::OPOST | libc::ONLCR;
    t.c_cflag = libc::CREAD | libc::CS8 | libc::HUPCL;
    t.c_lflag = libc::ICANON
        | libc::ISIG
        | libc::IEXTEN
        | libc::ECHO
        | libc::ECHOE
        | libc::ECHOK
        | libc::ECHOKE
        | libc::ECHOCTL;
    let cc = &mut t.c_cc;
    cc[libc::VEOF] = 4;
    cc[libc::VEOL] = 0xff;
    cc[libc::VEOL2] = 0xff;
    cc[libc::VERASE] = 0x7f;
    cc[libc::VWERASE] = 0x17;
    cc[libc::VKILL] = 0x15;
    cc[libc::VREPRINT] = 0x12;
    cc[libc::VINTR] = 0x03;
    cc[libc::VQUIT] = 0x1c;
    cc[libc::VSUSP] = 0x1a;
    cc[libc::VSTART] = 0x11;
    cc[libc::VSTOP] = 0x13;
    cc[libc::VLNEXT] = 0x16;
    cc[libc::VDISCARD] = 0x0f;
    cc[libc::VMIN] = 1;
    cc[libc::VTIME] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[libc::VDSUSP] = 0x19;
        cc[libc::VSTATUS] = 0x14;
    }
    // SAFETY: setting speeds on our struct.
    unsafe {
        libc::cfsetispeed(&mut t, libc::B38400);
        libc::cfsetospeed(&mut t, libc::B38400);
    }
    t
}

pub fn resize(master: RawFd, cols: u16, rows: u16) -> std::io::Result<()> {
    let ws = winsize(cols, rows);
    // SAFETY: TIOCSWINSZ with a valid winsize.
    if unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &ws) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn cstr(s: &str) -> std::io::Result<CString> {
    CString::new(s).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in string"))
}

/// Where `execvp` would find `file`, searched with the spawn env's PATH.
fn resolve(file: &str, env: &[(String, String)]) -> Vec<String> {
    if file.contains('/') {
        return vec![file.to_owned()];
    }
    let path = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str())
        .unwrap_or("/usr/bin:/bin");
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| format!("{d}/{file}"))
        .collect()
}

pub fn spawn(
    shell: &str,
    args: &[String],
    cwd: &str,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
) -> std::io::Result<Child> {
    // Everything the child needs is built before fork: no allocation after.
    let candidates: Vec<CString> = resolve(shell, env).iter().map(|p| cstr(p)).collect::<Result<_, _>>()?;
    let mut argv_c: Vec<CString> = vec![cstr(shell)?];
    for a in args {
        argv_c.push(cstr(a)?);
    }
    let mut argv: Vec<*const libc::c_char> = argv_c.iter().map(|c| c.as_ptr()).collect();
    argv.push(std::ptr::null());
    let env_c: Vec<CString> = env
        .iter()
        .map(|(k, v)| cstr(&format!("{k}={v}")))
        .collect::<Result<_, _>>()?;
    let mut envp: Vec<*const libc::c_char> = env_c.iter().map(|c| c.as_ptr()).collect();
    envp.push(std::ptr::null());
    let cwd_c = cstr(cwd)?;
    let max_fd = {
        let mut rl = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: plain getrlimit.
        let n = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) } == 0 {
            rl.rlim_cur
        } else {
            1024
        };
        n.min(65536) as i32
    };

    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let mut ws = winsize(cols, rows);
    let mut term = node_pty_termios();
    // SAFETY: openpty writes two fds; the name is optional.
    // macOS takes these as *mut, Linux as *const.
    #[allow(clippy::unnecessary_mut_passed)]
    let opened = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), &mut term, &mut ws) };
    if opened != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both fds are ours from openpty.
    let master_fd = unsafe { OwnedFd::from_raw_fd(master) };
    set_cloexec(master);

    // A pipe the child reports a failed exec through; CLOEXEC closes it on success.
    let mut errpipe = [0; 2];
    // SAFETY: pipe into a 2-int array.
    if unsafe { libc::pipe(errpipe.as_mut_ptr()) } != 0 {
        // SAFETY: closing our own fd.
        unsafe { libc::close(slave) };
        return Err(std::io::Error::last_os_error());
    }
    set_cloexec(errpipe[0]);
    set_cloexec(errpipe[1]);

    // SAFETY: fork; the child only calls async-signal-safe functions below.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        let e = std::io::Error::last_os_error();
        // SAFETY: closing our own fds.
        unsafe {
            libc::close(slave);
            libc::close(errpipe[0]);
            libc::close(errpipe[1]);
        }
        return Err(e);
    }
    if pid == 0 {
        // ── Child ──
        // SAFETY: async-signal-safe calls only; every pointer was built pre-fork.
        unsafe {
            for sig in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
                libc::SIGPIPE,
            ] {
                libc::signal(sig, libc::SIG_DFL);
            }
            let mut empty: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut empty);
            libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());

            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            for fd in 3..max_fd {
                if fd != errpipe[1] {
                    libc::close(fd);
                }
            }
            if libc::chdir(cwd_c.as_ptr()) != 0 {
                // node-pty fails the spawn on a bad cwd; report it the same way.
                let err = *errno();
                libc::write(errpipe[1], (&err as *const i32).cast(), 4);
                libc::_exit(1);
            }
            let mut err = libc::ENOENT;
            for c in &candidates {
                libc::execve(c.as_ptr(), argv.as_ptr(), envp.as_ptr());
                let e = *errno();
                if e != libc::ENOENT && e != libc::ENOTDIR {
                    err = e;
                }
            }
            libc::write(errpipe[1], (&err as *const i32).cast(), 4);
            libc::_exit(1);
        }
    }

    // ── Parent ──
    // SAFETY: closing our copies.
    unsafe {
        libc::close(slave);
        libc::close(errpipe[1]);
    }
    let mut buf = [0u8; 4];
    let n = loop {
        // SAFETY: reading into a 4-byte buffer.
        let n = unsafe { libc::read(errpipe[0], buf.as_mut_ptr().cast(), 4) };
        if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        break n;
    };
    // SAFETY: closing our fd.
    unsafe { libc::close(errpipe[0]) };
    if n == 4 {
        let code = i32::from_ne_bytes(buf);
        let mut status = 0;
        // SAFETY: reap the child that failed to exec.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        return Err(std::io::Error::from_raw_os_error(code));
    }
    set_nonblocking(master);
    Ok(Child { pid, master: master_fd })
}

#[cfg(target_os = "linux")]
unsafe fn errno() -> *mut i32 {
    // SAFETY: libc's thread-local errno.
    unsafe { libc::__errno_location() }
}
#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut i32 {
    // SAFETY: libc's thread-local errno.
    unsafe { libc::__error() }
}

pub fn set_nonblocking(fd: RawFd) {
    // SAFETY: fcntl flag update on our fd.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

pub fn set_cloexec(fd: RawFd) {
    // SAFETY: fcntl flag update on our fd.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

/// The pty's foreground process group, from the master side.
pub fn foreground_pgrp(master: RawFd) -> Option<i32> {
    // SAFETY: tcgetpgrp on our master fd.
    let pgrp = unsafe { libc::tcgetpgrp(master) };
    (pgrp > 0).then_some(pgrp)
}
