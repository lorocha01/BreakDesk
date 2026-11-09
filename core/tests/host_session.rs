//! End-to-end test of the host engine against an in-process webrtc-rs "viewer":
//! offer/answer + trickle ICE, unattended auth (wrong + right password), control messages,
//! file upload/download/listing, chat, and — when a display is available — real H.264 RTP.

use bytes::Bytes;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

use nexo_core::auth::{hash_password, AuthGuard};
use nexo_core::files::{decode_header, encode_header};
use nexo_core::host::{ChatMessage, HostConfig, HostEvents, HostSession, HostState, TransferEvent};
use nexo_core::input::InputHandle;
use nexo_core::protocol::{IceCandidate, Permissions, QualityPreset, SessionMode, SignalData};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

#[derive(Debug)]
#[allow(dead_code)]
enum Ev {
    Offer(String),
    Ice(IceCandidate),
    State(HostState),
    Chat(String),
    Transfer(TransferEvent),
    Auth(bool),
    Ended(String),
}

struct Sink(mpsc::UnboundedSender<Ev>);
impl HostEvents for Sink {
    fn on_offer(&self, _: &str, sdp: &str, _: bool) {
        let _ = self.0.send(Ev::Offer(sdp.into()));
    }
    fn on_ice(&self, _: &str, c: IceCandidate) {
        let _ = self.0.send(Ev::Ice(c));
    }
    fn on_state(&self, _: &str, s: HostState, _: Option<String>) {
        let _ = self.0.send(Ev::State(s));
    }
    fn on_chat(&self, _: &str, m: ChatMessage) {
        let _ = self.0.send(Ev::Chat(m.text));
    }
    fn on_transfer(&self, _: &str, ev: TransferEvent) {
        let _ = self.0.send(Ev::Transfer(ev));
    }
    fn on_auth(&self, _: &str, ok: bool, _: &str) {
        let _ = self.0.send(Ev::Auth(ok));
    }
    fn on_ended(&self, _: &str, r: &str) {
        let _ = self.0.send(Ev::Ended(r.into()));
    }
}

enum DcMsg {
    Text(String, Value),
    Bin(String, Bytes),
}

