//! Nexo desktop shell (Tauri 2): wires the UI to `nexo-core` (PROTOCOL.md §5).

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_opener::OpenerExt;

use nexo_core::auth::{hash_password, AuthGuard};
use nexo_core::host::{ChatMessage, HostConfig, HostEvents, HostSession, HostState, TransferEvent};
use nexo_core::identity::{self, Identity};
use nexo_core::input::InputHandle;
use nexo_core::protocol::{
    IceCandidate, IceServer, MonitorInfo, Permissions, SessionMode, SignalData,
};
use nexo_core::settings::{AuditEvent, Secrets, Settings, Store};

const TRAY_ID: &str = "nexo-tray";

struct DlFile {
    file: std::fs::File,
    path: PathBuf,
}

pub struct AppState {
    identity: Arc<Identity>,
    store: Arc<Store>,
    guard: Arc<AuthGuard>,
    input: InputHandle,
    sessions: tokio::sync::Mutex<HashMap<String, HostSession>>,
    downloads: Mutex<HashMap<(u32, u32), DlFile>>,
    end_item: Mutex<Option<MenuItem<Wry>>>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- host events → UI

struct TauriEvents {
    app: AppHandle,
}

impl HostEvents for TauriEvents {
    fn on_offer(&self, session_id: &str, sdp: &str, restart: bool) {
        let _ = self.app.emit(
            "host://offer",
            json!({"sessionId": session_id, "sdp": sdp, "restart": restart}),
        );
    }
    fn on_ice(&self, session_id: &str, candidate: IceCandidate) {
        let _ = self.app.emit(
            "host://ice",
            json!({"sessionId": session_id, "candidate": candidate}),
        );
    }
    fn on_state(&self, session_id: &str, state: HostState, detail: Option<String>) {
        let _ = self.app.emit(
            "host://state",
            json!({"sessionId": session_id, "state": state, "detail": detail}),
        );
        let tip = match state {
            HostState::Streaming => "Nexo — sessão remota ativa",
            HostState::AwaitingAuth => "Nexo — aguardando autenticação",
            HostState::Connecting | HostState::Reconnecting => "Nexo — conectando sessão…",
            HostState::Closed => "Nexo",
        };
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(tip));
        }
    }
    fn on_chat(&self, session_id: &str, msg: ChatMessage) {
        let _ = self.app.emit(
            "host://chat",
            json!({"sessionId": session_id, "id": msg.id, "text": msg.text, "ts": msg.ts}),
        );
    }
    fn on_transfer(&self, session_id: &str, ev: TransferEvent) {
        let mut v = serde_json::to_value(&ev).unwrap_or_default();
        v["sessionId"] = json!(session_id);
        let _ = self.app.emit("host://transfer", v);
    }
    fn on_auth(&self, session_id: &str, ok: bool, viewer_id: &str) {
        let _ = self.app.emit(
            "host://auth",
            json!({"sessionId": session_id, "ok": ok, "viewerId": viewer_id}),
        );
    }
    fn on_ended(&self, session_id: &str, reason: &str) {
        let _ = self.app.emit(
            "host://ended",
            json!({"sessionId": session_id, "reason": reason}),
        );
        let app = self.app.clone();
        let sid = session_id.to_string();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let empty = {
                let mut s = state.sessions.lock().await;
                s.remove(&sid);
                s.is_empty()
            };
            if empty {
                update_indicator(&app, false);
            }
        });
    }
}

