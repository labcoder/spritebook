// The desktop projects the core CLI and its per-job NDJSON stream.
// Release builds launch the app-owned Node runtime; development reads compiled packages.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "renderer-qualification")]
mod qualification;

use spritebook_lock::jobs::Jobs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg(debug_assertions)]
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

fn cli_command(app: &tauri::AppHandle) -> Result<Command, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let root = repo_root();
        let runtime = root.join(".build/runtime");
        let mut cmd = Command::new(runtime.join(if cfg!(windows) { "node.exe" } else { "node" }));
        cmd.arg(root.join("packages/cli/dist/entry.js"))
            .env_remove("SPRITEBOOK_RESOURCES")
            .env(
                "SPRITEBOOK_UV_BIN",
                runtime.join(if cfg!(windows) { "uv.exe" } else { "uv" }),
            )
            .current_dir(root);
        Ok(cmd)
    }
    #[cfg(not(debug_assertions))]
    {
        let runtime = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("runtime");
        let mut cmd = Command::new(runtime.join(if cfg!(windows) { "node.exe" } else { "node" }));
        cmd.arg(runtime.join("core/cli.mjs"))
            .env("SPRITEBOOK_RESOURCES", runtime.join("assets"))
            .env(
                "SPRITEBOOK_UV_BIN",
                runtime.join(if cfg!(windows) { "uv.exe" } else { "uv" }),
            );
        Ok(cmd)
    }
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
async fn run_cli(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, Arc<Jobs>>,
    job_id: String,
    args: Vec<String>,
) -> Result<i32, String> {
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = cli_command(&app)?;
        cmd.arg("--owned-start")
            .args(&args)
            .arg("--log-append")
            .arg(session_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());
        let mut job = match jobs.start(job_id.clone(), &mut cmd) {
            Ok(job) => job,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => return Ok(130),
            Err(e) => return Err(format!("start owned CLI: {e}")),
        };
        job.child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(b"start\n")
            .map_err(|e| e.to_string())?;
        let stdout = job.child.stdout.take().ok_or("no stdout")?;
        let stderr = job.child.stderr.take().ok_or("no stderr")?;
        let diagnostics_app = app.clone();
        let diagnostic_id = job_id.clone();
        let diagnostics = std::thread::spawn(move || -> Result<(), String> {
            let safe_id: String = diagnostic_id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            let path = session_path().with_extension(format!("{safe_id}.stderr.log"));
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok();
            for line in std::io::BufReader::new(stderr).lines() {
                let line = line.map_err(|e| e.to_string())?;
                let _ = diagnostics_app.emit(&format!("cli-stderr:{diagnostic_id}"), &line);
                if let Some(file) = file.as_mut() {
                    let _ = writeln!(file, "{line}");
                }
            }
            Ok(())
        });
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.map_err(|e| e.to_string())?;
            let _ = app.emit(&format!("cli:{job_id}"), &line);
        }
        let status = job.child.wait().map_err(|e| e.to_string())?;
        diagnostics.join().map_err(|_| "stderr reader failed")??;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_cli(jobs: tauri::State<'_, Arc<Jobs>>, job_id: String) {
    jobs.cancel(job_id);
}

fn core_query(app: &tauri::AppHandle, args: &[&str]) -> Result<serde_json::Value, String> {
    let mut cmd = cli_command(app)?;
    cmd.arg("workspace")
        .args(args)
        .arg("--json")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().map_err(|e| format!("workspace query: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("workspace query returned invalid JSON: {e}"))
}

#[tauri::command]
async fn list_workspaces(app: tauri::AppHandle, root: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        core_query(&app, &["--root", &display_path(Path::new(&root))])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_thumb(app: tauri::AppHandle, dir: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::from_value(core_query(
            &app,
            &["--workspace", &display_path(Path::new(&dir)), "--thumb"],
        )?)
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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

/// The rig's deform report, verbatim — a core-written artifact the Rig stage
/// projects (like character.json, the FILE is the interface).
#[tauri::command]
fn read_rig_report(dir: String) -> Result<Option<serde_json::Value>, String> {
    let p = Path::new(&dir).join("rig/deform-report.json");
    match std::fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("deform-report.json is not JSON: {e}")),
        Err(_) => Ok(None),
    }
}

/// Core selects lastBakeId and reads its artifact under the workspace recovery lock.
#[tauri::command]
async fn read_bake_atlas(
    app: tauri::AppHandle,
    dir: String,
    pass: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = core_query(
            &app,
            &[
                "--workspace",
                &display_path(Path::new(&dir)),
                "--atlas",
                "--pass",
                pass.as_deref().unwrap_or("lit"),
            ],
        )?;
        Ok(if value.is_null() { None } else { Some(value) })
    })
    .await
    .map_err(|e| e.to_string())?
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

/// A canonical glTF for the inspection viewport. The viewport skill's asset
/// rule: canonical meshes from the workspace only — never a raw user upload,
/// because the importer border has already normalized format, orientation and
/// scale. The extension allowlist enforces it, and the size ceiling keeps a
/// pathological file from wedging the IPC channel it rides on.
#[tauri::command]
fn read_mesh(path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    const MAX_BYTES: u64 = 128 * 1024 * 1024;
    let p = PathBuf::from(&path);
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("glb") | Some("gltf") => {}
        _ => return Ok(None),
    }
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "{path} is {:.1} MB; the viewport reads up to {} MB over the IPC channel",
            meta.len() as f64 / 1_048_576.0,
            MAX_BYTES / 1_048_576
        ));
    }
    match std::fs::read(&p) {
        Ok(bytes) => Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Err(e) => Err(format!("could not read {path}: {e}")),
    }
}

/// Write a joint-edits patch the `rig --edits` verb will read back. The ONLY
/// write this shell performs, and it is scoped: a patch.json inside the
/// character's own rig directory, never an arbitrary path.
#[tauri::command]
fn write_rig_edits(dir: String, json: String) -> Result<String, String> {
    let rig_dir = PathBuf::from(&dir).join("rig");
    std::fs::create_dir_all(&rig_dir).map_err(|e| e.to_string())?;
    let path = rig_dir.join("joint-edits.json");
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(display_path(&path))
}

/// Reveal a produced folder in the OS file manager — the Export stage's
/// done-state affordance. Refuses anything that is not an existing directory,
/// so it can never become a general "run this" hole.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&p);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&p);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&p);
        c
    };
    // explorer.exe returns 1 even on success; spawning is the whole contract
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {path}: {e}"))
}

#[cfg(feature = "renderer-qualification")]
fn main() {
    std::process::exit(qualification::run());
}

#[cfg(not(feature = "renderer-qualification"))]
fn main() {
    tauri::Builder::default()
        .manage(Arc::new(Jobs::default()))
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<Jobs>>().cancel_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_cli,
            cancel_cli,
            list_workspaces,
            read_thumb,
            read_prev_session,
            read_image,
            read_rig_report,
            read_bake_atlas,
            open_folder,
            read_mesh,
            write_rig_edits
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
