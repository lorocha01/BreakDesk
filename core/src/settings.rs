//! Persistent settings (`settings.json`), secrets (`secrets.json`) and the local audit log
//! (`audit.jsonl`), all inside the application config directory. Matches PROTOCOL.md §5.

use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use crate::protocol::{now_ms, Permissions, QualityPreset};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub struct UnattendedSettings {
    pub enabled: bool,
    /// Read-only: derived from secrets.json.
    pub has_password: bool,
    pub allowed_device_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server_url: String,
    pub device_name: String,
    pub theme: String,
    pub launch_on_startup: bool,
    pub quality: QualityPreset,
    pub fps: u32,
    pub audio_enabled: bool,
    pub default_permissions: Permissions,
    pub unattended: UnattendedSettings,
    pub receive_dir: String,
    pub auto_update: bool,
    /// deviceId → base64 public key pinned on first use (TOFU).
    pub trusted_keys: BTreeMap<String, String>,
    /// Unknown keys written by newer UIs are preserved.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:8080".into(),
            device_name: String::new(),
            theme: "system".into(),
            launch_on_startup: false,
            quality: QualityPreset::Auto,
            fps: 30,
            audio_enabled: false,
            default_permissions: Permissions::default(),
            unattended: UnattendedSettings::default(),
            receive_dir: String::new(),
            auto_update: true,
            trusted_keys: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

impl Settings {
    pub fn sanitize(&mut self) {
        if ![15, 30, 60].contains(&self.fps) {
            self.fps = self.fps.clamp(5, 60);
        }
        if !["system", "light", "dark"].contains(&self.theme.as_str()) {
            self.theme = "system".into();
        }
        self.unattended
            .allowed_device_ids
            .retain(|id| id.len() == 9 && id.chars().all(|c| c.is_ascii_digit()));
    }

    /// Effective receive directory (`receiveDir` or `~/Downloads/Nexo`).
    pub fn receive_dir_path(&self) -> PathBuf {
        if !self.receive_dir.trim().is_empty() {
            return PathBuf::from(self.receive_dir.trim());
        }
        default_receive_dir()
    }
}

pub fn default_receive_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir)
        .join("Nexo")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    /// Argon2id PHC string of the unattended-access password.
    pub unattended_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub ts: i64,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    #[serde(default)]
    pub detail: serde_json::Value,
}

/// File-backed store rooted at the app config dir.
pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            lock: Mutex::new(()),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn load_settings(&self) -> Settings {
        let _g = self.lock.lock();
        let mut s: Settings = read_json(&self.dir.join("settings.json")).unwrap_or_default();
        s.unattended.has_password = self.load_secrets_unlocked().unattended_hash.is_some();
        s.sanitize();
        s
    }

    pub fn save_settings(&self, s: &Settings) -> Result<Settings> {
        let _g = self.lock.lock();
        let mut s = s.clone();
        s.sanitize();
        s.unattended.has_password = self.load_secrets_unlocked().unattended_hash.is_some();
        write_json_atomic(&self.dir.join("settings.json"), &s)?;
        Ok(s)
    }

    fn load_secrets_unlocked(&self) -> Secrets {
        read_json(&self.dir.join("secrets.json")).unwrap_or_default()
    }

    pub fn load_secrets(&self) -> Secrets {
        let _g = self.lock.lock();
        self.load_secrets_unlocked()
    }

    pub fn save_secrets(&self, s: &Secrets) -> Result<()> {
        let _g = self.lock.lock();
        write_json_atomic(&self.dir.join("secrets.json"), s)
    }

    pub fn audit(
        &self,
        event: &str,
        session_id: Option<&str>,
        peer_id: Option<&str>,
        detail: serde_json::Value,
    ) {
        let ev = AuditEvent {
            ts: now_ms(),
            event: event.to_string(),
            session_id: session_id.map(str::to_string),
            peer_id: peer_id.map(str::to_string),
            detail,
        };
        let _g = self.lock.lock();
        let path = self.dir.join("audit.jsonl");
        let res = (|| -> Result<()> {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            writeln!(f, "{}", serde_json::to_string(&ev)?)?;
            Ok(())
        })();
        if let Err(e) = res {
            tracing::warn!("audit write failed: {e}");
        }
        // Keep the log bounded (~5 MB).
        if std::fs::metadata(&path)
            .map(|m| m.len() > 5 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&path, self.dir.join("audit.1.jsonl"));
        }
    }

    /// Most recent events first.
    pub fn audit_list(&self, limit: usize) -> Vec<AuditEvent> {
        let _g = self.lock.lock();
        let Ok(f) = std::fs::File::open(self.dir.join("audit.jsonl")) else {
            return vec![];
        };
        let mut all: Vec<AuditEvent> = std::io::BufReader::new(f)
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str(&l).ok())
            .collect();
        all.reverse();
        all.truncate(limit);
        all
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let txt = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&txt) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("ignoring malformed {}: {e}", path.display());
            None
        }
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_json_matches_spec_shape() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        for k in [
            "serverUrl",
            "deviceName",
            "theme",
            "launchOnStartup",
            "quality",
            "fps",
            "audioEnabled",
            "defaultPermissions",
            "unattended",
            "receiveDir",
            "autoUpdate",
            "trustedKeys",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["unattended"]["allowedDeviceIds"], serde_json::json!([]));
        assert_eq!(v["quality"], "auto");
    }

    #[test]
    fn roundtrip_and_has_password_is_derived() {
        let dir = tempfile::tempdir().unwrap();
        let st = Store::new(dir.path()).unwrap();
        let mut s = st.load_settings();
        assert!(!s.unattended.has_password);
        s.unattended.has_password = true; // UI cannot fake it
        s.unattended.allowed_device_ids = vec!["123456789".into(), "bad".into()];
        s.extra.insert("futureKey".into(), serde_json::json!(1));
        let saved = st.save_settings(&s).unwrap();
        assert!(!saved.unattended.has_password);
        assert_eq!(
            saved.unattended.allowed_device_ids,
            vec!["123456789".to_string()]
        );
        st.save_secrets(&Secrets {
            unattended_hash: Some("$argon2id$x".into()),
        })
        .unwrap();
        let s2 = st.load_settings();
        assert!(s2.unattended.has_password);
        assert_eq!(s2.extra.get("futureKey"), Some(&serde_json::json!(1)));
    }

    #[test]
    fn audit_append_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let st = Store::new(dir.path()).unwrap();
        st.audit("a", Some("s1"), Some("111111111"), serde_json::json!({}));
        st.audit("b", None, None, serde_json::json!({"x":1}));
        let l = st.audit_list(10);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].event, "b");
        assert_eq!(st.audit_list(1).len(), 1);
    }
}
