//! Signaling-level E2E probe: acts as a *viewer* against a real Nexo server and a running
//! `nexo-hostd`, using the same protocol as the desktop UI (register → token → WS → connect
//! unattended → signed offer/answer → trickle ICE → password over the data channel → H.264 RTP).
//!
//!   cargo run -p nexo-core --features hostd --example e2e_viewer -- <server> <hostId> <password>

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use nexo_core::identity::{self, Identity};
use nexo_core::protocol::IceServer;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

#[tokio::main]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        bail!("usage: e2e_viewer <server> <hostId> <password> [wrong-password-first]");
    }
    let (base, host_id, password) = (
        a[1].trim_end_matches('/').to_string(),
        a[2].clone(),
        a[3].clone(),
    );
    let http = reqwest::Client::new();
    let me = Identity::from_seed(rand::random());
    let post = |path: &str, body: Value| {
        let req = http.post(format!("{base}/api/v1{path}")).json(&body);
        async move {
            let r = req.send().await?;
            let s = r.status();
            let v: Value = r.json().await?;
            if !s.is_success() {
                bail!("{s}: {v}");
            }
            Ok::<Value, anyhow::Error>(v)
        }
    };
    let reg = post("/devices/register", json!({"publicKey": me.public_key_b64(), "name": "Probe Viewer", "os": "Linux", "appVersion": "probe"})).await?;
    let my_id = reg["deviceId"].as_str().context("id")?.to_string();
    let ch = post("/auth/device/challenge", json!({"deviceId": my_id})).await?;
    let sig = me.sign(&identity::auth_message(
        ch["nonce"].as_str().unwrap(),
        &my_id,
    ));
    let tok = post(
        "/auth/device/token",
        json!({"challengeId": ch["challengeId"], "deviceId": my_id, "signature": sig}),
    )
    .await?;
    let token = tok["token"].as_str().unwrap();
    println!("viewer id {my_id}");

    let ws_url = format!("{}/ws?token={token}", base.replacen("http", "ws", 1));
    let (ws, _) = tokio_tungstenite::connect_async(ws_url).await?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(v) = out_rx.recv().await {
            if sink
                .send(Message::Text(v.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    out_tx.send(json!({"type":"connect","reqId":"r1","targetId":host_id,"mode":"unattended","viewerName":"Probe Viewer"}))?;

    let mut m = MediaEngine::default();
    m.register_default_codecs()?;
    let reg = register_default_interceptors(Registry::new(), &mut m)?;
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(reg)
        .build();

    let mut pc = None;
    let mut session_id = String::new();
    let mut peer_key = String::new();
    let (dc_tx, mut dc_rx) = mpsc::unbounded_channel::<(Arc<RTCDataChannel>, Option<Value>)>();
    let (rtp_tx, mut rtp_rx) = mpsc::unbounded_channel::<usize>();
    let mut rtp_bytes = 0usize;
    let mut authed = false;
    let mut tried_wrong = a.len() < 5;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => bail!("timeout (rtp bytes {rtp_bytes}, authed {authed})"),
            Some(n) = rtp_rx.recv() => {
                rtp_bytes += n;
                if authed && rtp_bytes > 5000 {
                    println!("E2E OK: session {session_id}, {rtp_bytes} bytes of H.264 RTP received");
                    out_tx.send(json!({"type":"end","sessionId":session_id,"reason":"probe_done"}))?;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    return Ok(());
                }
            }
            Some((dc, msg)) = dc_rx.recv() => {
                match msg {
                    None => {}
                    Some(v) => {
                        println!("control <- {v}");
                        let ctl = &dc;
                        match v["t"].as_str() {
                            Some("auth_required") => {
                                let pw = if tried_wrong { password.clone() } else { "senha-errada".into() };
                                ctl.send_text(json!({"t":"auth","password":pw}).to_string()).await?;
                            }
                            Some("auth_result") if v["ok"] == false => {
                                tried_wrong = true;
                                ctl.send_text(json!({"t":"auth","password":password}).to_string()).await?;
                            }
                            Some("auth_result") => authed = true,
                            Some("hello") => {
                                ctl.send_text(json!({"t":"viewport","w":1280,"h":720}).to_string()).await?;
                                ctl.send_text(json!({"t":"mm","x":0.5,"y":0.5}).to_string()).await?;
                            }
                            _ => {}
                        }
                    }
                }
            }
            msg = stream.next() => {
                let t = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(c))) => bail!("ws closed: {c:?}"),
                    Some(Err(e)) => bail!("ws error: {e}"),
                    None => bail!("ws ended"),
                    Some(Ok(_)) => continue,
                };
                let v: Value = serde_json::from_str(&t)?;
                match v["type"].as_str().unwrap_or("") {
                    "session_started" => {
                        session_id = v["sessionId"].as_str().unwrap().into();
                        peer_key = v["peer"]["publicKey"].as_str().unwrap_or("").into();
                        let ice: Vec<IceServer> = serde_json::from_value(v["iceServers"].clone()).unwrap_or_default();
                        let cfg = RTCConfiguration {
                            ice_servers: ice.into_iter().map(|s| RTCIceServer {
                                urls: s.urls, username: s.username.unwrap_or_default(), credential: s.credential.unwrap_or_default(),
                            }).collect(),
                            ..Default::default()
                        };
                        let p = Arc::new(api.new_peer_connection(cfg).await?);
                        let dc_tx2 = dc_tx.clone();
                        p.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
                            let tx = dc_tx2.clone();
                            Box::pin(async move {
                                let (d1, d2, t1) = (dc.clone(), dc.clone(), tx.clone());
                                dc.on_open(Box::new(move || { let _ = t1.send((d1.clone(), None)); Box::pin(async {}) }));
                                dc.on_message(Box::new(move |m: DataChannelMessage| {
                                    if m.is_string { let _ = tx.send((d2.clone(), serde_json::from_slice(&m.data).ok())); }
                                    Box::pin(async {})
                                }));
                            })
                        }));
                        let rtx = rtp_tx.clone();
                        p.on_track(Box::new(move |track, _, _| {
                            let rtx = rtx.clone();
                            Box::pin(async move {
                                println!("track {}", track.codec().capability.mime_type);
                                while let Ok((pkt, _)) = track.read_rtp().await { let _ = rtx.send(pkt.payload.len()); }
                            })
                        }));
                        let (o, sid) = (out_tx.clone(), session_id.clone());
                        p.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                            let (o, sid) = (o.clone(), sid.clone());
                            Box::pin(async move {
                                if let Some(c) = c.and_then(|c| c.to_json().ok()) {
                                    let _ = o.send(json!({"type":"signal","sessionId":sid,"data":{"kind":"ice","candidate":c}}));
                                }
                            })
                        }));
                        pc = Some(p);
                        out_tx.send(json!({"type":"signal","sessionId":session_id,"data":{"kind":"ready"}}))?;
                    }
                    "signal" => {
                        let p = pc.as_ref().context("no pc")?;
                        let d = &v["data"];
                        match d["kind"].as_str().unwrap_or("") {
                            "offer" => {
                                let sdp = d["sdp"].as_str().unwrap().to_string();
                                let ok = identity::verify(&peer_key, &identity::sdp_message(&session_id, "offer", &sdp), d["sig"].as_str().unwrap_or(""));
                                if !ok { bail!("offer signature invalid") }
                                println!("offer signature verified (restart={})", d["restart"]);
                                p.set_remote_description(RTCSessionDescription::offer(sdp)?).await?;
                                let ans = p.create_answer(None).await?;
                                p.set_local_description(ans.clone()).await?;
                                let sig = me.sign(&identity::sdp_message(&session_id, "answer", &ans.sdp));
                                out_tx.send(json!({"type":"signal","sessionId":session_id,"data":{"kind":"answer","sdp":ans.sdp,"sig":sig}}))?;
                            }
                            "ice" => {
                                let c: RTCIceCandidateInit = serde_json::from_value(d["candidate"].clone())?;
                                p.add_ice_candidate(c).await?;
                            }
                            _ => {}
                        }
                    }
                    "error" | "session_ended" => bail!("server: {v}"),
                    other => println!("ws <- {other}"),
                }
            }
        }
    }
}
