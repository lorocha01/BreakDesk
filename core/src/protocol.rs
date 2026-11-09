//! Wire types shared by the host engine, the Tauri shell and the headless agent.
//! Mirrors docs/PROTOCOL.md §4 and §5.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Permissions {
    pub input: bool,
    pub files: bool,
    pub chat: bool,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            input: true,
            files: true,
            chat: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Attended,
    Unattended,
}

/// ICE server as delivered by the signaling server (`urls` may be a string or a list).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct IceServer {
    #[serde(deserialize_with = "string_or_vec")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

fn string_or_vec<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Sv {
        S(String),
        V(Vec<String>),
    }
    Ok(match Sv::deserialize(d)? {
        Sv::S(s) => vec![s],
        Sv::V(v) => v,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: Option<String>,
    #[serde(default, rename = "sdpMLineIndex")]
    pub sdp_mline_index: Option<u16>,
}

/// `data` payload of a `signal` message (§4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalData {
    Ready,
    Offer {
        sdp: String,
        #[serde(default)]
        sig: String,
        #[serde(default)]
        restart: bool,
    },
    Answer {
        sdp: String,
        #[serde(default)]
        sig: String,
    },
    Ice {
        candidate: IceCandidate,
    },
    RestartRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    #[default]
    Auto,
    Quality,
    Balanced,
    Speed,
}

impl QualityPreset {
    pub fn bitrate_bps(self) -> u32 {
        match self {
            QualityPreset::Quality => 8_000_000,
            QualityPreset::Balanced | QualityPreset::Auto => 4_000_000,
            QualityPreset::Speed => 1_500_000,
        }
    }
}

/// Messages on the `control` data channel, viewer → host (§4.1).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "t")]
pub enum ControlIn {
    #[serde(rename = "auth")]
    Auth { password: String },
    #[serde(rename = "mm")]
    MouseMove { x: f64, y: f64 },
    #[serde(rename = "md")]
    MouseDown { b: u8 },
    #[serde(rename = "mu")]
    MouseUp { b: u8 },
    #[serde(rename = "wh")]
    Wheel {
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
    },
    #[serde(rename = "kd")]
    KeyDown {
        code: String,
        #[serde(default)]
        key: String,
    },
    #[serde(rename = "ku")]
    KeyUp {
        code: String,
        #[serde(default)]
        key: String,
    },
    #[serde(rename = "combo")]
    Combo { codes: Vec<String> },
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "monitor")]
    Monitor { index: usize },
    #[serde(rename = "quality")]
    Quality {
        #[serde(default)]
        preset: QualityPreset,
        #[serde(default = "default_fps")]
        fps: u32,
    },
    #[serde(rename = "viewport")]
    Viewport { w: u32, h: u32 },
    #[serde(rename = "keyframe")]
    Keyframe,
    #[serde(rename = "ping")]
    Ping {
        id: serde_json::Value,
        ts: serde_json::Value,
    },
    #[serde(rename = "chat")]
    Chat {
        #[serde(default)]
        id: String,
        text: String,
        #[serde(default)]
        ts: i64,
    },
}

fn default_fps() -> u32 {
    30
}