async fn next_text(rx: &mut mpsc::UnboundedReceiver<DcMsg>, label: &str, t_or_op: &str) -> Value {
    loop {
        match timeout(Duration::from_secs(15), rx.recv())
            .await
            .expect("timeout waiting for dc message")
            .unwrap()
        {
            DcMsg::Text(l, v) if l == label && (v["t"] == t_or_op || v["op"] == t_or_op) => {
                return v
            }
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unattended_session_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let recv_dir = tmp.path().join("recv");
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let session = HostSession::start(
        HostConfig {
            session_id: "s-1".into(),
            mode: SessionMode::Unattended,
            ice_servers: vec![],
            permissions: Permissions {
                input: false,
                files: true,
                chat: true,
            },
            viewer_id: "111222333".into(),
            viewer_name: "Viewer".into(),
            host_name: "Host".into(),
            os: "Linux".into(),
            unattended_hash: Some(hash_password("senha-forte-123").unwrap()),
            allowed_device_ids: vec![],
            auth_guard: Arc::new(AuthGuard::new()),
            receive_dir: recv_dir.clone(),
            quality: QualityPreset::Speed,
            fps: 15,
            store: None,
            input: InputHandle::spawn(),
        },
        Arc::new(Sink(ev_tx)),
    );

    // --- viewer peer (answerer)
    let mut m = MediaEngine::default();
    m.register_default_codecs().unwrap();
    let reg = register_default_interceptors(Registry::new(), &mut m).unwrap();
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(reg)
        .build();
    let viewer = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap(),
    );

    let (dc_tx, mut dc_rx) = mpsc::unbounded_channel::<DcMsg>();
    let (chan_tx, mut chan_rx) = mpsc::unbounded_channel::<Arc<RTCDataChannel>>();
    viewer.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let dc_tx = dc_tx.clone();
        let chan_tx = chan_tx.clone();
        Box::pin(async move {
            let label = dc.label().to_string();
            let dc2 = dc.clone();
            dc.on_open(Box::new(move || {
                let _ = chan_tx.send(dc2.clone());
                Box::pin(async {})
            }));
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let m = if msg.is_string {
                    let s = String::from_utf8_lossy(&msg.data).into_owned();
                    DcMsg::Text(
                        label.clone(),
                        serde_json::from_str(&s).unwrap_or(Value::Null),
                    )
                } else {
                    DcMsg::Bin(label.clone(), msg.data)
                };
                let _ = dc_tx.send(m);
                Box::pin(async {})
            }));
        })
    }));
    let (rtp_tx, mut rtp_rx) = mpsc::unbounded_channel::<usize>();
    viewer.on_track(Box::new(move |track, _, _| {
        let rtp_tx = rtp_tx.clone();
        Box::pin(async move {
            assert_eq!(
                track.codec().capability.mime_type.to_lowercase(),
                "video/h264"
            );
            while let Ok((pkt, _)) = track.read_rtp().await {
                let _ = rtp_tx.send(pkt.payload.len());
            }
        })
    }));
    let (vice_tx, mut vice_rx) = mpsc::unbounded_channel::<RTCIceCandidateInit>();
    viewer.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
        let vice_tx = vice_tx.clone();
        Box::pin(async move {
            if let Some(c) = c {
                let _ = vice_tx.send(c.to_json().unwrap());
            }
        })
    }));

    session.signal(SignalData::Ready).await.unwrap();

    // pump signaling until both data channels are open
    let mut open: Vec<Arc<RTCDataChannel>> = vec![];
    let mut answered = false;
    while open.len() < 2 {
        tokio::select! {
            ev = ev_rx.recv() => match ev.unwrap() {
                Ev::Offer(sdp) => {
                    assert!(sdp.contains("H264") && sdp.contains("packetization-mode=1") && sdp.contains("42e01f"));
                    viewer.set_remote_description(RTCSessionDescription::offer(sdp).unwrap()).await.unwrap();
                    let ans = viewer.create_answer(None).await.unwrap();
                    viewer.set_local_description(ans.clone()).await.unwrap();
                    session.signal(SignalData::Answer { sdp: ans.sdp, sig: String::new() }).await.unwrap();
                    answered = true;
                }
                Ev::Ice(c) => {
                    assert!(answered, "candidates must follow the offer");
                    viewer.add_ice_candidate(RTCIceCandidateInit {
                        candidate: c.candidate, sdp_mid: c.sdp_mid, sdp_mline_index: c.sdp_mline_index, username_fragment: None,
                    }).await.unwrap();
                }
                _ => {}
            },
            c = vice_rx.recv() => {
                let c = c.unwrap();
                session.signal(SignalData::Ice { candidate: IceCandidate {
                    candidate: c.candidate, sdp_mid: c.sdp_mid, sdp_mline_index: c.sdp_mline_index,
                }}).await.unwrap();
            }
            dc = chan_rx.recv() => open.push(dc.unwrap()),
            _ = tokio::time::sleep(Duration::from_secs(20)) => panic!("peer connection did not open"),
        }
    }
    // keep forwarding late ICE in the background
    let s2 = session.clone();
    tokio::spawn(async move {
        while let Some(c) = vice_rx.recv().await {
            let _ = s2
                .signal(SignalData::Ice {
                    candidate: IceCandidate {
                        candidate: c.candidate,
                        sdp_mid: c.sdp_mid,
                        sdp_mline_index: c.sdp_mline_index,
                    },
                })
                .await;
        }
    });
    let control = open
        .iter()
        .find(|d| d.label() == "control")
        .unwrap()
        .clone();
    let files = open.iter().find(|d| d.label() == "files").unwrap().clone();

    next_text(&mut dc_rx, "control", "auth_required").await;

    // Nothing is served before authentication.
    files
        .send_text(json!({"op":"ls","reqId":1,"path":""}).to_string())
        .await
        .unwrap();
    let denied = next_text(&mut dc_rx, "files", "error").await;
    assert_eq!(denied["reqId"], 1);

    control
        .send_text(json!({"t":"auth","password":"errada"}).to_string())
        .await
        .unwrap();
    let r = next_text(&mut dc_rx, "control", "auth_result").await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["attemptsLeft"], 4);

    control
        .send_text(json!({"t":"auth","password":"senha-forte-123"}).to_string())
        .await
        .unwrap();
    let r = next_text(&mut dc_rx, "control", "auth_result").await;
    assert_eq!(r["ok"], true);
    let hello = next_text(&mut dc_rx, "control", "hello").await;
    assert_eq!(hello["hostName"], "Host");
    assert_eq!(hello["permissions"]["input"], false);

    control
        .send_text(json!({"t":"ping","id":7,"ts":123}).to_string())
        .await
        .unwrap();
    let p = next_text(&mut dc_rx, "control", "pong").await;
    assert_eq!((p["id"].as_i64(), p["ts"].as_i64()), (Some(7), Some(123)));

    control
        .send_text(json!({"t":"chat","id":"c1","text":"olá host","ts":1}).to_string())
        .await
        .unwrap();
    let sent = session.send_chat("olá viewer").await.unwrap();
    let c = next_text(&mut dc_rx, "control", "chat").await;
    assert_eq!(c["text"], "olá viewer");
    assert_eq!(c["id"], sent.id);

    // --- listing
    let list_dir = tmp.path().join("list");
    std::fs::create_dir_all(list_dir.join("sub")).unwrap();
    std::fs::write(list_dir.join("x.txt"), b"x").unwrap();
    files
        .send_text(json!({"op":"ls","reqId":2,"path":list_dir.to_string_lossy()}).to_string())
        .await
        .unwrap();
    let l = next_text(&mut dc_rx, "files", "ls_result").await;
    assert_eq!(l["entries"][0]["name"], "sub");
    assert_eq!(l["entries"][1]["isDir"], false);

    // --- upload (viewer → host), 40 KiB in 16 KiB chunks into a sub folder
    let payload: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
    files
        .send_text(json!({"op":"put","id":10,"name":"dados.bin","relPath":"pasta/dados.bin","size":payload.len()}).to_string())
        .await
        .unwrap();
    next_text(&mut dc_rx, "files", "put_ok").await;
    for chunk in payload.chunks(16 * 1024) {
        files
            .send(&Bytes::from(encode_header(10, 0, chunk)))
            .await
            .unwrap();
    }
    files
        .send_text(json!({"op":"put_end","id":10}).to_string())
        .await
        .unwrap();
    let done = next_text(&mut dc_rx, "files", "done").await;
    let saved = std::path::PathBuf::from(done["path"].as_str().unwrap());
    assert!(saved.starts_with(&recv_dir));
    assert_eq!(std::fs::read(&saved).unwrap(), payload);

    // traversal attempt is neutralised
    files
        .send_text(
            json!({"op":"put","id":11,"name":"x","relPath":"../../evil","size":1}).to_string(),
        )
        .await
        .unwrap();
    let e = next_text(&mut dc_rx, "files", "put_err").await;
    assert_eq!(e["id"], 11);

    // --- download (host → viewer) of a folder
    let src = tmp.path().join("src");
    std::fs::create_dir_all(src.join("inner")).unwrap();
    let big: Vec<u8> = (0..70_000u32).map(|i| (i * 7 % 256) as u8).collect();
    std::fs::write(src.join("inner/big.bin"), &big).unwrap();
    std::fs::write(src.join("a.txt"), b"abc").unwrap();
    files
        .send_text(json!({"op":"get","id":20,"path":src.to_string_lossy()}).to_string())
        .await
        .unwrap();
    let mut got: std::collections::BTreeMap<u32, Vec<u8>> = Default::default();
    let mut meta = Value::Null;
    loop {
        match timeout(Duration::from_secs(15), dc_rx.recv())
            .await
            .unwrap()
            .unwrap()
        {
            DcMsg::Bin(l, b) if l == "files" => {
                let (id, idx, data) = decode_header(&b).unwrap();
                assert_eq!(id, 20);
                got.entry(idx).or_default().extend_from_slice(data);
            }
            DcMsg::Text(l, v) if l == "files" && v["op"] == "get_meta" => meta = v,
            DcMsg::Text(l, v) if l == "files" && v["op"] == "done" && v["id"] == 20 => break,
            _ => {}
        }
    }
    assert_eq!(meta["totalSize"], 70_003);
    assert_eq!(meta["files"][0]["relPath"], "src/a.txt");
    assert_eq!(meta["files"][1]["relPath"], "src/inner/big.bin");
    assert_eq!(got[&0], b"abc");
    assert_eq!(got[&1], big);

    // host-side events were reported
    let mut saw_chat = false;
    let mut saw_auth_ok = false;
    let mut saw_upload_done = false;
    while let Ok(ev) = ev_rx.try_recv() {
        match ev {
            Ev::Chat(t) => saw_chat |= t == "olá host",
            Ev::Auth(ok) => saw_auth_ok |= ok,
            Ev::Transfer(t) => {
                saw_upload_done |=
                    t.id == 10 && matches!(t.state, nexo_core::host::TransferState::Done)
            }
            _ => {}
        }
    }
    assert!(saw_chat && saw_auth_ok && saw_upload_done);

    // --- video: only verifiable when a display is present (e.g. under Xvfb)
    if std::env::var("DISPLAY").is_ok() || std::env::var("NEXO_TEST_VIDEO").is_ok() {
        let mut bytes = 0usize;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while bytes < 1000 && tokio::time::Instant::now() < deadline {
            if let Ok(Some(n)) = timeout(Duration::from_secs(1), rtp_rx.recv()).await {
                bytes += n;
            }
        }
        assert!(
            bytes >= 1000,
            "expected H.264 RTP payload, got {bytes} bytes"
        );
        let stats = next_text(&mut dc_rx, "control", "stats").await;
        assert!(stats["width"].as_u64().unwrap() > 0, "stats: {stats}");
        eprintln!("video OK: {bytes} RTP payload bytes, stats {stats}");
    } else {
        eprintln!("DISPLAY not set: skipping video assertions");
    }

    session.stop("test_done").await;
    let bye = next_text(&mut dc_rx, "control", "bye").await;
    assert_eq!(bye["reason"], "test_done");
    assert!(session.is_closed());
    let _ = viewer.close().await;
}