fn update_indicator(app: &AppHandle, active: bool) {
    if let Some(w) = app.get_webview_window("indicator") {
        if active {
            if let (Ok(Some(m)), Ok(size)) = (w.primary_monitor(), w.outer_size()) {
                let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
                let y = m.position().y + (12.0 * m.scale_factor()) as i32;
                let _ = w.set_position(PhysicalPosition::new(x, y));
            }
            let _ = w.show();
            let _ = w.set_always_on_top(true);
        } else {
            let _ = w.hide();
        }
    }
    if let Some(item) = app.state::<AppState>().end_item.lock().as_ref() {
        let _ = item.set_enabled(active);
    }
    if !active {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some("Nexo"));
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Stops every host session (tray "Encerrar sessão"/"Sair") and tells the UI so it can `end` them.
async fn stop_all_sessions(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    let sessions: Vec<HostSession> = state
        .sessions
        .lock()
        .await
        .drain()
        .map(|(_, s)| s)
        .collect();
    for s in sessions {
        s.stop(reason).await;
        let _ = app.emit(
            "host://ended",
            json!({"sessionId": s.session_id(), "reason": reason}),
        );
    }
    update_indicator(app, false);
}

// ---------------------------------------------------------------- identity & info

#[tauri::command]
fn identity_get(state: State<'_, AppState>) -> serde_json::Value {
    json!({"publicKey": state.identity.public_key_b64(), "fingerprint": state.identity.fingerprint()})
}

#[tauri::command]
fn identity_sign(state: State<'_, AppState>, message: String) -> String {
    state.identity.sign(&message)
}

#[tauri::command]
fn identity_verify(public_key: String, message: String, signature: String) -> bool {
    identity::verify(&public_key, &message, &signature)
}

#[tauri::command]
fn device_info() -> serde_json::Value {
    json!({"hostname": nexo_core::hostname(), "os": nexo_core::os_name(), "appVersion": nexo_core::APP_VERSION})
}

/// Grava uma linha no log do app (<app config>/nexo.log), com rotação simples em 1 MiB.
#[tauri::command]
fn app_log(app: AppHandle, level: String, message: String) {
    write_log(&app, &level, &message);
}

fn write_log(app: &AppHandle, level: &str, message: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("nexo.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("nexo.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let msg: String = message.chars().take(2000).collect();
        let _ = writeln!(f, "{ts} [{level}] {msg}");
    }
}

/// Procura servidores Nexo na rede local: broadcast UDP "NEXO_DISCOVER_V1" na porta 41234
/// (limitado + direcionado por interface + loopback) e coleta as respostas unicast.
#[tauri::command]
async fn discover_servers(timeout_ms: Option<u64>) -> CmdResult<Vec<serde_json::Value>> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(1500).clamp(300, 5000));
    tokio::task::spawn_blocking(move || discover_blocking(timeout))
        .await
        .map_err(err)?
        .map_err(err)
}

