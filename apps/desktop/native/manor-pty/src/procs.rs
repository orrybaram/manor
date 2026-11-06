//! Reading the process table without starting processes: `/proc` on Linux,
//! libproc on macOS.

use std::collections::HashMap;

/// Every live process's parent, by pid.
pub fn parents() -> HashMap<i32, i32> {
    let mut map = HashMap::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(dir) = std::fs::read_dir("/proc") {
            for entry in dir.flatten() {
                let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else {
                    continue;
                };
                if let Some(ppid) = linux::stat_field(pid, 1).and_then(|s| s.parse().ok()) {
                    map.insert(pid, ppid);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for pid in macos::all_pids() {
            if let Some(info) = macos::bsdinfo(pid) {
                map.insert(pid, info.pbsi_ppid as i32);
            }
        }
    }
    map
}

/// `root` and every process below it.
pub fn tree(root: i32) -> Vec<i32> {
    let parents = parents();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (&pid, &ppid) in &parents {
        children.entry(ppid).or_default().push(pid);
    }
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        if let Some(kids) = children.get(&out[i]) {
            out.extend(kids.iter().copied().filter(|k| *k != root));
        }
        i += 1;
    }
    out
}

/// Direct children of `pid`.
pub fn children_of(pid: i32) -> Vec<i32> {
    let mut kids = direct_children(pid).unwrap_or_else(|| {
        parents()
            .into_iter()
            .filter(|&(_, ppid)| ppid == pid)
            .map(|(p, _)| p)
            .collect()
    });
    kids.sort_unstable();
    kids
}

/// Children without walking the whole table: every thread's
/// `/proc/<pid>/task/<tid>/children` on Linux (a child belongs to the thread
/// that forked it), `proc_listchildpids` on macOS. None if unavailable.
fn direct_children(pid: i32) -> Option<Vec<i32>> {
    #[cfg(target_os = "linux")]
    {
        let mut kids = Vec::new();
        for task in std::fs::read_dir(format!("/proc/{pid}/task")).ok()?.flatten() {
            let raw = std::fs::read_to_string(task.path().join("children")).ok()?;
            kids.extend(raw.split_whitespace().filter_map(|s| s.parse::<i32>().ok()));
        }
        Some(kids)
    }
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0i32; 256];
        // SAFETY: buffer size in bytes matches the allocation.
        let n = unsafe {
            libc::proc_listchildpids(
                pid,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if n < 0 {
            return None;
        }
        // It returns a count of pids; clamp in case a version returns bytes.
        buf.truncate((n as usize).min(buf.len()));
        buf.retain(|p| *p > 0);
        Some(buf)
    }
}

/// Send `signal` to `root` and everything below it, like the `tree-kill`
/// package. Err if `root` itself couldn't be signalled.
pub fn kill_tree(root: i32, signal: i32) -> Result<(), ()> {
    let pids = tree(root);
    let mut root_ok = false;
    for pid in pids {
        // SAFETY: plain syscall.
        let ok = unsafe { libc::kill(pid, signal) } == 0;
        if pid == root {
            root_ok = ok;
        }
    }
    if root_ok { Ok(()) } else { Err(()) }
}

pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A process's argv, or None if it can't be read.
pub fn args(pid: i32) -> Option<Vec<String>> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        Some(
            raw.split(|b| *b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect(),
        )
    }
    #[cfg(target_os = "macos")]
    {
        macos::procargs(pid)
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    /// Field `n` (0 = state) after the parenthesised comm in `/proc/<pid>/stat`.
    pub fn stat_field(pid: i32, n: usize) -> Option<String> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let rest = &stat[stat.rfind(')')? + 2..];
        rest.split(' ').nth(n).map(str::to_owned)
    }
}

#[cfg(target_os = "macos")]
pub mod macos {
    use std::mem::{MaybeUninit, size_of};

    pub fn all_pids() -> Vec<i32> {
        // SAFETY: a null buffer asks for the count.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0i32; n as usize + 64];
        // SAFETY: buffer size in bytes matches the allocation.
        let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * size_of::<i32>()) as i32) };
        pids.truncate(got.max(0) as usize);
        pids.retain(|p| *p > 0);
        pids
    }

    /// A process's parent and short name. The short flavour, because the
    /// full one refuses a process whose euid isn't ours (`sudo`, a setuid
    /// `ping`), which node-pty's sysctl lookup would still name.
    pub fn bsdinfo(pid: i32) -> Option<libc::proc_bsdshortinfo> {
        let mut info = MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
        let size = size_of::<libc::proc_bsdshortinfo>() as i32;
        // SAFETY: buffer is a proc_bsdshortinfo of the size passed.
        let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
        // SAFETY: proc_pidinfo filled it when it returned the full size.
        (got == size).then(|| unsafe { info.assume_init() })
    }

    /// argv from `sysctl(KERN_PROCARGS2)`: argc, the exec path, padding, argv.
    pub fn procargs(pid: i32) -> Option<Vec<String>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        // SAFETY: size query with a null buffer.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return None;
        }
        let mut buf = vec![0u8; size];
        // SAFETY: buffer is `size` bytes.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buf.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return None;
        }
        buf.truncate(size);
        if buf.len() < 4 {
            return None;
        }
        let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]).max(0) as usize;
        let mut rest = &buf[4..];
        // Skip the exec path and the NULs after it.
        let path_end = rest.iter().position(|b| *b == 0)?;
        rest = &rest[path_end..];
        let start = rest.iter().position(|b| *b != 0)?;
        rest = &rest[start..];
        let args: Vec<String> = rest
            .split(|b| *b == 0)
            .take(argc)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        Some(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// launchd is root's: the full bsdinfo flavour refuses it to a normal
    /// user, and so would hide a `sudo` in a pane's foreground.
    #[cfg(target_os = "macos")]
    #[test]
    fn names_another_users_process() {
        let info = macos::bsdinfo(1).expect("pid 1's short info");
        let comm: Vec<u8> = info
            .pbsi_comm
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        assert_eq!(comm, b"launchd");
        assert!(parents().contains_key(&1));
    }

    #[test]
    fn finds_itself_and_its_children() {
        let me = std::process::id() as i32;
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let kid = child.id() as i32;
        assert!(tree(me).contains(&kid));
        assert!(children_of(me).contains(&kid));
        let a = args(kid).unwrap();
        assert_eq!(a, vec!["sleep".to_string(), "5".to_string()]);
        kill_tree(kid, libc::SIGKILL).unwrap();
        child.wait().unwrap();
    }
}
