#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod vault;

use notify::{RecursiveMode, Watcher, RecommendedWatcher, Event};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use serde::{Deserialize, Serialize};

struct AppState {
    vault_path: Mutex<Option<String>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultInfo {
    path: String,
    exists: bool,
}

/// Auto-discover Obsidian vaults by scanning common directories
/// for folders containing a .obsidian config directory.
#[tauri::command]
fn discover_vaults() -> Result<std::collections::HashMap<String, VaultInfo>, String> {
    let mut vaults = std::collections::HashMap::new();
    let mut roots = Vec::new();

    // Home directory + common subdirs
    if let Some(home) = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
    {
        roots.push(home.clone());
        roots.push(format!("{}/Documents", home));
        roots.push(format!("{}/Desktop", home));
    }

    // Scan all available Windows drive letters
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
        let drive = format!("{}:\\", letter);
        if std::path::Path::new(&drive).exists() {
            roots.push(drive.clone());
            // Also check common user folders on each drive
            if let Ok(entries) = std::fs::read_dir(&drive) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with("Users") || name.starts_with("users") {
                            let users_dir = entry.path();
                            if let Ok(users) = std::fs::read_dir(&users_dir) {
                                for user in users.flatten() {
                                    if user.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                                        let user_name = user.file_name().to_string_lossy().to_string();
                                        if user_name.starts_with('.') || user_name == "Public" || user_name == "Default" {
                                            continue;
                                        }
                                        let user_path = user.path();
                                        roots.push(user_path.to_string_lossy().to_string());
                                        roots.push(format!("{}/Documents", user_path.to_string_lossy()));
                                        roots.push(format!("{}/Desktop", user_path.to_string_lossy()));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Scan each root for .obsidian folders
    for root in &roots {
        let root_path = std::path::Path::new(root);
        if !root_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(root_path) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let vault_path = entry.path();
                let obsidian_dir = vault_path.join(".obsidian");
                if obsidian_dir.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let path_str = vault_path.to_string_lossy().to_string();
                    let exists = vault_path.exists();
                    vaults.insert(name, VaultInfo { path: path_str, exists });
                }
            }
        }
    }

    Ok(vaults)
}

#[tauri::command]
fn load_vault(path: String, state: State<AppState>) -> Result<vault::Graph, String> {
    let graph = vault::build_graph(&path)?;
    *state.vault_path.lock().unwrap() = Some(path);
    Ok(graph)
}

#[tauri::command]
fn refresh_graph(state: State<AppState>) -> Result<vault::Graph, String> {
    let path = state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault loaded")?;
    vault::build_graph(&path)
}

#[tauri::command]
fn read_note(rel_id: String, state: State<AppState>) -> Result<String, String> {
    let root = state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault loaded")?;
    let full = std::path::Path::new(&root).join(format!("{rel_id}.md"));
    std::fs::read_to_string(full).map_err(|e| e.to_string())
}

/// Start watching the vault; debounced "vault-changed" events fire to the frontend.
#[tauri::command]
fn watch_vault(path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let app_handle = app.clone();
    let last_fire = Mutex::new(Instant::now() - Duration::from_secs(10));

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let relevant = event.paths.iter().any(|p| {
                p.extension().and_then(|e| e.to_str()) == Some("md")
            });
            if !relevant {
                return;
            }
            let mut last = last_fire.lock().unwrap();
            if last.elapsed() > Duration::from_millis(400) {
                *last = Instant::now();
                let _ = app_handle.emit("vault-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            vault_path: Mutex::new(None),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            discover_vaults,
            load_vault,
            refresh_graph,
            read_note,
            watch_vault
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            let _ = win.set_title("VaultCity");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VaultCity");
}
