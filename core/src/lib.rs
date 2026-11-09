//! Nexo core: device identity, screen capture, H.264 encoding, input injection and the
//! WebRTC host engine. Used by the Tauri desktop app and by the headless `nexo-hostd` agent.

pub mod auth;
pub mod capture;
pub mod convert;
pub mod encoder;
pub mod files;
pub mod host;
pub mod identity;
pub mod input;
pub mod keymap;
pub mod protocol;
pub mod settings;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Human-readable OS string ("Windows 11", "Linux", …).
pub fn os_name() -> String {
    match std::env::consts::OS {
        "windows" => "Windows".into(),
        "macos" => "macOS".into(),
        "linux" => "Linux".into(),
        o => o.into(),
    }
}

/// Best-effort host name.
pub fn hostname() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Computador".into())
}
