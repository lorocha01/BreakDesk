//! nexo-hostd — headless unattended host agent.
//!
//! Registers this machine with a Nexo server, keeps a signaling connection open and accepts
//! **only unattended** requests, which must then authenticate end-to-end with the configured
//! password over the encrypted data channel. Attended requests are rejected (`not_allowed`),
//! because nobody is in front of the screen to approve them.
//!
//! `--selftest N` captures and encodes N frames locally (no server) and prints timings.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use nexo_core::auth::{hash_password, AuthGuard};
use nexo_core::host::{ChatMessage, HostConfig, HostEvents, HostSession, HostState, TransferEvent};
use nexo_core::identity::{self, Identity};
use nexo_core::input::InputHandle;
use nexo_core::protocol::{
    IceCandidate, IceServer, Permissions, QualityPreset, SessionMode, SignalData,
};
use nexo_core::settings::Store;

#[derive(Parser, Debug)]
#[command(
    name = "nexo-hostd",
    version,
    about = "Nexo headless unattended host agent"
)]
struct Args {
    /// Server base URL (http(s)://host:port)
    #[arg(long, env = "NEXO_SERVER", default_value = "http://localhost:8080")]
    server: String,
    /// Directory for the device key, audit log and received files
    #[arg(long, env = "NEXO_DATA_DIR", default_value = "./nexo-hostd-data")]
    data_dir: PathBuf,
    /// Unattended-access password (min. 8 chars). Prefer the NEXO_PASSWORD env var.
    #[arg(long, env = "NEXO_PASSWORD", hide_env_values = true)]
    password: Option<String>,
    /// Device name shown to viewers
    #[arg(long, env = "NEXO_NAME")]
    name: Option<String>,
    /// Only these viewer IDs may connect (repeatable or comma-separated)
    #[arg(long, value_delimiter = ',')]
    allow: Vec<String>,
    /// Folder for uploaded files (default: <data-dir>/received)
    #[arg(long)]
    receive_dir: Option<PathBuf>,
    #[arg(long, default_value_t = 30)]
    fps: u32,
    /// Disable remote input (view-only)
    #[arg(long)]
    view_only: bool,
    /// Capture+encode N frames locally and exit (no server)
    #[arg(long, value_name = "FRAMES")]
    selftest: Option<u32>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "info,webrtc=warn,webrtc_ice=error,webrtc_sctp=warn,webrtc_dtls=warn".into()
            }),
        )
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    if let Some(n) = args.selftest {
        return selftest(n.max(1));
    }
    let password = args
        .password
        .clone()
        .ok_or_else(|| anyhow!("--password or NEXO_PASSWORD is required"))?;
    if password.chars().count() < 8 {
        bail!("password must have at least 8 characters");
    }
    let agent = Agent::new(args, &password)?;
    agent.run().await
}

fn selftest(frames: u32) -> Result<()> {
    use nexo_core::capture::{list_monitors, open_capturer};
    use nexo_core::convert::{to_i420, I420Frame};
    use nexo_core::encoder::{EncoderParams, H264Encoder};
    use nexo_core::host::stream::encode_size;

    let monitors = list_monitors()?;
    for m in &monitors {
        println!(
            "monitor #{} {:?} {}x{} @({},{}) scale={} primary={}",
            m.index, m.name, m.width, m.height, m.x, m.y, m.scale, m.primary
        );
    }
    let mut cap = open_capturer(0)?;
    let mut frame = I420Frame::new();
    let mut enc: Option<H264Encoder> = None;
    let (mut total, mut keyframes, mut t_cap, mut t_conv, mut t_enc) =
        (0usize, 0u32, 0f64, 0f64, 0f64);
    let start = Instant::now();
    for i in 0..frames {
        let t0 = Instant::now();
        let raw = cap.capture()?;
        let t1 = Instant::now();
        let (w, h) = encode_size(
            raw.width as u32,
            raw.height as u32,
            QualityPreset::Balanced,
            (0, 0),
        );
        to_i420(
            &raw.data, raw.width, raw.height, raw.stride, raw.order, w as usize, h as usize,
            &mut frame,
        );
        let t2 = Instant::now();
        let e = enc.get_or_insert_with(|| {
            H264Encoder::new(EncoderParams {
                width: w,
                height: h,
                bitrate_bps: 4_000_000,
                fps: 30,
            })
            .expect("encoder")
        });
        let out = e.encode(&frame)?;
        let t3 = Instant::now();
        t_cap += (t1 - t0).as_secs_f64();
        t_conv += (t2 - t1).as_secs_f64();
        t_enc += (t3 - t2).as_secs_f64();
        match out {
            Some(f) => {
                total += f.data.len();
                keyframes += f.keyframe as u32;
                if i < 3 || f.keyframe {
                    println!(
                        "frame {i}: {}x{} -> {w}x{h} {} bytes{}",
                        raw.width,
                        raw.height,
                        f.data.len(),
                        if f.keyframe { " (IDR)" } else { "" }
                    );
                }
            }
            None => println!("frame {i}: skipped by rate control"),
        }
    }
    let secs = start.elapsed().as_secs_f64();
    let n = frames as f64;
    println!(
        "SELFTEST OK frames={frames} bytes={total} keyframes={keyframes} fps={:.1} capture={:.1}ms convert={:.1}ms encode={:.1}ms",
        n / secs,
        t_cap / n * 1000.0,
        t_conv / n * 1000.0,
        t_enc / n * 1000.0
    );
    Ok(())
}

