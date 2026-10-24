use rig_core::RuntimeStore;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
fn rig_call(state: State<'_, Mutex<RuntimeStore>>, request: &str) -> String {
    match state.lock() {
        Ok(mut store) => store.call_json(request),
        Err(_) => "{\"ok\":false,\"error\":\"Rust runtime lock is poisoned\"}".into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeStore::default()))
        .invoke_handler(tauri::generate_handler![rig_call])
        .run(tauri::generate_context!())
        .expect("error while running YappyTuberPlus");
}
