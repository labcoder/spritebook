use std::collections::HashMap;
use std::io;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Option<Arc<Tree>>>>);

impl Jobs {
    pub fn start(self: &Arc<Self>, id: String, cmd: &mut Command) -> io::Result<OwnedJob> {
        let mut jobs = self.0.lock().unwrap();
        if let Some(slot) = jobs.get(&id) {
            if slot.is_none() {
                jobs.remove(&id);
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "job canceled before start",
                ));
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "duplicate job id",
            ));
        }
        prepare(cmd);
        let mut child = cmd.spawn()?;
        let tree = match Tree::attach(&child) {
            Ok(tree) => Arc::new(tree),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        jobs.insert(id.clone(), Some(tree));
        Ok(OwnedJob {
            child,
            id,
            jobs: self.clone(),
        })
    }

    pub fn cancel(&self, id: String) {
        let mut jobs = self.0.lock().unwrap();
        // A cancellation can arrive before run_cli reaches the blocking executor.
        if let Some(Some(tree)) = jobs.get(&id) {
            tree.kill();
        } else {
            jobs.insert(id, None);
        }
    }

    pub fn cancel_all(&self) {
        for tree in self.0.lock().unwrap().values().flatten() {
            tree.kill();
        }
    }
}

pub struct OwnedJob {
    pub child: Child,
    id: String,
    jobs: Arc<Jobs>,
}

impl Drop for OwnedJob {
    fn drop(&mut self) {
        if let Some(Some(tree)) = self.jobs.0.lock().unwrap().remove(&self.id) {
            tree.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn prepare(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(unix)]
fn prepare(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(windows)]
struct Tree(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl Tree {
    fn attach(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        // The CLI waits on stdin: it cannot spawn workers until assignment succeeds.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let owner = OwnedHandle::from_raw_handle(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(owner))
        }
    }

    fn kill(&self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 130);
        }
    }
}

#[cfg(unix)]
struct Tree(i32);

#[cfg(unix)]
impl Tree {
    fn attach(child: &Child) -> io::Result<Self> {
        Ok(Self(child.id() as i32))
    }
    fn kill(&self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    #[test]
    #[ignore = "subprocess fixture, invoked by ownership test"]
    fn process_worker() {
        let path = std::path::PathBuf::from(std::env::var_os("SB_JOB_TEST_PATH").unwrap());
        if std::env::var_os("SB_JOB_TEST_GRANDCHILD").is_some() {
            std::thread::sleep(Duration::from_millis(650));
            std::fs::write(
                path.with_extension("published"),
                "unexpected worker publication",
            )
            .unwrap();
            return;
        }
        let mut gate = String::new();
        std::io::stdin().read_to_string(&mut gate).unwrap();
        assert_eq!(gate, "start\n");
        let mut child = worker(&path)
            .env("SB_JOB_TEST_GRANDCHILD", "1")
            .spawn()
            .unwrap();
        std::fs::write(path.with_extension("ready"), "ready").unwrap();
        assert!(child.wait().unwrap().success());
    }

    fn worker(path: &std::path::Path) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "jobs::tests::process_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("SB_JOB_TEST_PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        cmd
    }

    #[test]
    fn cancellation_and_close_kill_descendants_and_allow_retry() {
        let jobs = Arc::new(Jobs::default());
        let dir = std::env::temp_dir().join(format!("sb-owned-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for mode in ["cancel", "close", "drop"] {
            let path = dir.join(mode);
            let mut job = jobs.start(mode.into(), &mut worker(&path)).unwrap();
            job.child
                .stdin
                .take()
                .unwrap()
                .write_all(b"start\n")
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !path.with_extension("ready").exists() {
                assert!(Instant::now() < deadline, "worker did not reach owned work");
                std::thread::sleep(Duration::from_millis(10));
            }
            match mode {
                "cancel" => jobs.cancel(mode.into()),
                "close" => jobs.cancel_all(),
                _ => (),
            }
            drop(job);
            std::thread::sleep(Duration::from_millis(800));
            assert!(
                !path.with_extension("published").exists(),
                "orphan worker published after {mode}"
            );
        }
        jobs.cancel("early".into());
        assert_eq!(
            jobs.start("early".into(), &mut worker(&dir.join("early")))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        let path = dir.join("retry");
        let mut job = jobs.start("retry".into(), &mut worker(&path)).unwrap();
        job.child
            .stdin
            .take()
            .unwrap()
            .write_all(b"start\n")
            .unwrap();
        assert!(job.child.wait().unwrap().success());
        assert!(path.with_extension("published").exists());
        drop(job);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