/// Outbound WS messages produced by the host engine.
struct WsEvents {
    tx: mpsc::UnboundedSender<Value>,
    identity: Arc<Identity>,
}

impl HostEvents for WsEvents {
    fn on_offer(&self, session_id: &str, sdp: &str, restart: bool) {
        let sig = self
            .identity
            .sign(&identity::sdp_message(session_id, "offer", sdp));
        let data = SignalData::Offer {
            sdp: sdp.to_string(),
            sig,
            restart,
        };
        let _ = self
            .tx
            .send(json!({"type":"signal","sessionId":session_id,"data":data}));
    }
    fn on_ice(&self, session_id: &str, candidate: IceCandidate) {
        let _ = self.tx.send(
            json!({"type":"signal","sessionId":session_id,"data":SignalData::Ice{candidate}}),
        );
    }
    fn on_state(&self, session_id: &str, state: HostState, detail: Option<String>) {
        tracing::info!(session = session_id, ?state, ?detail, "host state");
    }
    fn on_chat(&self, session_id: &str, msg: ChatMessage) {
        tracing::info!(session = session_id, "chat from viewer: {}", msg.text);
    }
    fn on_transfer(&self, session_id: &str, ev: TransferEvent) {
        if !matches!(ev.state, nexo_core::host::TransferState::Active) {
            tracing::info!(
                session = session_id,
                "transfer {:?} {} {:?} {}/{}",
                ev.direction,
                ev.name,
                ev.state,
                ev.bytes,
                ev.total
            );
        }
    }
    fn on_auth(&self, session_id: &str, ok: bool, viewer_id: &str) {
        tracing::info!(
            session = session_id,
            viewer = viewer_id,
            ok,
            "unattended auth"
        );
        let _ = self.tx.send(json!({
            "type":"audit","sessionId":session_id,
            "event": if ok {"unattended_auth_ok"} else {"unattended_auth_failed"},
            "detail": {"viewerId": viewer_id}
        }));
    }
    fn on_ended(&self, session_id: &str, reason: &str) {
        let _ = self
            .tx
            .send(json!({"type":"end","sessionId":session_id,"reason":reason}));
    }
}

struct Active {
    session: HostSession,
    peer_public_key: String,
}

struct Agent {
    args: Args,
    http: reqwest::Client,
    identity: Arc<Identity>,
    store: Arc<Store>,
    hash: String,
    guard: Arc<AuthGuard>,
    input: InputHandle,
    name: String,
    base: String,
}

