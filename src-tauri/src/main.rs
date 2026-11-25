// Esconde a janela de console no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod bridge;
mod firewall;
mod links;
mod sharebar;

fn main() {
    tauri::Builder::default()
        .manage(audio::AudioState::default())
        .manage(bridge::BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            audio::start_system_audio,
            audio::stop_system_audio,
            sharebar::hide_share_bar,
            links::open_url,
            bridge::start_bridge,
            bridge::stop_bridge,
            firewall::ensure_firewall
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Telinha");
}
