//! Host side of the `files` data channel (PROTOCOL.md §4.2).

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use webrtc::data_channel::RTCDataChannel;

use super::{Direction, Inner, TransferEvent, TransferState};
use crate::files::{self, CHUNK, HIGH_WATER, LOW_WATER};

struct PutState {
    file: tokio::fs::File,
    path: PathBuf,
    name: String,
    size: u64,
    received: u64,
    last_emit: Instant,
}

#[derive(Default)]
pub(crate) struct FilesState {
    puts: tokio::sync::Mutex<HashMap<u32, PutState>>,
    gets: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

pub(crate) enum FilesMsg {
    Text(String),
    Binary(Bytes),
}

pub(crate) async fn setup_backpressure(dc: &Arc<RTCDataChannel>) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    dc.set_buffered_amount_low_threshold(LOW_WATER).await;
    let n = notify.clone();
    dc.on_buffered_amount_low(Box::new(move || {
        let n = n.clone();
        Box::pin(async move { n.notify_waiters() })
    }))
    .await;
    notify
}

async fn wait_drain(dc: &RTCDataChannel, notify: &Notify) {
    while dc.buffered_amount().await > HIGH_WATER {
        let _ = tokio::time::timeout(Duration::from_millis(50), notify.notified()).await;
    }
}

async fn send_json(dc: &RTCDataChannel, v: Value) {
    let _ = dc.send_text(v.to_string()).await;
}

impl Inner {
    fn files_allowed(&self) -> bool {
        self.is_authorized() && self.permissions.lock().files
    }

    pub(crate) async fn handle_files(
        self: &Arc<Self>,
        dc: Arc<RTCDataChannel>,
        notify: Arc<Notify>,
        msg: FilesMsg,
    ) {
        if !self.files_allowed() {
            if let FilesMsg::Text(t) = &msg {
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                let mut reply =
                    json!({"op": "error", "message": "Transferência de arquivos não permitida"});
                if let Some(id) = v.get("id") {
                    reply["id"] = id.clone();
                }
                if let Some(r) = v.get("reqId") {
                    reply["reqId"] = r.clone();
                }
                if v.get("op").and_then(Value::as_str) == Some("put") {
                    reply["op"] = json!("put_err");
                }
                send_json(&dc, reply).await;
            }
            return;
        }
        match msg {
            FilesMsg::Binary(b) => self.put_chunk(&dc, b).await,
            FilesMsg::Text(t) => {
                let Ok(v) = serde_json::from_str::<Value>(&t) else {
                    return;
                };
                let op = v.get("op").and_then(Value::as_str).unwrap_or("");
                let id = v.get("id").and_then(Value::as_u64).map(|x| x as u32);
                match (op, id) {
                    ("ls", _) => {
                        let req = v.get("reqId").cloned().unwrap_or(Value::Null);
                        let path = v
                            .get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let res = tokio::task::spawn_blocking(move || files::list_dir(&path)).await;
                        let reply = match res {
                            Ok(Ok(l)) => {
                                json!({"op":"ls_result","reqId":req,"path":l.path,"parent":l.parent,"entries":l.entries})
                            }
                            Ok(Err(e)) => json!({"op":"error","reqId":req,"message":e.to_string()}),
                            Err(e) => json!({"op":"error","reqId":req,"message":e.to_string()}),
                        };
                        send_json(&dc, reply).await;
                    }
                    ("put", Some(id)) => self.put_begin(&dc, id, &v).await,
                    ("put_end", Some(id)) => self.put_end(&dc, id).await,
                    ("get", Some(id)) => {
                        let path = v
                            .get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let me = self.clone();
                        tokio::spawn(async move { me.get_task(dc, notify, id, path).await });
                    }
                    ("cancel", Some(id)) => self.cancel_transfer(id, true).await,
                    _ => {}
                }
            }
        }
    }

