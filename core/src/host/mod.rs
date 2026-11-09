//! Host side of a remote session: WebRTC offerer streaming H.264 and receiving input/files.
//! See PROTOCOL.md §4.

mod files;
pub mod stream;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::auth::{AuthGuard, AuthOutcome};
use crate::input::{InputCmd, InputHandle};
use crate::protocol::{
    now_ms, random_id, ControlIn, ControlOut, IceCandidate, IceServer, Permissions, QualityPreset,
    SessionMode, SignalData,
};
use crate::settings::Store;
use files::{FilesMsg, FilesState};
use stream::{EncodedSample, StreamEvent, StreamShared};

pub const H264_FMTP: &str =
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const RECONNECT_GIVE_UP: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Connecting,
    AwaitingAuth,
    Streaming,
    Reconnecting,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Active,
    Done,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransferEvent {
    pub id: u32,
    pub direction: Direction,
    pub name: String,
    pub bytes: u64,
    pub total: u64,
    pub state: TransferState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub id: String,
    pub text: String,
    pub ts: i64,
}

/// Sink for everything the host engine needs to tell the outside world.
/// The Tauri shell maps these to `host://*` events; the headless agent to WS signaling.
pub trait HostEvents: Send + Sync + 'static {
    /// Unsigned SDP offer; the receiver signs it and relays `signal {kind:'offer'}`.
    fn on_offer(&self, session_id: &str, sdp: &str, restart: bool);
    fn on_ice(&self, session_id: &str, candidate: IceCandidate);
    fn on_state(&self, session_id: &str, state: HostState, detail: Option<String>);
    fn on_chat(&self, session_id: &str, msg: ChatMessage);
    fn on_transfer(&self, session_id: &str, ev: TransferEvent);
    fn on_auth(&self, session_id: &str, ok: bool, viewer_id: &str);
    /// The engine ended the session by itself (auth lockout, connection lost, …).
    fn on_ended(&self, session_id: &str, reason: &str);
}

pub struct HostConfig {
    pub session_id: String,
    pub mode: SessionMode,
    pub ice_servers: Vec<IceServer>,
    pub permissions: Permissions,
    pub viewer_id: String,
    pub viewer_name: String,
    pub host_name: String,
    pub os: String,
    /// Argon2id hash of the unattended password (required for `unattended`).
    pub unattended_hash: Option<String>,
    /// If non-empty, only these viewer ids may use unattended access.
    pub allowed_device_ids: Vec<String>,
    pub auth_guard: Arc<AuthGuard>,
    pub receive_dir: PathBuf,
    pub quality: QualityPreset,
    pub fps: u32,
    pub store: Option<Arc<Store>>,
    pub input: InputHandle,
}

struct PcState {
    pc: Arc<RTCPeerConnection>,
    gen: u64,
    remote_set: bool,
    pending_remote_ice: Vec<RTCIceCandidateInit>,
    /// Local candidates gathered before the offer was handed out.
    outbox: Arc<Mutex<(bool, Vec<IceCandidate>)>>,
}

pub(crate) struct Inner {
    cfg: HostConfig,
    events: Arc<dyn HostEvents>,
    permissions: Mutex<Permissions>,
    authorized: AtomicBool,
    closed: AtomicBool,
    generation: AtomicU64,
    pc: tokio::sync::Mutex<Option<PcState>>,
    track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
    control: Mutex<Option<Arc<RTCDataChannel>>>,
    stream: Arc<StreamShared>,
    files_state: FilesState,
    last_restart: Mutex<Option<Instant>>,
    /// When the connection was lost (None while connected).
    lost_since: Mutex<Option<Instant>>,
    ever_connected: AtomicBool,
    created: Instant,
}

/// A running host session. Cheap to clone.
#[derive(Clone)]
pub struct HostSession {
    inner: Arc<Inner>,
}

