// F2-only installed-layout harness. Production still invokes the existing CLI.
use crate::jobs::Jobs;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use tauri::Manager;

pub fn run() -> i32 {
    let exit_code = Arc::new(AtomicI32::new(1));
    let recorded_code = exit_code.clone();
    tauri::Builder::default()
        .setup(move |app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let out = PathBuf::from(args.first().ok_or("expected output directory")?);
            if !out.is_absolute() {
                return Err("qualification output must be absolute".into());
            }
            fs::create_dir_all(&out)?;
            let runtime = app.path().resource_dir()?.join("renderer-runtime");
            let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
            let stdout = File::create(out.join("stdout.ndjson"))?;
            let stderr = File::create(out.join("stderr.log"))?;
            let temp = out.join("temp");
            fs::create_dir_all(&temp)?;
            let mut cmd = Command::new(&node);
            cmd.arg(runtime.join("node-run.mjs"));
            if args.get(1).map(String::as_str) == Some("checks") {
                cmd.arg("checks");
            } else if args.get(1).map(String::as_str) == Some("loss") {
                cmd.arg("loss").arg(&out).args(&args[2..]);
            } else {
                cmd.args(&args);
            }
            cmd.current_dir(&out)
                .env_clear()
                .env("PATH", "")
                .env("TEMP", &temp)
                .env("TMP", &temp)
                .env("LOCALAPPDATA", out.join("local-data"))
                .env("SPRITEBOOK_GPU_BACKEND", "vulkan")
                .env("SPRITEBOOK_OWNED_START", "1")
                .stdin(Stdio::piped())
                .stdout(stdout)
                .stderr(stderr);
            for name in ["SystemRoot", "WINDIR", "USERPROFILE"] {
                if let Some(value) = std::env::var_os(name) {
                    cmd.env(name, value);
                }
            }
            let jobs = Arc::new(Jobs::default());
            let mut job = jobs.start("renderer-qualification".into(), &mut cmd)?;
            job.child
                .stdin
                .take()
                .ok_or("no startup pipe")?
                .write_all(b"start\n")?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = job.child.wait();
                let code = result
                    .as_ref()
                    .ok()
                    .and_then(|status| status.code())
                    .unwrap_or(1);
                let report = serde_json::json!({
                    "node": node,
                    "runtime": runtime,
                    "cwd": out,
                    "path": "",
                    "code": code,
                    "waitError": result.err().map(|error| error.to_string()),
                });
                let recorded = fs::write(
                    out.join("tauri-launch.json"),
                    serde_json::to_vec_pretty(&report).unwrap(),
                );
                drop(job);
                let code = if recorded.is_ok() { code } else { 1 };
                recorded_code.store(code, Ordering::SeqCst);
                handle.exit(code);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("renderer qualification launch failed")
        .run_return(|_, _| {});
    exit_code.load(Ordering::SeqCst)
}