fn discover_blocking(timeout: std::time::Duration) -> anyhow::Result<Vec<serde_json::Value>> {
    use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
    const PORT: u16 = 41234;
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    sock.set_broadcast(true)?;
    let probe = b"NEXO_DISCOVER_V1";
    let mut targets: Vec<Ipv4Addr> = vec![Ipv4Addr::LOCALHOST, Ipv4Addr::BROADCAST];
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for i in ifaces {
            if let if_addrs::IfAddr::V4(v4) = i.addr {
                if v4.ip.is_loopback() {
                    continue;
                }
                let b = v4
                    .broadcast
                    .unwrap_or_else(|| Ipv4Addr::from(u32::from(v4.ip) | !u32::from(v4.netmask)));
                if !targets.contains(&b) {
                    targets.push(b);
                }
            }
        }
    }
    for t in &targets {
        let _ = sock.send_to(probe, SocketAddrV4::new(*t, PORT));
    }
    let deadline = std::time::Instant::now() + timeout;
    // (id do servidor, url, é_localhost)
    // (id do servidor, url, é_localhost, endereço público)
    let mut found: Vec<(String, String, bool, Option<String>)> = Vec::new();
    let mut buf = [0u8; 512];
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        sock.set_read_timeout(Some(left.max(std::time::Duration::from_millis(5))))?;
        let (n, from) = match sock.recv_from(&mut buf) {
            Ok(r) => r,
            // No Windows, a procura enviada a uma porta fechada (ex.: 127.0.0.1 sem servidor)
            // volta como WSAECONNRESET; isso não pode encerrar a escuta das respostas da rede.
            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::Interrupted) => continue,
            Err(_) => break,
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
        if v.get("nexo").and_then(|x| x.as_u64()) != Some(1) {
            continue;
        }
        let Some(port) = v.get("port").and_then(|x| x.as_u64()) else { continue };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let local = from.ip().is_loopback();
        let host = if local { "localhost".to_string() } else { from.ip().to_string() };
        let url = format!("http://{host}:{port}");
        // Só aceita endereço público https:// (anunciado pelo PC servidor com acesso pela internet).
        let public_url = v
            .get("publicUrl")
            .and_then(|x| x.as_str())
            .filter(|u| u.starts_with("https://") && u.len() < 256)
            .map(str::to_string);
        if !found.iter().any(|f| f.1 == url) {
            found.push((id, url, local, public_url));
        }
    }
    // Ordem canônica: menor id primeiro (todos os computadores escolhem o mesmo servidor);
    // para o mesmo servidor, o endereço localhost vem antes. Um endereço por servidor.
    found.sort_by(|a, b| a.0.cmp(&b.0).then(b.2.cmp(&a.2)));
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (id, url, _, public_url) in found {
        if !id.is_empty() && seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        out.push(json!({"url": url, "id": id, "publicUrl": public_url}));
    }
    Ok(out)
}

#[tauri::command]
async fn monitors_list() -> CmdResult<Vec<MonitorInfo>> {
    tokio::task::spawn_blocking(nexo_core::capture::list_monitors)
        .await
        .map_err(err)?
        .map_err(err)
}

// ---------------------------------------------------------------- settings & security

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Settings {
    state.store.load_settings()
}

#[tauri::command]
fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> CmdResult<Settings> {
    let before = state.store.load_settings();
    let saved = state.store.save_settings(&settings).map_err(err)?;
    if before.launch_on_startup != saved.launch_on_startup {
        let al = app.autolaunch();
        let r = if saved.launch_on_startup {
            al.enable()
        } else {
            al.disable()
        };
        if let Err(e) = r {
            tracing::warn!("autostart: {e}");
        }
    }
    if before.unattended != saved.unattended {
        state.store.audit(
            "unattended_settings_changed",
            None,
            None,
            json!({"enabled": saved.unattended.enabled, "allowed": saved.unattended.allowed_device_ids.len()}),
        );
    }
    Ok(saved)
}

#[tauri::command]
async fn security_set_unattended_password(
    state: State<'_, AppState>,
    password: String,
) -> CmdResult<Settings> {
    if password.chars().count() < 8 {
        return Err("A senha deve ter pelo menos 8 caracteres".into());
    }
    let hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(err)?
        .map_err(err)?;
    state
        .store
        .save_secrets(&Secrets {
            unattended_hash: Some(hash),
        })
        .map_err(err)?;
    state
        .store
        .audit("unattended_password_set", None, None, json!({}));
    Ok(state.store.load_settings())
}

#[tauri::command]
fn security_clear_unattended_password(state: State<'_, AppState>) -> CmdResult<Settings> {
    state
        .store
        .save_secrets(&Secrets {
            unattended_hash: None,
        })
        .map_err(err)?;
    let mut s = state.store.load_settings();
    s.unattended.enabled = false;
    let s = state.store.save_settings(&s).map_err(err)?;
    state
        .store
        .audit("unattended_password_cleared", None, None, json!({}));
    Ok(s)
}

#[tauri::command]
fn audit_local_list(state: State<'_, AppState>, limit: Option<usize>) -> Vec<AuditEvent> {
    state.store.audit_list(limit.unwrap_or(200).min(5000))
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().open_path(path, None::<&str>).map_err(err)
}