fn h264_capability() -> RTCRtpCodecCapability {
    let fb = |t: &str, p: &str| RTCPFeedback {
        typ: t.into(),
        parameter: p.into(),
    };
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: H264_FMTP.to_owned(),
        rtcp_feedback: vec![
            fb("goog-remb", ""),
            fb("ccm", "fir"),
            fb("nack", ""),
            fb("nack", "pli"),
            fb("transport-cc", ""),
        ],
    }
}

impl HostSession {
    /// Creates the session and its capture pipeline. Nothing is sent until the viewer's `ready`.
    pub fn start(cfg: HostConfig, events: Arc<dyn HostEvents>) -> Self {
        let stream = StreamShared::new(cfg.quality, cfg.fps);
        let authorized = cfg.mode == SessionMode::Attended;
        let inner = Arc::new(Inner {
            permissions: Mutex::new(cfg.permissions),
            cfg,
            events,
            authorized: AtomicBool::new(authorized),
            closed: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            pc: tokio::sync::Mutex::new(None),
            track: Mutex::new(None),
            control: Mutex::new(None),
            stream: stream.clone(),
            files_state: FilesState::default(),
            last_restart: Mutex::new(None),
            lost_since: Mutex::new(None),
            ever_connected: AtomicBool::new(false),
            created: Instant::now(),
        });

        // capture thread → sample writer
        let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(4);
        let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
        stream::spawn(stream, tx, ev_tx);
        let me = inner.clone();
        tokio::spawn(async move {
            while let Some(s) = rx.recv().await {
                let track = me.track.lock().clone();
                if let (Some(track), true) = (track, me.is_authorized()) {
                    let sample = Sample {
                        data: Bytes::from(s.data),
                        duration: s.duration,
                        ..Default::default()
                    };
                    let _ = track.write_sample(&sample).await;
                }
            }
        });
        let me = inner.clone();
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                match ev {
                    StreamEvent::MonitorChanged {
                        index,
                        width,
                        height,
                    } => {
                        if me.is_authorized() {
                            me.send_ctl(&ControlOut::MonitorChanged {
                                index,
                                width,
                                height,
                            })
                            .await;
                        }
                    }
                }
            }
        });
        // stats + watchdog
        let me = inner.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                if me.is_closed() {
                    break;
                }
                if me.is_authorized() && me.stream.active.load(Ordering::Relaxed) {
                    let s = *me.stream.stats.lock();
                    if s.width > 0 {
                        me.send_ctl(&ControlOut::Stats {
                            fps: (s.fps * 10.0).round() / 10.0,
                            encode_ms: (s.encode_ms * 10.0).round() / 10.0,
                            bitrate_kbps: s.bitrate_kbps,
                            width: s.width,
                            height: s.height,
                        })
                        .await;
                    }
                }
                let lost = *me.lost_since.lock();
                let give_up = match lost {
                    Some(t) => t.elapsed() > RECONNECT_GIVE_UP,
                    None => {
                        !me.ever_connected.load(Ordering::Relaxed)
                            && me.created.elapsed() > Duration::from_secs(120)
                    }
                };
                if give_up {
                    me.end_internal("connection_lost").await;
                    break;
                }
            }
        });
        inner
            .events
            .on_state(&inner.cfg.session_id, HostState::Connecting, None);
        inner.audit(
            "session_started",
            json!({"mode": inner.cfg.mode, "viewerName": inner.cfg.viewer_name}),
        );
        Self { inner }
    }

    pub fn session_id(&self) -> &str {
        &self.inner.cfg.session_id
    }

    pub fn viewer_id(&self) -> &str {
        &self.inner.cfg.viewer_id
    }

    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    pub fn is_authorized(&self) -> bool {
        self.inner.is_authorized()
    }

    /// Handles a signal from the viewer (`ready`, `answer`, `ice`, `restart_request`).
    /// The caller must have verified the answer signature already.
    pub async fn signal(&self, data: SignalData) -> Result<()> {
        let inner = &self.inner;
        if inner.is_closed() {
            return Err(anyhow!("session closed"));
        }
        match data {
            SignalData::Ready => inner.clone().create_pc().await,
            SignalData::Answer { sdp, .. } => inner.apply_answer(sdp).await,
            SignalData::Ice { candidate } => inner.add_remote_ice(candidate).await,
            SignalData::RestartRequest => {
                inner.clone().restart_ice(true).await;
                Ok(())
            }
            SignalData::Offer { .. } => Err(anyhow!("host does not accept offers")),
        }
    }

    pub async fn send_chat(&self, text: &str) -> Result<ChatMessage> {
        if !self.inner.permissions.lock().chat {
            return Err(anyhow!("chat desativado nesta sessão"));
        }
        let msg = ChatMessage {
            id: random_id(),
            text: text.chars().take(4000).collect(),
            ts: now_ms(),
        };
        self.inner
            .send_ctl(&ControlOut::Chat {
                id: msg.id.clone(),
                text: msg.text.clone(),
                ts: msg.ts,
            })
            .await;
        Ok(msg)
    }

    pub async fn set_permissions(&self, p: Permissions) {
        let inner = &self.inner;
        *inner.permissions.lock() = p;
        if !p.input {
            inner.cfg.input.send(InputCmd::ReleaseAll);
        }
        if !p.files {
            inner.cancel_all_transfers().await;
        }
        inner.audit("permissions_changed", json!(p));
        if inner.is_authorized() {
            inner.send_ctl(&ControlOut::Perm { permissions: p }).await;
        }
    }

    /// Ends the session at the request of the local user/UI (no `on_ended` callback).
    pub async fn stop(&self, reason: &str) {
        self.inner.shutdown(reason).await;
    }
}