    async fn put_begin(&self, dc: &RTCDataChannel, id: u32, v: &Value) {
        let name = v
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("arquivo")
            .to_string();
        let rel = v
            .get("relPath")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&name)
            .to_string();
        let size = v.get("size").and_then(Value::as_u64).unwrap_or(0);
        let dest = v
            .get("dest")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let res: anyhow::Result<(tokio::fs::File, PathBuf)> = async {
            let base = if dest.is_empty() {
                self.cfg.receive_dir.clone()
            } else {
                let p = PathBuf::from(&dest);
                if !p.is_absolute() || !p.is_dir() {
                    anyhow::bail!("pasta de destino inválida");
                }
                p
            };
            tokio::fs::create_dir_all(&base).await?;
            let target = files::safe_join(&base, &rel)?;
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let target = files::unique_path(&target);
            let f = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .await?;
            Ok((f, target))
        }
        .await;
        match res {
            Ok((file, path)) => {
                self.puts().lock().await.insert(
                    id,
                    PutState {
                        file,
                        path,
                        name: name.clone(),
                        size,
                        received: 0,
                        last_emit: Instant::now(),
                    },
                );
                send_json(dc, json!({"op":"put_ok","id":id})).await;
                self.emit_transfer(
                    id,
                    Direction::Upload,
                    &name,
                    0,
                    size,
                    TransferState::Active,
                    None,
                );
            }
            Err(e) => {
                send_json(dc, json!({"op":"put_err","id":id,"message":e.to_string()})).await;
                self.emit_transfer(
                    id,
                    Direction::Upload,
                    &name,
                    0,
                    size,
                    TransferState::Error,
                    Some(e.to_string()),
                );
            }
        }
    }

    async fn put_chunk(&self, dc: &RTCDataChannel, frame: Bytes) {
        let Some((id, _idx, payload)) = files::decode_header(&frame) else {
            return;
        };
        let mut puts = self.puts().lock().await;
        let Some(st) = puts.get_mut(&id) else { return };
        let overflow = st.received + payload.len() as u64 > st.size;
        let write = if overflow {
            Err(std::io::Error::other("tamanho excedido"))
        } else {
            st.file.write_all(payload).await
        };
        if let Err(e) = write {
            let st = puts.remove(&id).unwrap();
            drop(puts);
            let _ = tokio::fs::remove_file(&st.path).await;
            send_json(dc, json!({"op":"cancel","id":id})).await;
            self.emit_transfer(
                id,
                Direction::Upload,
                &st.name,
                st.received,
                st.size,
                TransferState::Error,
                Some(e.to_string()),
            );
            return;
        }
        st.received += payload.len() as u64;
        if st.last_emit.elapsed() > Duration::from_millis(250) {
            st.last_emit = Instant::now();
            let (n, r, s) = (st.name.clone(), st.received, st.size);
            drop(puts);
            self.emit_transfer(id, Direction::Upload, &n, r, s, TransferState::Active, None);
        }
    }

    async fn put_end(&self, dc: &RTCDataChannel, id: u32) {
        let Some(mut st) = self.puts().lock().await.remove(&id) else {
            return;
        };
        let _ = st.file.flush().await;
        drop(st.file);
        if st.received != st.size {
            let _ = tokio::fs::remove_file(&st.path).await;
            let msg = format!("recebidos {} de {} bytes", st.received, st.size);
            send_json(dc, json!({"op":"error","id":id,"message":msg})).await;
            self.emit_transfer(
                id,
                Direction::Upload,
                &st.name,
                st.received,
                st.size,
                TransferState::Error,
                Some(msg),
            );
            return;
        }
        let path = st.path.to_string_lossy().into_owned();
        send_json(dc, json!({"op":"done","id":id,"path":path})).await;
        self.emit_transfer(
            id,
            Direction::Upload,
            &st.name,
            st.received,
            st.size,
            TransferState::Done,
            None,
        );
        self.audit(
            "file_received",
            json!({"name": st.name, "size": st.size, "path": path}),
        );
    }

    async fn get_task(
        self: Arc<Self>,
        dc: Arc<RTCDataChannel>,
        notify: Arc<Notify>,
        id: u32,
        path: String,
    ) {
        let cancel = Arc::new(AtomicBool::new(false));
        self.files_state.gets.lock().insert(id, cancel.clone());
        let p = PathBuf::from(&path);
        let display = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let result: anyhow::Result<u64> = async {
            if !p.is_absolute() {
                anyhow::bail!("caminho inválido");
            }
            let pp = p.clone();
            let plan = tokio::task::spawn_blocking(move || files::plan_get(&pp)).await??;
            let total: u64 = plan.iter().map(|f| f.size).sum();
            let list: Vec<Value> = plan
                .iter()
                .enumerate()
                .map(|(i, f)| json!({"fileIndex": i, "relPath": f.rel_path, "size": f.size}))
                .collect();
            send_json(
                &dc,
                json!({"op":"get_meta","id":id,"files":list,"totalSize":total}),
            )
            .await;
            self.emit_transfer(
                id,
                Direction::Download,
                &display,
                0,
                total,
                TransferState::Active,
                None,
            );
            let mut sent = 0u64;
            let mut last_emit = Instant::now();
            let mut buf = vec![0u8; CHUNK];
            for (idx, f) in plan.iter().enumerate() {
                let mut file = tokio::fs::File::open(&f.abs).await?;
                loop {
                    if cancel.load(Ordering::Relaxed) || self.is_closed() || !self.files_allowed() {
                        anyhow::bail!("cancelled");
                    }
                    let n = file.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    wait_drain(&dc, &notify).await;
                    dc.send(&Bytes::from(files::encode_header(
                        id,
                        idx as u32,
                        &buf[..n],
                    )))
                    .await?;
                    sent += n as u64;
                    if last_emit.elapsed() > Duration::from_millis(250) {
                        last_emit = Instant::now();
                        self.emit_transfer(
                            id,
                            Direction::Download,
                            &display,
                            sent,
                            total,
                            TransferState::Active,
                            None,
                        );
                    }
                }
                send_json(&dc, json!({"op":"file_end","id":id,"fileIndex":idx})).await;
            }
            send_json(&dc, json!({"op":"done","id":id})).await;
            Ok(total)
        }
        .await;
        self.files_state.gets.lock().remove(&id);
        match result {
            Ok(total) => {
                self.emit_transfer(
                    id,
                    Direction::Download,
                    &display,
                    total,
                    total,
                    TransferState::Done,
                    None,
                );
                self.audit("file_sent", json!({"path": path, "size": total}));
            }
            Err(e) if e.to_string() == "cancelled" => {
                self.emit_transfer(
                    id,
                    Direction::Download,
                    &display,
                    0,
                    0,
                    TransferState::Cancelled,
                    None,
                );
            }
            Err(e) => {
                send_json(&dc, json!({"op":"error","id":id,"message":e.to_string()})).await;
                self.emit_transfer(
                    id,
                    Direction::Download,
                    &display,
                    0,
                    0,
                    TransferState::Error,
                    Some(e.to_string()),
                );
            }
        }
    }

    /// Cancels an upload (deleting the partial file) or a download.
    pub(crate) async fn cancel_transfer(&self, id: u32, emit: bool) {
        if let Some(st) = self.puts().lock().await.remove(&id) {
            drop(st.file);
            let _ = tokio::fs::remove_file(&st.path).await;
            if emit {
                self.emit_transfer(
                    id,
                    Direction::Upload,
                    &st.name,
                    st.received,
                    st.size,
                    TransferState::Cancelled,
                    None,
                );
            }
        }
        if let Some(flag) = self.files_state.gets.lock().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub(crate) async fn cancel_all_transfers(&self) {
        let ids: Vec<u32> = self.puts().lock().await.keys().copied().collect();
        for id in ids {
            self.cancel_transfer(id, true).await;
        }
        for flag in self.files_state.gets.lock().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn puts(&self) -> &tokio::sync::Mutex<HashMap<u32, PutState>> {
        &self.files_state.puts
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_transfer(
        &self,
        id: u32,
        direction: Direction,
        name: &str,
        bytes: u64,
        total: u64,
        state: TransferState,
        message: Option<String>,
    ) {
        self.events.on_transfer(
            &self.cfg.session_id,
            TransferEvent {
                id,
                direction,
                name: name.to_string(),
                bytes,
                total,
                state,
                message,
            },
        );
    }
}