/// Not in PROTOCOL §5 (additive): lets the UI put the device ID/status in the tray tooltip.
#[tauri::command]
fn tray_update(app: AppHandle, tooltip: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip.chars().take(120).collect::<String>()));
    }
}

// ---------------------------------------------------------------- host sessions

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerArg {
    device_id: String,
    #[serde(default)]
    name: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn host_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    mode: SessionMode,
    ice_servers: Vec<IceServer>,
    permissions: Permissions,
    viewer: ViewerArg,
) -> CmdResult<()> {
    let settings = state.store.load_settings();
    let secrets = state.store.load_secrets();
    if mode == SessionMode::Unattended {
        if !settings.unattended.enabled || secrets.unattended_hash.is_none() {
            return Err("Acesso não supervisionado está desativado neste computador".into());
        }
        let allowed = &settings.unattended.allowed_device_ids;
        if !allowed.is_empty() && !allowed.contains(&viewer.device_id) {
            return Err("Dispositivo não autorizado para acesso não supervisionado".into());
        }
    }
    let host_name = if settings.device_name.trim().is_empty() {
        nexo_core::hostname()
    } else {
        settings.device_name.clone()
    };
    let cfg = HostConfig {
        session_id: session_id.clone(),
        mode,
        ice_servers,
        permissions,
        viewer_id: viewer.device_id,
        viewer_name: viewer.name,
        host_name,
        os: nexo_core::os_name(),
        unattended_hash: secrets.unattended_hash,
        allowed_device_ids: settings.unattended.allowed_device_ids.clone(),
        auth_guard: state.guard.clone(),
        receive_dir: settings.receive_dir_path(),
        quality: settings.quality,
        fps: settings.fps,
        store: Some(state.store.clone()),
        input: state.input.clone(),
    };
    let previous = state.sessions.lock().await.remove(&session_id);
    if let Some(p) = previous {
        p.stop("restarted").await;
    }
    let session = HostSession::start(cfg, Arc::new(TauriEvents { app: app.clone() }));
    state.sessions.lock().await.insert(session_id, session);
    update_indicator(&app, true);
    Ok(())
}

async fn get_session(state: &State<'_, AppState>, id: &str) -> CmdResult<HostSession> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "sessão não encontrada".to_string())
}

#[tauri::command]
async fn host_signal(
    state: State<'_, AppState>,
    session_id: String,
    data: SignalData,
) -> CmdResult<()> {
    get_session(&state, &session_id)
        .await?
        .signal(data)
        .await
        .map_err(err)
}

#[tauri::command]
async fn host_send_chat(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> CmdResult<ChatMessage> {
    get_session(&state, &session_id)
        .await?
        .send_chat(&text)
        .await
        .map_err(err)
}

#[tauri::command]
async fn host_set_permissions(
    state: State<'_, AppState>,
    session_id: String,
    permissions: Permissions,
) -> CmdResult<()> {
    get_session(&state, &session_id)
        .await?
        .set_permissions(permissions)
        .await;
    Ok(())
}

#[tauri::command]
async fn host_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    reason: Option<String>,
) -> CmdResult<()> {
    let (s, empty) = {
        let mut map = state.sessions.lock().await;
        let s = map.remove(&session_id);
        (s, map.is_empty())
    };
    if let Some(s) = s {
        s.stop(reason.as_deref().unwrap_or("host_ended")).await;
    }
    if empty {
        update_indicator(&app, false);
    }
    Ok(())
}

// ---------------------------------------------------------------- viewer downloads