/// Messages on the `control` data channel, host → viewer (§4.1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t")]
pub enum ControlOut {
    #[serde(rename = "auth_required")]
    AuthRequired,
    #[serde(rename = "auth_result", rename_all = "camelCase")]
    AuthResult {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempts_left: Option<u32>,
    },
    #[serde(rename = "hello", rename_all = "camelCase")]
    Hello {
        host_name: String,
        os: String,
        monitors: Vec<MonitorInfo>,
        current: usize,
        permissions: Permissions,
    },
    #[serde(rename = "monitor_changed")]
    MonitorChanged {
        index: usize,
        width: u32,
        height: u32,
    },
    #[serde(rename = "stats", rename_all = "camelCase")]
    Stats {
        fps: f32,
        encode_ms: f32,
        bitrate_kbps: u32,
        width: u32,
        height: u32,
    },
    #[serde(rename = "pong")]
    Pong {
        id: serde_json::Value,
        ts: serde_json::Value,
    },
    #[serde(rename = "chat")]
    Chat { id: String, text: String, ts: i64 },
    #[serde(rename = "perm")]
    Perm { permissions: Permissions },
    #[serde(rename = "bye")]
    Bye { reason: String },
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_id() -> String {
    use rand::Rng;
    let n: u64 = rand::thread_rng().gen();
    format!("{n:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_in_parses_spec_examples() {
        let m: ControlIn = serde_json::from_str(r#"{"t":"mm","x":0.5,"y":0.25}"#).unwrap();
        assert_eq!(m, ControlIn::MouseMove { x: 0.5, y: 0.25 });
        let m: ControlIn = serde_json::from_str(r#"{"t":"kd","code":"KeyA","key":"a"}"#).unwrap();
        assert!(matches!(m, ControlIn::KeyDown { .. }));
        let m: ControlIn =
            serde_json::from_str(r#"{"t":"combo","codes":["ControlLeft","AltLeft","Delete"]}"#)
                .unwrap();
        assert!(matches!(m, ControlIn::Combo { codes } if codes.len() == 3));
        let m: ControlIn =
            serde_json::from_str(r#"{"t":"quality","preset":"speed","fps":60}"#).unwrap();
        assert_eq!(
            m,
            ControlIn::Quality {
                preset: QualityPreset::Speed,
                fps: 60
            }
        );
        let m: ControlIn = serde_json::from_str(r#"{"t":"keyframe"}"#).unwrap();
        assert_eq!(m, ControlIn::Keyframe);
    }

    #[test]
    fn control_out_serializes_camel_case() {
        let s = serde_json::to_string(&ControlOut::AuthResult {
            ok: false,
            reason: Some("bad_password".into()),
            attempts_left: Some(3),
        })
        .unwrap();
        assert_eq!(
            s,
            r#"{"t":"auth_result","ok":false,"reason":"bad_password","attemptsLeft":3}"#
        );
        let s = serde_json::to_string(&ControlOut::Stats {
            fps: 30.0,
            encode_ms: 4.5,
            bitrate_kbps: 2000,
            width: 1920,
            height: 1080,
        })
        .unwrap();
        assert!(s.contains(r#""encodeMs":4.5"#) && s.contains(r#""bitrateKbps":2000"#));
    }

    #[test]
    fn signal_data_roundtrip() {
        let d: SignalData = serde_json::from_str(r#"{"kind":"ready"}"#).unwrap();
        assert!(matches!(d, SignalData::Ready));
        let d: SignalData = serde_json::from_str(
            r#"{"kind":"ice","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0}}"#,
        )
        .unwrap();
        match d {
            SignalData::Ice { candidate } => assert_eq!(candidate.sdp_mline_index, Some(0)),
            _ => panic!(),
        }
        let d: SignalData = serde_json::from_str(r#"{"kind":"restart_request"}"#).unwrap();
        assert!(matches!(d, SignalData::RestartRequest));
        let s = serde_json::to_string(&SignalData::Offer {
            sdp: "v=0".into(),
            sig: "x".into(),
            restart: true,
        })
        .unwrap();
        assert_eq!(
            s,
            r#"{"kind":"offer","sdp":"v=0","sig":"x","restart":true}"#
        );
    }

    #[test]
    fn ice_server_urls_string_or_list() {
        let s: IceServer = serde_json::from_str(r#"{"urls":"stun:a:3478"}"#).unwrap();
        assert_eq!(s.urls, vec!["stun:a:3478"]);
        let s: IceServer =
            serde_json::from_str(r#"{"urls":["turn:a:3478"],"username":"u","credential":"c"}"#)
                .unwrap();
        assert_eq!(s.username.as_deref(), Some("u"));
    }
}
