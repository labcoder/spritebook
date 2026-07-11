// P0-T3 Tauri shell: loads the shared probe app, exposes two commands —
// spawn the mock core CLI streaming NDJSON lines as events, and persist the
// app's self-test evidence for the harness.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::BufRead;
use std::process::{Command, Stdio};
use tauri::Emitter;

const MOCK_CLI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../mock-cli/main.ts");
const OUT_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../out");

#[tauri::command]
async fn spawn_mock_job(app: tauri::AppHandle, frames: u32) -> Result<i32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("deno");
        cmd.args([
            "run",
            MOCK_CLI,
            &format!("--frames={frames}"),
            "--interval=10",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn deno: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.map_err(|e| e.to_string())?;
            let _ = app.emit("job-line", &line);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_selftest(json: String) -> Result<(), String> {
    std::fs::create_dir_all(OUT_DIR).map_err(|e| e.to_string())?;
    std::fs::write(format!("{OUT_DIR}/selftest-tauri.json"), json).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![spawn_mock_job, save_selftest])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