impl Inner {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn is_authorized(&self) -> bool {
        self.authorized.load(Ordering::SeqCst)
    }

    fn audit(&self, event: &str, detail: serde_json::Value) {
        if let Some(st) = &self.cfg.store {
            st.audit(
                event,
                Some(&self.cfg.session_id),
                Some(&self.cfg.viewer_id),
                detail,
            );
        }
    }

    fn state(&self, s: HostState, detail: Option<String>) {
        self.events.on_state(&self.cfg.session_id, s, detail);
    }

    async fn send_ctl(&self, msg: &ControlOut) {
        let dc = self.control.lock().clone();
        if let Some(dc) = dc {
            if let Ok(txt) = serde_json::to_string(msg) {
                let _ = dc.send_text(txt).await;
            }
        }
    }

    async fn shutdown(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stream.active.store(false, Ordering::SeqCst);
        self.stream.running.store(false, Ordering::SeqCst);
        self.cfg.input.send(InputCmd::ReleaseAll);
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            self.send_ctl(&ControlOut::Bye {
                reason: reason.to_string(),
            }),
        )
        .await;
        // Give SCTP a moment to flush the `bye` before tearing the transport down.
        let dc = self.control.lock().clone();
        if let Some(dc) = dc {
            let deadline = Instant::now() + Duration::from_millis(500);
            while dc.buffered_amount().await > 0 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        self.cancel_all_transfers().await;
        let pc = self.pc.lock().await.take();
        if let Some(st) = pc {
            let _ = tokio::time::timeout(Duration::from_secs(3), st.pc.close()).await;
        }
        *self.control.lock() = None;
        *self.track.lock() = None;
        self.audit("session_closed", json!({"reason": reason}));
        self.state(HostState::Closed, Some(reason.to_string()));
    }

    async fn end_internal(&self, reason: &str) {
        if self.is_closed() {
            return;
        }
        self.shutdown(reason).await;
        self.events.on_ended(&self.cfg.session_id, reason);
    }

