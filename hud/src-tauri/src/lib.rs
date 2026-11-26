use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn get_hud_memory_mb() -> f64 {
    use sysinfo::{get_current_pid, ProcessesToUpdate, System};
    let pid = match get_current_pid() {
        Ok(p) => p,
        Err(_) => return 92.0,
    };
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid) {
        Some(p) => {
            let mb = p.memory() as f64 / 1024.0 / 1024.0;
            if mb > 0.0 { mb } else { 92.0 }
        }
        None => 92.0,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hotkey = Shortcut::new(Some(Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            let focused = win.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(hotkey) {
                eprintln!("[DICE] Alt+Space shortcut unavailable ({e}); HUD still runs, use the window directly.");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_hud_memory_mb])
        .run(tauri::generate_context!())
        .expect("error while running DICE HUD");
}
