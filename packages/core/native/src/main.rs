use std::fs::{File, OpenOptions};
use std::io::{self, Write};

fn main() -> io::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "expected a lock file path"))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    let nonblocking = std::env::args_os().nth(2).is_some_and(|arg| arg == "--try");
    if let Err(error) = lock(&file, nonblocking) {
        if nonblocking
            && (error.kind() == io::ErrorKind::WouldBlock
                || (cfg!(windows) && error.raw_os_error() == Some(33)))
        {
            writeln!(io::stdout(), "busy")?;
            return Ok(());
        }
        return Err(error);
    }
    writeln!(io::stdout(), "locked")?;
    io::stdout().flush()?;
    // The dedicated pipe closes on parent death; dropping File releases the kernel lock.
    io::copy(&mut io::stdin().lock(), &mut io::sink())?;
    Ok(())
}

#[cfg(windows)]
fn lock(file: &File, nonblocking: bool) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    unsafe {
        let mut overlapped = std::mem::zeroed();
        if LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK
                | if nonblocking {
                    LOCKFILE_FAIL_IMMEDIATELY
                } else {
                    0
                },
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn lock(file: &File, nonblocking: bool) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    loop {
        let flags = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
        if unsafe { libc::flock(file.as_raw_fd(), flags) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