impl Agent {
    fn new(args: Args, password: &str) -> Result<Self> {
        let identity = Arc::new(Identity::load_or_create(&args.data_dir)?);
        let store = Arc::new(Store::new(&args.data_dir)?);
        let name = args.name.clone().unwrap_or_else(nexo_core::hostname);
        let base = args.server.trim_end_matches('/').to_string();
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            identity,
            store,
            hash: hash_password(password)?,
            guard: Arc::new(AuthGuard::new()),
            input: InputHandle::spawn(),
            name,
            base,
            args,
        })
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let r = self
            .http
            .post(format!("{}/api/v1{path}", self.base))
            .json(&body)
            .send()
            .await?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("{path}: HTTP {status}: {v}");
        }
        Ok(v)
    }

    async fn register(&self) -> Result<String> {
        let v = self
            .post(
                "/devices/register",
                json!({
                    "publicKey": self.identity.public_key_b64(),
                    "name": self.name,
                    "os": nexo_core::os_name(),
                    "appVersion": format!("hostd-{}", nexo_core::APP_VERSION),
                }),
            )
            .await?;
        v["deviceId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("register: no deviceId"))
    }

    async fn token(&self, device_id: &str) -> Result<String> {
        let ch = self
            .post("/auth/device/challenge", json!({"deviceId": device_id}))
            .await?;
        let nonce = ch["nonce"].as_str().context("nonce")?;
        let sig = self
            .identity
            .sign(&identity::auth_message(nonce, device_id));
        let t = self
            .post(
                "/auth/device/token",
                json!({"challengeId": ch["challengeId"], "deviceId": device_id, "signature": sig}),
            )
            .await?;
        t["token"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("no token"))
    }

    async fn run(self) -> Result<()> {
        let mut backoff = Duration::from_secs(1);
        let device_id = loop {
            match self.register().await {
                Ok(id) => break id,
                Err(e) => {
                    tracing::warn!("register failed: {e:#}; retrying in {backoff:?}");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                }
            }
        };
        println!("NEXO_ID={device_id}");
        println!("NEXO_FINGERPRINT={}", self.identity.fingerprint());
        let mut active: Option<(String, Active)> = None;
        let mut backoff = Duration::from_secs(1);
        loop {
            match self.connect_once(&device_id, &mut active).await {
                Ok(()) => backoff = Duration::from_secs(1),
                Err(e) => tracing::warn!("signaling: {e:#}"),
            }
            tracing::info!("reconnecting in {backoff:?}");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(15));
        }
    }

    async fn connect_once(
        &self,
        device_id: &str,
        active: &mut Option<(String, Active)>,
    ) -> Result<()> {
        let token = self.token(device_id).await?;
        let ws_base = if let Some(r) = self.base.strip_prefix("https://") {
            format!("wss://{r}")
        } else if let Some(r) = self.base.strip_prefix("http://") {
            format!("ws://{r}")
        } else {
            self.base.clone()
        };
        let (ws, _) =
            tokio_tungstenite::connect_async(format!("{ws_base}/ws?token={token}")).await?;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        tracing::info!("signaling connected");
        let mut ping = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                out = rx.recv() => {
                    let Some(v) = out else { break };
                    if v["type"] == "end" {
                        if let Some((sid, a)) = active.take() {
                            a.session.stop(v["reason"].as_str().unwrap_or("ended")).await;
                            tracing::info!("session {sid} ended by host engine");
                        }
                    }
                    sink.send(Message::Text(v.to_string().into())).await?;
                }
                _ = ping.tick() => {
                    sink.send(Message::Text(json!({"type":"ping","ts":nexo_core::protocol::now_ms()}).to_string().into())).await?;
                }
                msg = stream.next() => {
                    let Some(msg) = msg else { break };
                    match msg? {
                        Message::Text(t) => {
                            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                            self.handle(v, &tx, active).await;
                        }
                        Message::Close(c) => {
                            tracing::warn!("server closed socket: {c:?}");
                            if c.as_ref().is_some_and(|c| u16::from(c.code) == 4001) {
                                bail!("replaced by another connection with the same device id");
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle(
        &self,
        v: Value,
        tx: &mpsc::UnboundedSender<Value>,
        active: &mut Option<(String, Active)>,
    ) {
        let typ = v["type"].as_str().unwrap_or("");
        let sid = v["sessionId"].as_str().unwrap_or("").to_string();
        match typ {
            "welcome" => tracing::info!("welcome as {}", v["deviceId"]),
            "active_sessions" => {
                for s in v["sessions"].as_array().cloned().unwrap_or_default() {
                    let id = s["sessionId"].as_str().unwrap_or("");
                    let ours = active.as_ref().is_some_and(|(a, _)| a == id);
                    if !ours {
                        let _ =
                            tx.send(json!({"type":"end","sessionId":id,"reason":"host_restarted"}));
                    }
                }
            }
            "incoming" => {
                let viewer = v["viewer"]["deviceId"].as_str().unwrap_or("").to_string();
                let not_allowed = v["mode"] != "unattended"
                    || (!self.args.allow.is_empty() && !self.args.allow.contains(&viewer));
                let reason = if not_allowed {
                    Some("not_allowed")
                } else if self.guard.blocked_remaining(&viewer).is_some() {
                    Some("blocked")
                } else if active.is_some() {
                    Some("busy")
                } else {
                    None
                };
                self.store.audit(
                    "incoming",
                    Some(&sid),
                    Some(&viewer),
                    json!({"mode": v["mode"], "rejected": reason}),
                );
                if let Some(r) = reason {
                    tracing::info!("rejecting {sid} from {viewer}: {r}");
                    let _ = tx.send(json!({"type":"reject","sessionId":sid,"reason":r}));
                } else {
                    let perms = Permissions {
                        input: !self.args.view_only,
                        files: true,
                        chat: true,
                    };
                    let _ = tx.send(json!({"type":"accept","sessionId":sid,"permissions":perms}));
                }
            }
            "session_started" => {
                if v["role"] != "host" {
                    return;
                }
                if active.as_ref().is_some_and(|(a, _)| a == &sid) {
                    return; // resumed after a reconnect
                }
                if let Some((old, a)) = active.take() {
                    a.session.stop("replaced").await;
                    let _ = tx.send(json!({"type":"end","sessionId":old,"reason":"replaced"}));
                }
                let ice: Vec<IceServer> =
                    serde_json::from_value(v["iceServers"].clone()).unwrap_or_default();
                let perms: Permissions =
                    serde_json::from_value(v["permissions"].clone()).unwrap_or_default();
                let peer = &v["peer"];
                let cfg = HostConfig {
                    session_id: sid.clone(),
                    mode: SessionMode::Unattended,
                    ice_servers: ice,
                    permissions: perms,
                    viewer_id: peer["deviceId"].as_str().unwrap_or("").into(),
                    viewer_name: peer["name"].as_str().unwrap_or("").into(),
                    host_name: self.name.clone(),
                    os: nexo_core::os_name(),
                    unattended_hash: Some(self.hash.clone()),
                    allowed_device_ids: self.args.allow.clone(),
                    auth_guard: self.guard.clone(),
                    receive_dir: self
                        .args
                        .receive_dir
                        .clone()
                        .unwrap_or_else(|| self.args.data_dir.join("received")),
                    quality: QualityPreset::Auto,
                    fps: self.args.fps,
                    store: Some(self.store.clone()),
                    input: self.input.clone(),
                };
                let events = Arc::new(WsEvents {
                    tx: tx.clone(),
                    identity: self.identity.clone(),
                });
                let session = HostSession::start(cfg, events);
                tracing::info!("session {sid} started with viewer {}", peer["deviceId"]);
                *active = Some((
                    sid,
                    Active {
                        session,
                        peer_public_key: peer["publicKey"].as_str().unwrap_or("").to_string(),
                    },
                ));
            }
            "signal" => {
                let Some((asid, a)) = active.as_ref() else {
                    return;
                };
                if asid != &sid {
                    return;
                }
                let data: SignalData = match serde_json::from_value(v["data"].clone()) {
                    Ok(d) => d,
                    Err(e) => return tracing::warn!("bad signal: {e}"),
                };
                if let SignalData::Answer { sdp, sig } = &data {
                    let msg = identity::sdp_message(&sid, "answer", sdp);
                    if !identity::verify(&a.peer_public_key, &msg, sig) {
                        tracing::error!("answer signature invalid — possible MITM; ending session");
                        let (_, a) = active.take().unwrap();
                        a.session.stop("bad_signature").await;
                        let _ =
                            tx.send(json!({"type":"end","sessionId":sid,"reason":"bad_signature"}));
                        return;
                    }
                }
                if let Err(e) = a.session.signal(data).await {
                    tracing::warn!("signal: {e:#}");
                }
            }
            "session_ended" => {
                if active.as_ref().is_some_and(|(a, _)| a == &sid) {
                    let (_, a) = active.take().unwrap();
                    a.session
                        .stop(v["reason"].as_str().unwrap_or("ended"))
                        .await;
                    tracing::info!("session {sid} ended: {}", v["reason"]);
                }
            }
            "peer_status" => tracing::info!("peer online={} for {sid}", v["online"]),
            "error" => tracing::warn!("server error: {} {}", v["code"], v["message"]),
            "pong" => {}
            other => tracing::debug!("unhandled message {other}"),
        }
    }
}
