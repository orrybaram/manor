//! Wait for the helper's fds: `poll` on Linux, `select` on macOS.
//!
//! macOS `poll` does not support terminal devices (it reports POLLNVAL for
//! them), which is why libuv watches ttys with `select` there. The helper
//! holds a handful of low-numbered fds, well under `FD_SETSIZE`.

/// Like `poll(2)`: fills each `revents`, returns the ready count or -1.
#[cfg(target_os = "linux")]
pub fn wait(fds: &mut [libc::pollfd], timeout_ms: i32) -> i32 {
    // SAFETY: polling our own array.
    unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) }
}

#[cfg(target_os = "macos")]
pub fn wait(fds: &mut [libc::pollfd], timeout_ms: i32) -> i32 {
    use std::mem::zeroed;
    // SAFETY: fd_sets are plain data, initialised by FD_ZERO.
    let mut read: libc::fd_set = unsafe { zeroed() };
    let mut write: libc::fd_set = unsafe { zeroed() };
    let mut max = -1;
    // SAFETY: FD_* on our own sets with fds below FD_SETSIZE.
    unsafe {
        libc::FD_ZERO(&mut read);
        libc::FD_ZERO(&mut write);
        for p in fds.iter() {
            if p.fd < 0 || p.fd as usize >= libc::FD_SETSIZE {
                continue;
            }
            if p.events & libc::POLLIN != 0 {
                libc::FD_SET(p.fd, &mut read);
            }
            if p.events & libc::POLLOUT != 0 {
                libc::FD_SET(p.fd, &mut write);
            }
            max = max.max(p.fd);
        }
    }
    let mut tv = libc::timeval {
        tv_sec: (timeout_ms.max(0) / 1000) as libc::time_t,
        tv_usec: ((timeout_ms.max(0) % 1000) * 1000) as libc::suseconds_t,
    };
    let tvp = if timeout_ms < 0 { std::ptr::null_mut() } else { &mut tv };
    // SAFETY: select over our own sets.
    let r = unsafe { libc::select(max + 1, &mut read, &mut write, std::ptr::null_mut(), tvp) };
    if r < 0 {
        return r;
    }
    let mut ready = 0;
    for p in fds.iter_mut() {
        p.revents = 0;
        if p.fd < 0 || p.fd as usize >= libc::FD_SETSIZE {
            continue;
        }
        // SAFETY: FD_ISSET on our own sets.
        unsafe {
            if p.events & libc::POLLIN != 0 && libc::FD_ISSET(p.fd, &read) {
                p.revents |= libc::POLLIN;
            }
            if p.events & libc::POLLOUT != 0 && libc::FD_ISSET(p.fd, &write) {
                p.revents |= libc::POLLOUT;
            }
        }
        if p.revents != 0 {
            ready += 1;
        }
    }
    ready
}
