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

/// Windows `canonicalize` returns verbatim paths (`\\?\C:\...`). Those bypass
/// separator normalization, so a downstream `dir + "/character.json"` becomes
/// an unopenable mixed-separator path — which is exactly how the first field
/// test broke `pick`. Everything user- or CLI-facing goes through here.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| s.strip_prefix(r"\\?\").map(String::from))
        .unwrap_or_else(|| s.into_owned())
}

/// One NDJSON session file per app run; the previous run's file is what the
/// drawer REPLAYS. Lives under the OS local-data dir, newest-first by name.
fn session_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("spritebook-studio/logs")
}

fn session_path() -> &'static PathBuf {
    use std::sync::OnceLock;
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = session_dir();
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        dir.join(format!("session-{stamp}.ndjsonl"))
    })
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
            // the core-side sink: every JobEvent of every run lands in THIS
            // app run's session file, which the next run's drawer can replay
            .arg("--log-append")
            .arg(session_path())
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
            dir: display_path(&entry.path()),
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

/// Lines of the newest session file BEFORE this run's — the drawer's replay.
#[tauri::command]
fn read_prev_session(max_lines: usize) -> Result<Option<Vec<String>>, String> {
    let dir = session_dir();
    let current = session_path();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(None);
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != current && p.extension().is_some_and(|x| x == "ndjsonl"))
        .collect();
    files.sort(); // session-<millis> sorts chronologically
    match files.last() {
        Some(p) => {
            let text = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
            let lines: Vec<String> = text.lines().map(String::from).collect();
            let start = lines.len().saturating_sub(max_lines);
            Ok(Some(lines[start..].to_vec()))
        }
        None => Ok(None),
    }
}

/// Source-image preview bytes. Read-only, and only image extensions — the
/// webview must not become a generic file reader.
#[tauri::command]
fn read_image(path: String) -> Result<Option<(String, String)>, String> {
    use base64::Engine;
    let p = PathBuf::from(&path);
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Ok(None),
    };
    match std::fs::read(&p) {
        Ok(bytes) => Ok(Some((
            mime.to_string(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))),
        Err(_) => Ok(None),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_cli,
            list_workspaces,
            read_thumb,
            read_prev_session,
            read_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