    async fn create_pc(self: Arc<Self>) -> Result<()> {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Tear down a previous peer (viewer reloaded): unattended viewers must re-authenticate.
        if let Some(old) = self.pc.lock().await.take() {
            let _ = old.pc.close().await;
            *self.control.lock() = None;
            if self.cfg.mode == SessionMode::Unattended {
                self.authorized.store(false, Ordering::SeqCst);
            }
            self.stream.active.store(false, Ordering::SeqCst);
        }
        self.state(HostState::Connecting, None);

        let mut m = MediaEngine::default();
        m.register_codec(
            RTCRtpCodecParameters {
                capability: h264_capability(),
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        )?;
        let registry = register_default_interceptors(Registry::new(), &mut m)?;
        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build();
        let config = RTCConfiguration {
            ice_servers: self
                .cfg
                .ice_servers
                .iter()
                .map(|s| RTCIceServer {
                    urls: s.urls.clone(),
                    username: s.username.clone().unwrap_or_default(),
                    credential: s.credential.clone().unwrap_or_default(),
                })
                .collect(),
            ..Default::default()
        };
        let pc = Arc::new(api.new_peer_connection(config).await?);

        let track = Arc::new(TrackLocalStaticSample::new(
            h264_capability(),
            "video".into(),
            "nexo-screen".into(),
        ));
        let sender = pc
            .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        {
            let me = self.clone();
            tokio::spawn(async move {
                while let Ok((pkts, _)) = sender.read_rtcp().await {
                    for p in pkts {
                        let any = p.as_any();
                        if any.downcast_ref::<PictureLossIndication>().is_some()
                            || any.downcast_ref::<FullIntraRequest>().is_some()
                        {
                            me.stream.keyframe.store(true, Ordering::Relaxed);
                        }
                    }
                }
            });
        }

        let reliable = || {
            Some(RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            })
        };
        let control = pc.create_data_channel("control", reliable()).await?;
        let files_dc = pc.create_data_channel("files", reliable()).await?;

        let outbox = Arc::new(Mutex::new((false, Vec::<IceCandidate>::new())));
        {
            let me = self.clone();
            let outbox = outbox.clone();
            pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                let me = me.clone();
                let outbox = outbox.clone();
                Box::pin(async move {
                    let Some(c) = c else { return };
                    if me.generation.load(Ordering::SeqCst) != gen {
                        return;
                    }
                    let Ok(init) = c.to_json() else { return };
                    let cand = IceCandidate {
                        candidate: init.candidate,
                        sdp_mid: init.sdp_mid,
                        sdp_mline_index: init.sdp_mline_index,
                    };
                    let mut ob = outbox.lock();
                    if ob.0 {
                        drop(ob);
                        me.events.on_ice(&me.cfg.session_id, cand);
                    } else {
                        ob.1.push(cand);
                    }
                })
            }));
        }
        {
            let me = self.clone();
            pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
                let me = me.clone();
                Box::pin(async move { me.on_ice_state(gen, s).await })
            }));
        }
        self.setup_control(gen, control.clone());
        self.setup_files(gen, files_dc).await;

        *self.track.lock() = Some(track);
        *self.pc.lock().await = Some(PcState {
            pc: pc.clone(),
            gen,
            remote_set: false,
            pending_remote_ice: vec![],
            outbox: outbox.clone(),
        });
        self.make_offer(&pc, &outbox, false).await
    }

    async fn make_offer(
        &self,
        pc: &RTCPeerConnection,
        outbox: &Arc<Mutex<(bool, Vec<IceCandidate>)>>,
        restart: bool,
    ) -> Result<()> {
        outbox.lock().0 = false;
        let opts = restart.then(|| RTCOfferOptions {
            ice_restart: true,
            ..Default::default()
        });
        let offer = pc.create_offer(opts).await?;
        let sdp = offer.sdp.clone();
        pc.set_local_description(offer).await?;
        // Prefer the description after set_local (it may contain gathered candidates).
        let sdp = pc.local_description().await.map(|d| d.sdp).unwrap_or(sdp);
        self.events.on_offer(&self.cfg.session_id, &sdp, restart);
        let early = {
            let mut ob = outbox.lock();
            ob.0 = true;
            std::mem::take(&mut ob.1)
        };
        for c in early {
            self.events.on_ice(&self.cfg.session_id, c);
        }
        Ok(())
    }

    async fn apply_answer(&self, sdp: String) -> Result<()> {
        let mut guard = self.pc.lock().await;
        let st = guard
            .as_mut()
            .ok_or_else(|| anyhow!("no peer connection (send ready first)"))?;
        if st.pc.signaling_state() != RTCSignalingState::HaveLocalOffer {
            return Err(anyhow!("unexpected answer"));
        }
        st.pc
            .set_remote_description(RTCSessionDescription::answer(sdp)?)
            .await?;
        st.remote_set = true;
        for c in std::mem::take(&mut st.pending_remote_ice) {
            if let Err(e) = st.pc.add_ice_candidate(c).await {
                tracing::debug!("queued ice rejected: {e}");
            }
        }
        Ok(())
    }

    async fn add_remote_ice(&self, c: IceCandidate) -> Result<()> {
        if c.candidate.is_empty() {
            return Ok(()); // end-of-candidates marker
        }
        let init = RTCIceCandidateInit {
            candidate: c.candidate,
            sdp_mid: c.sdp_mid,
            sdp_mline_index: c.sdp_mline_index,
            username_fragment: None,
        };
        let mut guard = self.pc.lock().await;
        let Some(st) = guard.as_mut() else {
            return Ok(());
        };
        if st.remote_set {
            st.pc.add_ice_candidate(init).await?;
        } else {
            st.pending_remote_ice.push(init);
        }
        Ok(())
    }

    async fn restart_ice(self: Arc<Self>, requested: bool) {
        if self.is_closed() {
            return;
        }
        {
            let mut last = self.last_restart.lock();
            if last.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let guard = self.pc.lock().await;
        let Some(st) = guard.as_ref() else { return };
        let (pc, outbox) = (st.pc.clone(), st.outbox.clone());
        drop(guard);
        if requested && pc.ice_connection_state() == RTCIceConnectionState::Connected {
            tracing::info!("ICE restart requested by viewer");
        }
        self.state(HostState::Reconnecting, Some("ice_restart".into()));
        if let Err(e) = self.make_offer(&pc, &outbox, true).await {
            tracing::warn!("ICE restart failed: {e}");
        }
    }

    async fn on_ice_state(self: Arc<Self>, gen: u64, s: RTCIceConnectionState) {
        if self.generation.load(Ordering::SeqCst) != gen || self.is_closed() {
            return;
        }
        tracing::info!("ICE state: {s}");
        match s {
            RTCIceConnectionState::Connected | RTCIceConnectionState::Completed => {
                *self.lost_since.lock() = None;
                self.ever_connected.store(true, Ordering::SeqCst);
                self.stream.keyframe.store(true, Ordering::Relaxed);
                if self.is_authorized() {
                    self.state(HostState::Streaming, None);
                } else {
                    self.state(HostState::AwaitingAuth, None);
                }
            }
            RTCIceConnectionState::Disconnected => {
                self.lost_since.lock().get_or_insert_with(Instant::now);
                self.state(HostState::Reconnecting, None);
                let me = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    let still = {
                        let g = me.pc.lock().await;
                        g.as_ref().map(|st| {
                            st.gen == gen
                                && st.pc.ice_connection_state()
                                    == RTCIceConnectionState::Disconnected
                        })
                    };
                    if still == Some(true) {
                        me.restart_ice(false).await;
                    }
                });
            }
            RTCIceConnectionState::Failed => {
                self.lost_since.lock().get_or_insert_with(Instant::now);
                self.restart_ice(false).await;
            }
            _ => {}
        }
    }

    fn setup_control(self: &Arc<Self>, gen: u64, dc: Arc<RTCDataChannel>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let me = self.clone();
        let dc2 = dc.clone();
        dc.on_open(Box::new(move || {
            let me = me.clone();
            let dc = dc2.clone();
            Box::pin(async move {
                if me.generation.load(Ordering::SeqCst) != gen {
                    return;
                }
                *me.control.lock() = Some(dc);
                if me.is_authorized() {
                    me.on_authorized().await;
                } else {
                    me.send_ctl(&ControlOut::AuthRequired).await;
                    me.state(HostState::AwaitingAuth, None);
                }
            })
        }));
        dc.on_message(Box::new(move |m: DataChannelMessage| {
            if m.is_string {
                if let Ok(s) = String::from_utf8(m.data.to_vec()) {
                    let _ = tx.send(s);
                }
            }
            Box::pin(async {})
        }));
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(txt) = rx.recv().await {
                if me.is_closed() || me.generation.load(Ordering::SeqCst) != gen {
                    break;
                }
                match serde_json::from_str::<ControlIn>(&txt) {
                    Ok(msg) => me.handle_control(msg).await,
                    Err(e) => tracing::debug!("bad control message: {e}"),
                }
            }
        });
    }

    async fn setup_files(self: &Arc<Self>, gen: u64, dc: Arc<RTCDataChannel>) {
        let notify = files::setup_backpressure(&dc).await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<FilesMsg>();
        dc.on_message(Box::new(move |m: DataChannelMessage| {
            let msg = if m.is_string {
                FilesMsg::Text(String::from_utf8_lossy(&m.data).into_owned())
            } else {
                FilesMsg::Binary(m.data)
            };
            let _ = tx.send(msg);
            Box::pin(async {})
        }));
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if me.is_closed() || me.generation.load(Ordering::SeqCst) != gen {
                    break;
                }
                me.handle_files(dc.clone(), notify.clone(), msg).await;
            }
        });
    }

    async fn on_authorized(self: &Arc<Self>) {
        let monitors = tokio::task::spawn_blocking(crate::capture::list_monitors)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let current = self
            .stream
            .monitor
            .load(Ordering::Relaxed)
            .min(monitors.len().saturating_sub(1));
        let permissions = *self.permissions.lock();
        self.send_ctl(&ControlOut::Hello {
            host_name: self.cfg.host_name.clone(),
            os: self.cfg.os.clone(),
            monitors,
            current,
            permissions,
        })
        .await;
        self.stream.keyframe.store(true, Ordering::Relaxed);
        self.stream.active.store(true, Ordering::SeqCst);
        self.state(HostState::Streaming, None);
    }

    async fn handle_control(self: &Arc<Self>, msg: ControlIn) {
        if let ControlIn::Auth { password } = msg {
            return self.handle_auth(password).await;
        }
        if let ControlIn::Ping { id, ts } = msg {
            return self.send_ctl(&ControlOut::Pong { id, ts }).await;
        }
        if !self.is_authorized() {
            return;
        }
        let perms = *self.permissions.lock();
        let input = &self.cfg.input;
        match msg {
            ControlIn::MouseMove { x, y } if perms.input => {
                let mon = self.stream.current_monitor.lock().clone();
                if let Some(monitor) = mon {
                    input.send(InputCmd::MouseMove { x, y, monitor });
                }
            }
            ControlIn::MouseDown { b } if perms.input => {
                input.send(InputCmd::Button { b, down: true })
            }
            ControlIn::MouseUp { b } if perms.input => {
                input.send(InputCmd::Button { b, down: false })
            }
            ControlIn::Wheel { dx, dy } if perms.input => input.send(InputCmd::Wheel { dx, dy }),
            ControlIn::KeyDown { code, key } if perms.input => input.send(InputCmd::Key {
                code,
                key,
                down: true,
            }),
            ControlIn::KeyUp { code, key } if perms.input => input.send(InputCmd::Key {
                code,
                key,
                down: false,
            }),
            ControlIn::Combo { codes } if perms.input => input.send(InputCmd::Combo(codes)),
            ControlIn::Text { text } if perms.input => input.send(InputCmd::Text(text)),
            ControlIn::Monitor { index } => {
                self.stream.monitor.store(index, Ordering::Relaxed);
            }
            ControlIn::Quality { preset, fps } => {
                *self.stream.preset.lock() = preset;
                self.stream.fps.store(fps.clamp(5, 60), Ordering::Relaxed);
            }
            ControlIn::Viewport { w, h } => {
                *self.stream.viewport.lock() = (w.min(16384), h.min(16384));
            }
            ControlIn::Keyframe => self.stream.keyframe.store(true, Ordering::Relaxed),
            ControlIn::Chat { id, text, ts } if perms.chat => {
                let id = if id.is_empty() { random_id() } else { id };
                let text: String = text.chars().take(4000).collect();
                self.events.on_chat(
                    &self.cfg.session_id,
                    ChatMessage {
                        id,
                        text,
                        ts: if ts > 0 { ts } else { now_ms() },
                    },
                );
            }
            _ => {}
        }
    }

    async fn handle_auth(self: &Arc<Self>, password: String) {
        if self.is_authorized() {
            return self
                .send_ctl(&ControlOut::AuthResult {
                    ok: true,
                    reason: None,
                    attempts_left: None,
                })
                .await;
        }
        let viewer = self.cfg.viewer_id.clone();
        if !self.cfg.allowed_device_ids.is_empty() && !self.cfg.allowed_device_ids.contains(&viewer)
        {
            self.send_ctl(&ControlOut::AuthResult {
                ok: false,
                reason: Some("not_allowed".into()),
                attempts_left: None,
            })
            .await;
            self.audit("auth_refused", json!({"reason": "not_allowed"}));
            self.events.on_auth(&self.cfg.session_id, false, &viewer);
            return self.end_internal("not_allowed").await;
        }
        let guard = self.cfg.auth_guard.clone();
        let hash = self.cfg.unattended_hash.clone();
        let v2 = viewer.clone();
        let outcome =
            tokio::task::spawn_blocking(move || guard.check(&v2, hash.as_deref(), &password))
                .await
                .unwrap_or(AuthOutcome::NotConfigured);
        match outcome {
            AuthOutcome::Ok => {
                self.authorized.store(true, Ordering::SeqCst);
                self.send_ctl(&ControlOut::AuthResult {
                    ok: true,
                    reason: None,
                    attempts_left: None,
                })
                .await;
                self.audit("auth_ok", json!({}));
                self.events.on_auth(&self.cfg.session_id, true, &viewer);
                self.on_authorized().await;
            }
            AuthOutcome::Denied { attempts_left } => {
                self.send_ctl(&ControlOut::AuthResult {
                    ok: false,
                    reason: Some("bad_password".into()),
                    attempts_left: Some(attempts_left),
                })
                .await;
                self.audit("auth_failed", json!({"attemptsLeft": attempts_left}));
                self.events.on_auth(&self.cfg.session_id, false, &viewer);
            }
            AuthOutcome::Blocked { remaining } => {
                self.send_ctl(&ControlOut::AuthResult {
                    ok: false,
                    reason: Some("blocked".into()),
                    attempts_left: Some(0),
                })
                .await;
                self.audit("auth_blocked", json!({"remainingSec": remaining.as_secs()}));
                self.events.on_auth(&self.cfg.session_id, false, &viewer);
                self.end_internal("auth_blocked").await;
            }
            AuthOutcome::NotConfigured => {
                self.send_ctl(&ControlOut::AuthResult {
                    ok: false,
                    reason: Some("not_configured".into()),
                    attempts_left: None,
                })
                .await;
                self.events.on_auth(&self.cfg.session_id, false, &viewer);
                self.end_internal("unattended_not_configured").await;
            }
        }
    }
}
