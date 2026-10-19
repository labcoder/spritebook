use spritebook_lock::jobs::Jobs;
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;

fn run() -> io::Result<i32> {
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == OsStr::new("--owned-start"))
    {
        args.remove(0);
        let mut gate = String::new();
        io::stdin().take(65).read_to_string(&mut gate)?;
        if gate != "start\n" {
            return Ok(130);
        }
    }
    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .ok_or_else(|| io::Error::other("no runtime directory"))?;
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    let uv = if cfg!(windows) { "uv.exe" } else { "uv" };
    let mut command = Command::new(root.join(node));
    command
        .arg(root.join("core/cli.mjs"))
        .arg("--owned-start")
        .args(args)
        .env("SPRITEBOOK_RESOURCES", root.join("assets"))
        .env("SPRITEBOOK_UV_BIN", root.join(uv))
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let jobs = Arc::new(Jobs::default());
    let mut job = jobs.start("cli".into(), &mut command)?;
    job.child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("no startup pipe"))?
        .write_all(b"start\n")?;
    Ok(job.child.wait()?.code().unwrap_or(1))
}

fn main() {
    let code = run().unwrap_or_else(|error| {
        eprintln!("Cannot start SpriteBook's owned runtime: {error}");
        1
    });
    std::process::exit(code);
}
