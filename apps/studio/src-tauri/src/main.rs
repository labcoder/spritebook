// SpriteBook Studio shell (P4-T1). Three commands, all read-only projections:
//
//  - run_cli: spawn the core CLI (deno) and stream its stdout to the webview
//    on a PER-JOB channel `cli:<jobId>` (D-005 rider: no global event names).
//    The skeleton's only caller runs `doctor`; the command itself is
//    verb-agnostic because every later screen speaks through it.
//  - list_workspaces: every <root>/*/character.json, verbatim — the manifest
//    IS the interface; the GUI projects it and never interprets on this side.
//  - read_thumb: newest bake's contact gif bytes, base64 — a display artifact
//    core already produced, not something the shell renders.
//
// Dev runs resolve the repo root relative to this manifest; a packaged
// binary takes SPRITEBOOK_REPO until the packaging task pins a real story.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Emitter;

fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("SPRITEBOOK_REPO") {
        return PathBuf::from(p);
    }
    // apps/studio/src-tauri -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

#[tauri::command]
async fn run_cli(app: tauri::AppHandle, job_id: String, args: Vec<String>) -> Result<i32, String> {
    // per-job channel, so two concurrent jobs can never interleave lines
    let channel = format!("cli:{job_id}");
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root();
        let mut cmd = Command::new("deno");
        cmd.arg("run")
            .arg("-A")
            .arg(root.join("packages/cli/mod.ts"))
            .args(&args)
            .current_dir(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn deno: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.map_err(|e| e.to_string())?;
            let _ = app.emit(&channel, &line);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct RawWorkspace {
    dir: String,
    manifest: serde_json::Value,
}

#[tauri::command]
fn list_workspaces(root: String) -> Result<Vec<RawWorkspace>, String> {
    let base = {
        let p = PathBuf::from(&root);
        if p.is_absolute() { p } else { repo_root().join(p) }
    };
    let entries = std::fs::read_dir(&base)
        .map_err(|e| format!("cannot read {}: {e}", base.display()))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("character.json");
        let Ok(bytes) = std::fs::read(&manifest_path) else {
            continue; // not a workspace — fine, roots hold other dirs too
        };
        // verbatim passthrough: a malformed manifest still yields a card that
        // SAYS it is malformed, instead of silently vanishing from the gallery
        let manifest = serde_json::from_slice(&bytes)
            .unwrap_or(serde_json::Value::Null);
        out.push(RawWorkspace {
            dir: entry.path().to_string_lossy().into_owned(),
            manifest,
        });
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    Ok(out)
}

#[tauri::command]
fn read_thumb(dir: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let bakes = Path::new(&dir).join("bakes");
    let Ok(entries) = std::fs::read_dir(&bakes) else {
        return Ok(None);
    };
    // newest bake dir by modification time that actually holds a contact gif
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let gif = e.path().join("contact-idle.gif");
            if !gif.is_file() {
                return None;
            }
            let t = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((t, gif))
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    match candidates.first() {
        Some((_, gif)) => {
            let bytes = std::fs::read(gif).map_err(|e| e.to_string())?;
            Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
        }
        None => Ok(None),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_cli, list_workspaces, read_thumb])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