#[tauri::command]
fn dl_open(
    state: State<'_, AppState>,
    id: u32,
    file_index: u32,
    dest_root: String,
    rel_path: String,
) -> CmdResult<String> {
    let root = PathBuf::from(&dest_root);
    if !root.is_absolute() || !root.is_dir() {
        return Err("pasta de destino inválida".into());
    }
    let target = nexo_core::files::safe_join(&root, &rel_path).map_err(err)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    let target = nexo_core::files::unique_path(&target);
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(err)?;
    let path = target.to_string_lossy().into_owned();
    if let Some(old) = state
        .downloads
        .lock()
        .insert((id, file_index), DlFile { file, path: target })
    {
        let _ = std::fs::remove_file(old.path);
    }
    Ok(path)
}

fn header_u32(req: &tauri::ipc::Request<'_>, name: &str) -> CmdResult<u32> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("cabeçalho {name} ausente"))
}

#[tauri::command]
async fn dl_write(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("corpo binário esperado".into());
    };
    let key = (
        header_u32(&request, "x-id")?,
        header_u32(&request, "x-file-index")?,
    );
    let mut map = state.downloads.lock();
    let f = map.get_mut(&key).ok_or("download não aberto")?;
    f.file.write_all(data).map_err(err)
}

#[tauri::command]
fn dl_close(state: State<'_, AppState>, id: u32, file_index: u32) -> CmdResult<()> {
    if let Some(mut f) = state.downloads.lock().remove(&(id, file_index)) {
        f.file.flush().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn dl_abort(state: State<'_, AppState>, id: u32) {
    let mut map = state.downloads.lock();
    let keys: Vec<(u32, u32)> = map.keys().filter(|(i, _)| *i == id).copied().collect();
    for k in keys {
        if let Some(f) = map.remove(&k) {
            drop(f.file);
            let _ = std::fs::remove_file(f.path);
        }
    }
}

// ---------------------------------------------------------------- app

fn build_tray(app: &tauri::App) -> tauri::Result<MenuItem<Wry>> {
    let open = MenuItem::with_id(app, "open", "Abrir Nexo", true, None::<&str>)?;
    let end = MenuItem::with_id(app, "end", "Encerrar sessão", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &end, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Nexo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "end" => {
                let app = app.clone();
                tauri::async_runtime::spawn(
                    async move { stop_all_sessions(&app, "host_ended").await },
                );
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_all_sessions(&app, "host_quit").await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(end)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "info,webrtc=warn,webrtc_ice=error,webrtc_sctp=warn,webrtc_dtls=warn".into()
            }),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let identity = Arc::new(Identity::load_or_create(&dir)?);
            let store = Arc::new(Store::new(&dir)?);
            store.audit(
                "app_started",
                None,
                None,
                json!({"version": nexo_core::APP_VERSION}),
            );
            app.manage(AppState {
                identity,
                store,
                guard: Arc::new(AuthGuard::new()),
                input: InputHandle::spawn(),
                sessions: tokio::sync::Mutex::new(HashMap::new()),
                downloads: Mutex::new(HashMap::new()),
                end_item: Mutex::new(None),
            });
            // As janelas só são criadas DEPOIS de o estado existir: no Windows o WebView2
            // carrega rápido e chamaria os comandos antes do `.manage()` (corrida na inicialização).
            for cfg in app.config().app.windows.clone() {
                if app.get_webview_window(&cfg.label).is_none() {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?.build()?;
                }
            }
            match build_tray(app) {
                Ok(end) => *app.state::<AppState>().end_item.lock() = Some(end),
                Err(e) => tracing::warn!("tray unavailable: {e}"),
            }
            let minimized = std::env::args().any(|a| a == "--minimized");
            if !minimized {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing hides to the tray so the device stays reachable; "Sair" quits.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            identity_get,
            identity_sign,
            identity_verify,
            device_info,
            monitors_list,
            settings_get,
            settings_set,
            security_set_unattended_password,
            security_clear_unattended_password,
            audit_local_list,
            open_path,
            tray_update,
            host_start,
            host_signal,
            host_send_chat,
            host_set_permissions,
            host_stop,
            dl_open,
            dl_write,
            dl_close,
            dl_abort,
            discover_servers,
            app_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexo");
}
