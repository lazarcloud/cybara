// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::RunEvent;
use tauri_plugin_audio_recorder::{AudioFormat, AudioQuality, AudioRecorderExt, RecordingConfig};
use tauri_plugin_shell::ShellExt;

mod desktop_update;
mod gateway;
mod gateway_ownership;
mod gateway_supervision;
mod tray;

const CYBARA_DEFAULT_PORT: u16 = 4269;
const MAX_NATIVE_RECORDING_BYTES: u64 = 64 * 1024 * 1024;

/// Compile-time build flavor. `local` ships only the bundled gateway sidecar,
/// `remote` ships only the remote-gateway client, and `mixed` supports both.
/// Set `CYBARA_DESKTOP_VARIANT` at build time; defaults to `mixed`.
const fn desktop_variant() -> &'static str {
    match option_env!("CYBARA_DESKTOP_VARIANT") {
        Some(value) => value,
        None => "mixed",
    }
}
const DESKTOP_VARIANT: &str = desktop_variant();
fn variant_supports_sidecar() -> bool {
    matches!(DESKTOP_VARIANT, "local" | "mixed")
}
fn variant_supports_remote() -> bool {
    matches!(DESKTOP_VARIANT, "remote" | "mixed")
}
const REMOTE_GATEWAY_CONFIG_FILE: &str = "remote-gateway.json";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayStartupStatus {
    phase: String,
    message: Option<String>,
    ownership: String,
    can_switch_to_local: bool,
    needs_remote_config: bool,
    remote_url: Option<String>,
    variant: String,
    supports_sidecar: bool,
    supports_remote: bool,
}

impl GatewayStartupStatus {
    fn starting(ownership: gateway_ownership::GatewayOwnership) -> Self {
        Self::with_phase("starting", None, ownership)
    }

    fn ready(ownership: gateway_ownership::GatewayOwnership) -> Self {
        Self::with_phase("ready", None, ownership)
    }

    fn restarting(
        message: impl Into<String>,
        ownership: gateway_ownership::GatewayOwnership,
    ) -> Self {
        Self::with_phase("starting", Some(message.into()), ownership)
    }

    fn failed(message: impl Into<String>, ownership: gateway_ownership::GatewayOwnership) -> Self {
        Self::with_phase("failed", Some(message.into()), ownership)
    }

    /// The remote-only build has no gateway yet: ask the operator for a server URL.
    fn needs_remote_config() -> Self {
        let mut status = Self::with_phase(
            "failed",
            Some(
                "No Cybara server is configured. Enter the URL of your Cybara server to connect."
                    .into(),
            ),
            gateway_ownership::GatewayOwnership::RemoteHosted,
        );
        status.needs_remote_config = true;
        status
    }

    /// The window renders a user-configured remote gateway directly.
    fn remote_ready(url: &str) -> Self {
        let mut status = Self::with_phase(
            "ready",
            None,
            gateway_ownership::GatewayOwnership::RemoteHosted,
        );
        status.remote_url = Some(url.to_string());
        status.can_switch_to_local = variant_supports_sidecar();
        status
    }

    fn with_phase(
        phase: &str,
        message: Option<String>,
        ownership: gateway_ownership::GatewayOwnership,
    ) -> Self {
        Self {
            phase: phase.into(),
            message,
            ownership: ownership.as_str().into(),
            can_switch_to_local: ownership == gateway_ownership::GatewayOwnership::AttachedExternal,
            needs_remote_config: false,
            remote_url: None,
            variant: DESKTOP_VARIANT.into(),
            supports_sidecar: variant_supports_sidecar(),
            supports_remote: variant_supports_remote(),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRecordingData {
    audio_base64: String,
    mime_type: String,
    file_name: String,
}

#[cfg(target_os = "macos")]
async fn ensure_microphone_access() -> Result<(), String> {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let media_type = unsafe { AVMediaTypeAudio }
        .ok_or_else(|| "macOS audio authorization is unavailable".to_string())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };

    match status {
        AVAuthorizationStatus::Authorized => Ok(()),
        AVAuthorizationStatus::Denied => Err(
            "Microphone access is disabled. Enable Cybara in System Settings > Privacy & Security > Microphone."
                .into(),
        ),
        AVAuthorizationStatus::Restricted => {
            Err("Microphone access is restricted by macOS policy.".into())
        }
        AVAuthorizationStatus::NotDetermined => {
            let granted = tauri::async_runtime::spawn_blocking(|| {
                let media_type = unsafe { AVMediaTypeAudio }
                    .ok_or_else(|| "macOS audio authorization is unavailable".to_string())?;
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
                    let _ = sender.send(granted.as_bool());
                });
                unsafe {
                    AVCaptureDevice::requestAccessForMediaType_completionHandler(
                        media_type,
                        &handler,
                    );
                }
                receiver
                    .recv_timeout(Duration::from_secs(120))
                    .map_err(|_| "Timed out waiting for microphone permission.".to_string())
            })
            .await
            .map_err(|error| error.to_string())??;
            if granted {
                Ok(())
            } else {
                Err(
                    "Microphone access was denied. Enable Cybara in System Settings > Privacy & Security > Microphone."
                        .into(),
                )
            }
        }
        _ => Err("macOS returned an unknown microphone authorization state".into()),
    }
}

#[cfg(not(target_os = "macos"))]
async fn ensure_microphone_access() -> Result<(), String> {
    Ok(())
}

async fn read_native_recording(path: String) -> Result<NativeRecordingData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recording = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
        let temp =
            std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
        let file_name = recording
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "invalid native recording path".to_string())?;
        if !recording.starts_with(&temp)
            || !file_name.starts_with("recording-")
            || recording.extension().and_then(|value| value.to_str()) != Some("wav")
        {
            return Err(
                "native recording path is outside the temporary recording directory".into(),
            );
        }
        let metadata = std::fs::metadata(&recording).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_NATIVE_RECORDING_BYTES {
            return Err("native recording exceeds the maximum supported size".into());
        }
        let bytes = std::fs::read(&recording).map_err(|error| error.to_string())?;
        std::fs::remove_file(&recording).map_err(|error| error.to_string())?;
        Ok(NativeRecordingData {
            audio_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type: "audio/wav".into(),
            file_name: file_name.to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_native_recording(app: tauri::AppHandle) -> Result<(), String> {
    ensure_microphone_access().await?;
    tauri::async_runtime::spawn_blocking(move || {
        app.audio_recorder()
            .start_recording(RecordingConfig {
                output_path: String::new(),
                format: AudioFormat::Wav,
                quality: AudioQuality::Low,
                max_duration: 300,
                device_id: None,
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn stop_native_recording(app: tauri::AppHandle) -> Result<NativeRecordingData, String> {
    let recording = tauri::async_runtime::spawn_blocking(move || {
        app.audio_recorder()
            .stop_recording()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    read_native_recording(recording.file_path).await
}

#[tauri::command]
fn write_theme_file(path: String, content: String) -> Result<(), String> {
    const MAX_THEME_BYTES: usize = 64 * 1024;
    if content.len() > MAX_THEME_BYTES {
        return Err("theme file exceeds the maximum supported size".into());
    }
    let target = std::path::PathBuf::from(path);
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !file_name.ends_with(".cybara-theme.json") {
        return Err("theme export path must end with .cybara-theme.json".into());
    }
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|_| "theme export content is not valid JSON".to_string())?;
    std::fs::write(target, content).map_err(|error| error.to_string())
}

fn should_log_sidecar_output() -> bool {
    !matches!(
        std::env::var("CYBARA_TAURI_LOG_SIDECAR"),
        Ok(value) if value == "0" || value.eq_ignore_ascii_case("false")
    )
}

fn bounded_sidecar_output(value: &str) -> String {
    value.trim().chars().take(64 * 1024).collect()
}

const SIDECAR_STDERR_TAIL_LINES: usize = 8;

fn record_sidecar_stderr(
    buffer: &std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut guard) = buffer.lock() {
        guard.push_back(trimmed.chars().take(600).collect());
        while guard.len() > SIDECAR_STDERR_TAIL_LINES {
            guard.pop_front();
        }
    }
}

fn sidecar_failure_reason(
    base: String,
    buffer: &std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
) -> String {
    let tail = buffer
        .lock()
        .ok()
        .map(|guard| guard.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    if tail.is_empty() {
        return base;
    }
    format!("{base} Gateway output:\n{}", tail.join("\n"))
}

fn set_gateway_startup_status(app: &tauri::AppHandle, status: GatewayStartupStatus) {
    if let Some(state) = app.try_state::<GatewayStartupState>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = status;
    }
}

#[tauri::command]
fn get_gateway_startup_status(app: tauri::AppHandle) -> GatewayStartupStatus {
    app.try_state::<GatewayStartupState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_else(|| {
            GatewayStartupStatus::starting(gateway_ownership::GatewayOwnership::ManagedLocal)
        })
}

#[tauri::command]
fn restart_gateway_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    match gateway_intent(&app).ownership {
        gateway_ownership::GatewayOwnership::ManagedLocal => {
            reset_gateway_supervision(&app)?;
            stop_sidecar(&app);
            schedule_sidecar_restart(app, "Restarting the managed Cybara gateway.".into());
        }
        gateway_ownership::GatewayOwnership::AttachedExternal => {
            start_external_gateway_reconnect(app);
        }
        gateway_ownership::GatewayOwnership::RemoteHosted => {
            let endpoint = gateway_endpoint(&app);
            if endpoint.is_remote() {
                navigate_window_to(&app, &endpoint.url);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn switch_to_local_gateway(app: tauri::AppHandle) -> Result<(), String> {
    let endpoint = gateway::GatewayEndpoint::loopback(CYBARA_DEFAULT_PORT);
    if gateway_ownership::switch_to_local_action(matches!(
        gateway::probe_gateway_at(&endpoint.addr, env!("CARGO_PKG_VERSION")),
        gateway::GatewayProbeStatus::Available
    )) == gateway_ownership::SwitchToLocalAction::WaitForFreePort
    {
        return Err(
            "Port 4269 must be free before switching to the managed local gateway. Stop the forwarding connection or occupying service, then try again."
                .into(),
        );
    }
    set_gateway_intent(
        &app,
        gateway_ownership::GatewayIntent::managed_local(CYBARA_DEFAULT_PORT),
    )?;
    reset_gateway_supervision(&app)?;
    stop_sidecar(&app);
    set_gateway_startup_status(
        &app,
        GatewayStartupStatus::restarting(
            "Switching to the managed local Cybara gateway.",
            gateway_ownership::GatewayOwnership::ManagedLocal,
        ),
    );
    start_sidecar(app, false);
    Ok(())
}

#[tauri::command]
fn get_desktop_variant() -> String {
    DESKTOP_VARIANT.to_string()
}

#[tauri::command]
fn set_remote_gateway_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !variant_supports_remote() {
        return Err("This Cybara build does not support remote gateways.".into());
    }
    let normalized = normalize_remote_url(&url).ok_or_else(|| {
        "Enter a valid http(s) URL, for example https://cybara.example.com".to_string()
    })?;
    persist_remote_gateway_url(&app, &normalized)?;
    apply_remote_gateway(&app, &normalized)
}

#[tauri::command]
fn use_local_gateway(app: tauri::AppHandle) -> Result<(), String> {
    if !variant_supports_sidecar() {
        return Err("This Cybara build has no bundled local gateway.".into());
    }
    remove_remote_gateway_url(&app);
    switch_to_local_gateway(app)
}

fn reset_gateway_supervision(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<GatewaySupervisionState>()
        .ok_or_else(|| "Gateway supervisor is unavailable".to_string())?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Gateway supervisor is unavailable".to_string())?;
    *guard = gateway_supervision::GatewaySupervision::default();
    Ok(())
}

fn is_browser_diagnostic_line(value: &str) -> bool {
    value.contains("Browser preview")
        || value.contains("browser preview")
        || value.contains("Windows browser CDP")
        || value.contains("[Browser]")
}

fn wait_for_server_ready(
    endpoint: &gateway::GatewayEndpoint,
    expected_version: &str,
    timeout: Duration,
) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if gateway::is_compatible_gateway_at(&endpoint.addr, expected_version) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.generation = guard.generation.wrapping_add(1);
            guard.launching = false;
            if let Some(child) = guard.child.take() {
                let _ = child.kill();
                println!("[Cybara] Sidecar stopped");
            }
        }
    }
}

fn shutdown_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<GatewaySupervisionState>()
        && let Ok(mut guard) = state.0.lock()
    {
        guard.mark_shutting_down();
    }
    stop_sidecar(app);
}

fn cybara_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CYBARA_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home).join(".cybara"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(profile).join(".cybara"));
    }
    None
}

#[tauri::command]
fn read_cybara_api_key() -> Result<Option<String>, String> {
    cybara_api_key()
}

pub(crate) fn badge_icon(base: &tauri::image::Image) -> tauri::image::Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    let w = width as i64;
    let h = height as i64;
    let radius = ((w.min(h) as f64) * 0.28).max(3.0);
    let cx = w as f64 - radius - 1.0;
    let cy = h as f64 - radius - 1.0;
    for y in 0..h {
        for x in 0..w {
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            if dx * dx + dy * dy <= radius * radius {
                let idx = ((y * w + x) * 4) as usize;
                if idx + 3 < rgba.len() {
                    rgba[idx] = 124;
                    rgba[idx + 1] = 92;
                    rgba[idx + 2] = 255;
                    rgba[idx + 3] = 255;
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, width, height)
}

fn cybara_api_key() -> Result<Option<String>, String> {
    if let Ok(key) = std::env::var("CYBARA_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }

    let Some(home) = cybara_home_dir() else {
        return Ok(None);
    };
    let path = home.join("api_key");
    match std::fs::read_to_string(&path) {
        Ok(value) => {
            let trimmed = value.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read Cybara API key: {error}")),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RemoteGatewayConfig {
    url: String,
}

fn remote_gateway_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(REMOTE_GATEWAY_CONFIG_FILE))
        .map_err(|error| error.to_string())
}

fn normalize_remote_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = tauri::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    parsed.host_str()?;
    Some(parsed.as_str().trim_end_matches('/').to_string())
}

fn remote_gateway_url_from_args(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--gateway-url=") {
            if let Some(url) = normalize_remote_url(value) {
                return Some(url);
            }
        } else if arg == "--gateway-url" {
            if let Some(value) = iter.next() {
                if let Some(url) = normalize_remote_url(value) {
                    return Some(url);
                }
            }
        }
    }
    None
}

/// Resolve the configured remote gateway URL. Precedence: `--gateway-url`
/// argument, then `CYBARA_GATEWAY_URL`, then the on-disk config written by the
/// in-app prompt. There is deliberately no baked-in default endpoint.
fn load_remote_gateway_url(app: &tauri::AppHandle) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if let Some(url) = remote_gateway_url_from_args(&args) {
        return Some(url);
    }
    if let Ok(value) = std::env::var("CYBARA_GATEWAY_URL") {
        if let Some(url) = normalize_remote_url(&value) {
            return Some(url);
        }
    }
    let path = remote_gateway_config_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let config: RemoteGatewayConfig = serde_json::from_str(&text).ok()?;
    normalize_remote_url(&config.url)
}

fn persist_remote_gateway_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let path = remote_gateway_config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let config = RemoteGatewayConfig {
        url: url.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())
}

fn remove_remote_gateway_url(app: &tauri::AppHandle) {
    if let Ok(path) = remote_gateway_config_path(app) {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("Failed to remove remote gateway config: {error}"),
        }
    }
}

fn file_path_from_args(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if std::path::Path::new(arg).exists() {
            return Some(arg.clone());
        }
    }
    None
}

fn gateway_endpoint(app: &tauri::AppHandle) -> gateway::GatewayEndpoint {
    app.try_state::<GatewayRuntimeState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_else(|| gateway::GatewayEndpoint::loopback(CYBARA_DEFAULT_PORT))
}

fn set_gateway_endpoint(app: &tauri::AppHandle, endpoint: gateway::GatewayEndpoint) {
    if let Some(state) = app.try_state::<GatewayRuntimeState>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = endpoint;
    }
}

fn gateway_intent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("gateway-intent.json"))
        .map_err(|error| error.to_string())
}

fn gateway_intent(app: &tauri::AppHandle) -> gateway_ownership::GatewayIntent {
    app.try_state::<GatewayOwnershipState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.intent()))
        .unwrap_or_else(|| gateway_ownership::GatewayIntent::managed_local(CYBARA_DEFAULT_PORT))
}

fn gateway_recovery_action(app: &tauri::AppHandle) -> gateway_ownership::RecoveryAction {
    app.try_state::<GatewayOwnershipState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.recovery_action()))
        .unwrap_or(gateway_ownership::RecoveryAction::RestartManagedSidecar)
}

fn set_gateway_intent(
    app: &tauri::AppHandle,
    intent: gateway_ownership::GatewayIntent,
) -> Result<(), String> {
    let path = gateway_intent_path(app)?;
    gateway_ownership::persist_gateway_intent(&path, &intent)?;
    let state = app
        .try_state::<GatewayOwnershipState>()
        .ok_or_else(|| "Gateway ownership state is unavailable".to_string())?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Gateway ownership state is unavailable".to_string())?;
    let port = intent.port;
    guard.set_intent(intent);
    set_gateway_endpoint(app, gateway::GatewayEndpoint::loopback(port));
    Ok(())
}

fn navigate_window_to(app: &tauri::AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(parsed) = tauri::Url::parse(url) {
            let _ = window.navigate(parsed);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Switch the desktop into remote-gateway mode. The window navigates to the
/// remote gateway's own web UI; no local sidecar is started and no loopback
/// probes are performed.
fn apply_remote_gateway(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let endpoint = gateway::GatewayEndpoint::from_url(url)
        .ok_or_else(|| format!("Invalid Cybara server URL: {url}"))?;
    let state = app
        .try_state::<GatewayOwnershipState>()
        .ok_or_else(|| "Gateway ownership state is unavailable".to_string())?;
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Gateway ownership state is unavailable".to_string())?;
        guard.set_intent(gateway_ownership::GatewayIntent::remote(
            endpoint.url.clone(),
            endpoint.port(),
        ));
    }
    set_gateway_endpoint(app, endpoint.clone());
    reset_gateway_supervision(app)?;
    stop_sidecar(app);
    set_gateway_startup_status(app, GatewayStartupStatus::remote_ready(&endpoint.url));
    navigate_window_to(app, &endpoint.url);
    Ok(())
}

/// If a persisted intent claims remote ownership but this launch is falling back
/// to a local build, clear it so the managed sidecar path can run.
fn reset_remote_intent_to_local(app: &tauri::AppHandle) {
    if gateway_intent(app).ownership != gateway_ownership::GatewayOwnership::RemoteHosted {
        return;
    }
    if let Err(error) = set_gateway_intent(
        app,
        gateway_ownership::GatewayIntent::managed_local(CYBARA_DEFAULT_PORT),
    ) {
        log::warn!("Failed to reset stale remote gateway intent: {error}");
    }
}

#[tauri::command]
fn get_gateway_url(app: tauri::AppHandle) -> String {
    gateway_endpoint(&app).url
}

fn ide_url_for_path(base_url: &str, path: &str) -> Option<tauri::Url> {
    let mut url = tauri::Url::parse(base_url).ok()?;
    url.set_path("/ide");
    url.query_pairs_mut().append_pair("path", path);
    Some(url)
}

fn set_pending_open(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingOpen>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(path);
        }
    }
}

fn take_pending_open(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<PendingOpen>()
        .and_then(|state| state.0.lock().ok().and_then(|mut guard| guard.take()))
}

fn open_path_in_ide(app: &tauri::AppHandle, path: &str) {
    let endpoint = gateway_endpoint(app);
    if !gateway::is_compatible_gateway_at(&endpoint.addr, env!("CARGO_PKG_VERSION")) {
        set_pending_open(app, path.to_string());
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Some(url) = ide_url_for_path(&endpoint.url, path) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn navigate_after_ready(app: &tauri::AppHandle) {
    let pending = take_pending_open(app);
    let endpoint = gateway_endpoint(app);
    if let Some(window) = app.get_webview_window("main") {
        let url = pending
            .as_deref()
            .and_then(|path| ide_url_for_path(&endpoint.url, path))
            .or_else(|| {
                window
                    .url()
                    .ok()
                    .and_then(|current| gateway_url_for_location(&endpoint.url, &current))
            })
            .unwrap_or_else(|| endpoint.url.parse().unwrap());
        let _ = window.navigate(url);
    }
}

fn gateway_url_for_location(base_url: &str, current: &tauri::Url) -> Option<tauri::Url> {
    let mut target = tauri::Url::parse(base_url).ok()?;
    if matches!(current.scheme(), "http" | "https") {
        target.set_path(current.path());
        target.set_query(current.query());
        target.set_fragment(current.fragment());
    }
    Some(target)
}

fn reserve_sidecar_launch(app: &tauri::AppHandle) -> Option<u64> {
    let state = app.try_state::<SidecarState>()?;
    let mut guard = state.0.lock().ok()?;
    if guard.child.is_some() || guard.launching {
        return None;
    }
    guard.launching = true;
    guard.generation = guard.generation.wrapping_add(1);
    Some(guard.generation)
}

fn release_sidecar_launch(app: &tauri::AppHandle, generation: u64) {
    if let Some(state) = app.try_state::<SidecarState>()
        && let Ok(mut guard) = state.0.lock()
        && guard.generation == generation
    {
        guard.launching = false;
    }
}

fn is_sidecar_launch_current(app: &tauri::AppHandle, generation: u64) -> bool {
    app.try_state::<SidecarState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .map(|guard| guard.generation == generation && guard.launching)
        })
        .unwrap_or(false)
}

fn store_sidecar_child(
    app: &tauri::AppHandle,
    generation: u64,
    child: tauri_plugin_shell::process::CommandChild,
) {
    let mut child = Some(child);
    if let Some(state) = app.try_state::<SidecarState>()
        && let Ok(mut guard) = state.0.lock()
        && guard.generation == generation
        && guard.launching
    {
        guard.child = child.take();
        guard.launching = false;
    }
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn clear_terminated_sidecar(app: &tauri::AppHandle, generation: u64) -> bool {
    let Some(state) = app.try_state::<SidecarState>() else {
        return false;
    };
    let Ok(mut guard) = state.0.lock() else {
        return false;
    };
    if guard.generation != generation {
        return false;
    }
    guard.child = None;
    guard.launching = false;
    true
}

fn stop_sidecar_generation(app: &tauri::AppHandle, generation: u64) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if guard.generation != generation {
        return;
    }
    guard.generation = guard.generation.wrapping_add(1);
    guard.launching = false;
    if let Some(child) = guard.child.take() {
        let _ = child.kill();
    }
}

fn record_gateway_healthy(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<GatewaySupervisionState>()
        && let Ok(mut guard) = state.0.lock()
    {
        guard.record_healthy();
    }
}

fn start_gateway_for_intent(app: tauri::AppHandle, allow_external_attach: bool) {
    match gateway_recovery_action(&app) {
        gateway_ownership::RecoveryAction::RestartManagedSidecar => {
            start_sidecar(app, allow_external_attach)
        }
        gateway_ownership::RecoveryAction::ReconnectExternal => {
            start_external_gateway_reconnect(app)
        }
    }
}

fn external_reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(1_u64 << attempt.min(4))
}

fn start_external_gateway_reconnect(app: tauri::AppHandle) {
    let Some((generation, intent)) = app.try_state::<GatewayOwnershipState>().and_then(|state| {
        state.0.lock().ok().and_then(|mut guard| {
            let intent = guard.intent();
            guard
                .begin_external_reconnect()
                .map(|generation| (generation, intent))
        })
    }) else {
        return;
    };
    let endpoint = gateway::GatewayEndpoint::loopback(intent.port);
    set_gateway_endpoint(&app, endpoint.clone());
    set_gateway_startup_status(
        &app,
        GatewayStartupStatus::restarting(
            "The attached external gateway is disconnected. Reconnecting without starting a local gateway.",
            gateway_ownership::GatewayOwnership::AttachedExternal,
        ),
    );
    std::thread::spawn(move || {
        let mut attempt = 0;
        loop {
            let current = app
                .try_state::<GatewayOwnershipState>()
                .and_then(|state| {
                    state
                        .0
                        .lock()
                        .ok()
                        .map(|guard| guard.external_reconnect_is_current(generation))
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let probe = gateway::probe_gateway_at(&endpoint.addr, env!("CARGO_PKG_VERSION"));
            let incompatibility = match &probe {
                gateway::GatewayProbeStatus::CybaraGateway(
                    gateway::GatewayCompatibility::Incompatible {
                        gateway_version,
                        reason,
                    },
                ) => Some(gateway_version_failure(
                    env!("CARGO_PKG_VERSION"),
                    gateway_version.as_deref(),
                    reason,
                )),
                _ => None,
            };
            match gateway_ownership::external_probe_action(intent.gateway_id.as_deref(), probe) {
                gateway_ownership::ExternalProbeAction::Reattach => {
                    if let Some(state) = app.try_state::<GatewayOwnershipState>()
                        && let Ok(mut guard) = state.0.lock()
                        && guard.finish_external_reconnect(generation)
                    {
                        record_gateway_healthy(&app);
                        set_gateway_startup_status(
                            &app,
                            GatewayStartupStatus::ready(
                                gateway_ownership::GatewayOwnership::AttachedExternal,
                            ),
                        );
                        navigate_after_ready(&app);
                    }
                    return;
                }
                gateway_ownership::ExternalProbeAction::Retry => {}
                gateway_ownership::ExternalProbeAction::Fail(reason) => {
                    finish_external_reconnect_with_failure(
                        &app,
                        generation,
                        incompatibility.unwrap_or(reason),
                    );
                    return;
                }
            }
            std::thread::sleep(external_reconnect_delay(attempt));
            attempt = attempt.saturating_add(1);
        }
    });
}

fn finish_external_reconnect_with_failure(
    app: &tauri::AppHandle,
    generation: u64,
    message: String,
) {
    if let Some(state) = app.try_state::<GatewayOwnershipState>()
        && let Ok(mut guard) = state.0.lock()
        && guard.finish_external_reconnect(generation)
    {
        set_gateway_startup_status(
            app,
            GatewayStartupStatus::failed(
                message,
                gateway_ownership::GatewayOwnership::AttachedExternal,
            ),
        );
    }
}

fn schedule_sidecar_restart(app: tauri::AppHandle, reason: String) {
    use gateway_supervision::RestartPlan;

    if gateway_recovery_action(&app) == gateway_ownership::RecoveryAction::ReconnectExternal {
        start_external_gateway_reconnect(app);
        return;
    }
    let plan = app
        .try_state::<GatewaySupervisionState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .map(|mut guard| guard.schedule_restart())
        });
    match plan {
        Some(RestartPlan::Retry { attempt, delay }) => {
            let message = format!(
                "Gateway unavailable. Restarting in {}s (attempt {attempt}/{}).",
                delay.as_secs(),
                gateway_supervision::MAX_RESTART_ATTEMPTS
            );
            log::warn!("{reason} {message}");
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::restarting(
                    message,
                    gateway_ownership::GatewayOwnership::ManagedLocal,
                ),
            );
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                let should_start = app
                    .try_state::<GatewaySupervisionState>()
                    .and_then(|state| {
                        state
                            .0
                            .lock()
                            .ok()
                            .map(|mut guard| guard.begin_scheduled_restart())
                    })
                    .unwrap_or(false);
                if should_start
                    && gateway_intent(&app).ownership
                        == gateway_ownership::GatewayOwnership::ManagedLocal
                {
                    start_sidecar(app, false);
                }
            });
        }
        Some(RestartPlan::Exhausted) => {
            let message = format!(
                "The Cybara gateway could not recover after {} attempts. Review the desktop and gateway logs, then restart Cybara.",
                gateway_supervision::MAX_RESTART_ATTEMPTS
            );
            log::error!("{reason} {message}");
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::failed(
                    message,
                    gateway_ownership::GatewayOwnership::ManagedLocal,
                ),
            );
        }
        Some(RestartPlan::AlreadyScheduled | RestartPlan::ShuttingDown) | None => {}
    }
}

fn gateway_version_failure(
    client_version: &str,
    gateway_version: Option<&str>,
    reason: &str,
) -> String {
    format!(
        "A Cybara gateway is running on port 4269, but this desktop cannot attach. Desktop version: {client_version}. Gateway version: {}. {reason} Update the older component from an official Cybara release, then retry. The desktop will not replace or stop an external gateway.",
        gateway_version.unwrap_or("unknown")
    )
}

fn attach_existing_gateway(
    app: &tauri::AppHandle,
    generation: u64,
    endpoint: gateway::GatewayEndpoint,
    gateway_id: String,
) {
    release_sidecar_launch(app, generation);
    let intent = gateway_ownership::GatewayIntent::attached_external(endpoint.port(), gateway_id);
    if let Err(error) = set_gateway_intent(app, intent) {
        set_gateway_startup_status(
            app,
            GatewayStartupStatus::failed(
                format!(
                    "The external gateway was verified, but its ownership could not be saved: {error}"
                ),
                gateway_ownership::GatewayOwnership::AttachedExternal,
            ),
        );
        return;
    }
    record_gateway_healthy(app);
    set_gateway_startup_status(
        app,
        GatewayStartupStatus::ready(gateway_ownership::GatewayOwnership::AttachedExternal),
    );
    navigate_after_ready(app);
}

fn wait_for_existing_gateway(
    app: tauri::AppHandle,
    generation: u64,
    endpoint: gateway::GatewayEndpoint,
    allow_external_attach: bool,
) {
    set_gateway_startup_status(
        &app,
        GatewayStartupStatus::restarting(
            "The existing Cybara gateway is busy. Waiting for it to respond.",
            gateway_ownership::GatewayOwnership::AttachedExternal,
        ),
    );
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        while is_sidecar_launch_current(&app, generation) {
            if Instant::now() >= deadline {
                release_sidecar_launch(&app, generation);
                set_gateway_startup_status(
                    &app,
                    GatewayStartupStatus::failed(
                        "The existing service on port 4269 did not become a healthy Cybara gateway within 60 seconds. Check that gateway or the forwarding connection, then retry."
                            .to_string(),
                        gateway_ownership::GatewayOwnership::AttachedExternal,
                    ),
                );
                return;
            }
            match gateway::probe_gateway_at(&endpoint.addr, env!("CARGO_PKG_VERSION")) {
                gateway::GatewayProbeStatus::CybaraGateway(
                    gateway::GatewayCompatibility::Compatible {
                        gateway_id: Some(gateway_id),
                        ..
                    },
                ) => {
                    if gateway_ownership::existing_gateway_action(allow_external_attach)
                        == gateway_ownership::ExistingGatewayAction::AttachExternal
                    {
                        attach_existing_gateway(&app, generation, endpoint, gateway_id);
                    } else {
                        release_sidecar_launch(&app, generation);
                        set_gateway_startup_status(
                            &app,
                            GatewayStartupStatus::failed(
                                "A pre-existing Cybara gateway is occupying the managed local gateway port. Cybara refused to change gateway ownership during recovery.",
                                gateway_ownership::GatewayOwnership::ManagedLocal,
                            ),
                        );
                    }
                    return;
                }
                gateway::GatewayProbeStatus::CybaraGateway(
                    gateway::GatewayCompatibility::Compatible {
                        gateway_id: None, ..
                    },
                ) => {
                    release_sidecar_launch(&app, generation);
                    set_gateway_startup_status(
                        &app,
                        GatewayStartupStatus::failed(
                            "The external gateway does not publish the supported gateway identity capability. Update that gateway before attaching so Cybara can detect accidental gateway replacement.",
                            if allow_external_attach {
                                gateway_ownership::GatewayOwnership::AttachedExternal
                            } else {
                                gateway_ownership::GatewayOwnership::ManagedLocal
                            },
                        ),
                    );
                    return;
                }
                gateway::GatewayProbeStatus::Busy => {
                    std::thread::sleep(Duration::from_millis(500));
                }
                gateway::GatewayProbeStatus::UnhealthyCybara { .. } => {
                    std::thread::sleep(Duration::from_millis(500));
                }
                gateway::GatewayProbeStatus::NonCybara => {
                    release_sidecar_launch(&app, generation);
                    set_gateway_startup_status(
                        &app,
                        GatewayStartupStatus::failed(
                            "Port 4269 is occupied by a non-Cybara service. Stop it before starting Cybara."
                                .to_string(),
                            gateway_ownership::GatewayOwnership::AttachedExternal,
                        ),
                    );
                    return;
                }
                gateway::GatewayProbeStatus::Available => {
                    release_sidecar_launch(&app, generation);
                    if allow_external_attach {
                        set_gateway_startup_status(
                            &app,
                            GatewayStartupStatus::failed(
                                "The pre-existing gateway endpoint disappeared before its identity could be verified. Cybara refused to start a local replacement. Restore the external gateway and retry, or explicitly switch to local mode.",
                                gateway_ownership::GatewayOwnership::AttachedExternal,
                            ),
                        );
                    } else {
                        start_sidecar(app, false);
                    }
                    return;
                }
                gateway::GatewayProbeStatus::CybaraGateway(
                    gateway::GatewayCompatibility::Incompatible {
                        gateway_version,
                        reason,
                    },
                ) => {
                    release_sidecar_launch(&app, generation);
                    set_gateway_startup_status(
                        &app,
                        GatewayStartupStatus::failed(
                            gateway_version_failure(
                                env!("CARGO_PKG_VERSION"),
                                gateway_version.as_deref(),
                                &reason,
                            ),
                            gateway_ownership::GatewayOwnership::AttachedExternal,
                        ),
                    );
                    return;
                }
            }
        }
    });
}

fn start_sidecar(app: tauri::AppHandle, allow_external_attach: bool) {
    let ownership = gateway_intent(&app).ownership;
    if ownership == gateway_ownership::GatewayOwnership::RemoteHosted {
        return;
    }
    if ownership != gateway_ownership::GatewayOwnership::ManagedLocal {
        start_external_gateway_reconnect(app);
        return;
    }
    let Some(generation) = reserve_sidecar_launch(&app) else {
        return;
    };
    let preferred = gateway::GatewayEndpoint::loopback(CYBARA_DEFAULT_PORT);
    match gateway::probe_gateway_at(&preferred.addr, env!("CARGO_PKG_VERSION")) {
        gateway::GatewayProbeStatus::CybaraGateway(gateway::GatewayCompatibility::Compatible {
            gateway_id: Some(gateway_id),
            ..
        }) => {
            if gateway_ownership::existing_gateway_action(allow_external_attach)
                == gateway_ownership::ExistingGatewayAction::AttachExternal
            {
                attach_existing_gateway(&app, generation, preferred, gateway_id);
            } else {
                release_sidecar_launch(&app, generation);
                schedule_sidecar_restart(
                    app,
                    "The previous managed gateway is still releasing port 4269; Cybara refused to adopt it and will retry within the bounded recovery budget."
                        .into(),
                );
            }
            return;
        }
        gateway::GatewayProbeStatus::CybaraGateway(gateway::GatewayCompatibility::Compatible {
            gateway_id: None,
            ..
        }) => {
            release_sidecar_launch(&app, generation);
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::failed(
                    "The external gateway does not publish the supported gateway identity capability. Update that gateway before attaching so Cybara can detect accidental gateway replacement.",
                    if allow_external_attach {
                        gateway_ownership::GatewayOwnership::AttachedExternal
                    } else {
                        gateway_ownership::GatewayOwnership::ManagedLocal
                    },
                ),
            );
            return;
        }
        gateway::GatewayProbeStatus::Busy | gateway::GatewayProbeStatus::UnhealthyCybara { .. } => {
            wait_for_existing_gateway(app, generation, preferred, allow_external_attach);
            return;
        }
        gateway::GatewayProbeStatus::NonCybara => {
            release_sidecar_launch(&app, generation);
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::failed(
                    "Port 4269 is occupied by a non-Cybara service. Stop it before starting Cybara."
                        .to_string(),
                    gateway_ownership::GatewayOwnership::ManagedLocal,
                ),
            );
            return;
        }
        gateway::GatewayProbeStatus::CybaraGateway(
            gateway::GatewayCompatibility::Incompatible {
                gateway_version,
                reason,
            },
        ) => {
            release_sidecar_launch(&app, generation);
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::failed(
                    gateway_version_failure(
                        env!("CARGO_PKG_VERSION"),
                        gateway_version.as_deref(),
                        &reason,
                    ),
                    gateway_ownership::GatewayOwnership::ManagedLocal,
                ),
            );
            return;
        }
        gateway::GatewayProbeStatus::Available => {}
    }

    if let Err(error) = set_gateway_intent(
        &app,
        gateway_ownership::GatewayIntent::managed_local(CYBARA_DEFAULT_PORT),
    ) {
        release_sidecar_launch(&app, generation);
        set_gateway_startup_status(
            &app,
            GatewayStartupStatus::failed(
                format!("The managed gateway ownership could not be saved: {error}"),
                gateway_ownership::GatewayOwnership::ManagedLocal,
            ),
        );
        return;
    }

    log::info!("Starting Cybara gateway sidecar on port {CYBARA_DEFAULT_PORT}");
    let Ok(mut sidecar) = app.shell().sidecar("cybara") else {
        release_sidecar_launch(&app, generation);
        schedule_sidecar_restart(
            app,
            "The packaged Cybara gateway could not be located.".into(),
        );
        return;
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_dir = resource_dir.to_string_lossy().to_string();
        let resource_dir = resource_dir
            .strip_prefix(r"\\?\")
            .map(|stripped| stripped.to_string())
            .unwrap_or(resource_dir);
        sidecar = sidecar.env("CYBARA_RESOURCE_DIR", resource_dir);
    }
    sidecar = sidecar
        .env("PORT", CYBARA_DEFAULT_PORT.to_string())
        .env("CYBARA_PORT_FALLBACK_COUNT", "0")
        .env("CYBARA_GATEWAY_PORT_SIGNAL", "stdout")
        .env("CYBARA_NATIVE_APP", "1")
        .env("CYBARA_NATIVE_PARENT_PID", std::process::id().to_string());
    let (port_sender, port_receiver) = std::sync::mpsc::sync_channel(1);
    let (mut rx, child) = match sidecar.args(["start"]).spawn() {
        Ok(result) => result,
        Err(error) => {
            release_sidecar_launch(&app, generation);
            schedule_sidecar_restart(app, format!("The Cybara gateway could not start: {error}"));
            return;
        }
    };

    store_sidecar_child(&app, generation, child);
    let log_sidecar_output = should_log_sidecar_output();
    let output_app = app.clone();
    let stderr_tail: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
    let stderr_tail_events = stderr_tail.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        let mut port_sender = Some(port_sender);
        let mut port_parser = gateway::GatewayPortSignalParser::default();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let output = String::from_utf8_lossy(&line);
                    if let Some(port) = port_parser.push(&output)
                        && let Some(sender) = port_sender.take()
                    {
                        let _ = sender.send(port);
                    }
                    let output = bounded_sidecar_output(&output);
                    if !output.is_empty() {
                        if is_browser_diagnostic_line(&output) {
                            log::info!(target: "cybara::browser", "{output}");
                        } else if log_sidecar_output {
                            log::info!(target: "cybara::sidecar", "{output}");
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let output = String::from_utf8_lossy(&line);
                    let output = output.trim();
                    if !output.is_empty() {
                        if is_browser_diagnostic_line(output) {
                            log::warn!(target: "cybara::browser", "{output}");
                        } else {
                            record_sidecar_stderr(&stderr_tail_events, output);
                            log::warn!(target: "cybara::sidecar", "{output}");
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    record_sidecar_stderr(&stderr_tail_events, &message);
                    log::warn!(target: "cybara::sidecar", "{message}");
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!(
                        "Cybara gateway sidecar terminated with code {:?}",
                        payload.code
                    );
                    if clear_terminated_sidecar(&output_app, generation) {
                        let base = match payload.code {
                            Some(code) => format!("Gateway exited with code {code}."),
                            None => "Gateway exited unexpectedly.".into(),
                        };
                        schedule_sidecar_restart(
                            output_app.clone(),
                            sidecar_failure_reason(base, &stderr_tail_events),
                        );
                    }
                    return;
                }
                _ => {}
            }
        }
        if clear_terminated_sidecar(&output_app, generation) {
            schedule_sidecar_restart(
                output_app,
                sidecar_failure_reason(
                    "Gateway process event stream closed unexpectedly.".into(),
                    &stderr_tail,
                ),
            );
        }
    });

    std::thread::spawn(move || {
        let port = match port_receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(port) => port,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                stop_sidecar_generation(&app, generation);
                schedule_sidecar_restart(
                    app,
                    "Gateway did not report its listening port within 30 seconds.".into(),
                );
                return;
            }
        };
        let endpoint = gateway::GatewayEndpoint::loopback(port);
        set_gateway_endpoint(&app, endpoint.clone());
        log::info!("Cybara gateway sidecar is listening on port {port}");
        if wait_for_server_ready(
            &endpoint,
            env!("CARGO_PKG_VERSION"),
            Duration::from_secs(25),
        ) {
            record_gateway_healthy(&app);
            set_gateway_startup_status(
                &app,
                GatewayStartupStatus::ready(gateway_ownership::GatewayOwnership::ManagedLocal),
            );
            navigate_after_ready(&app);
        } else {
            stop_sidecar_generation(&app, generation);
            schedule_sidecar_restart(
                app,
                "Gateway did not become ready within 25 seconds.".into(),
            );
        }
    });
}

fn attached_external_gateway_is_current(app: &tauri::AppHandle) -> bool {
    let intent = gateway_intent(app);
    if intent.ownership != gateway_ownership::GatewayOwnership::AttachedExternal {
        return true;
    }
    let endpoint = gateway_endpoint(app);
    gateway::compatible_gateway_id_at(&endpoint.addr, env!("CARGO_PKG_VERSION")).as_deref()
        == intent.gateway_id.as_deref()
}

fn start_gateway_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let shutting_down = app
                .try_state::<GatewaySupervisionState>()
                .and_then(|state| state.0.lock().ok().map(|guard| guard.is_shutting_down()))
                .unwrap_or(true);
            if shutting_down {
                return;
            }
            let ready = app
                .try_state::<GatewayStartupState>()
                .and_then(|state| state.0.lock().ok().map(|guard| guard.phase == "ready"))
                .unwrap_or(false);
            if !ready {
                continue;
            }
            if gateway_intent(&app).ownership == gateway_ownership::GatewayOwnership::RemoteHosted {
                continue;
            }
            let endpoint = gateway_endpoint(&app);
            let liveness = if gateway_intent(&app).ownership
                == gateway_ownership::GatewayOwnership::AttachedExternal
                && !attached_external_gateway_is_current(&app)
            {
                gateway::GatewayLivenessStatus::Unhealthy
            } else {
                gateway::gateway_liveness_at(&endpoint.addr)
            };
            let should_restart = app
                .try_state::<GatewaySupervisionState>()
                .and_then(|state| {
                    state.0.lock().ok().map(|mut guard| {
                        if matches!(
                            liveness,
                            gateway::GatewayLivenessStatus::Live
                                | gateway::GatewayLivenessStatus::Busy
                        ) {
                            guard.record_healthy();
                            false
                        } else {
                            guard.record_unhealthy()
                        }
                    })
                })
                .unwrap_or(false);
            if should_restart {
                match gateway_recovery_action(&app) {
                    gateway_ownership::RecoveryAction::RestartManagedSidecar => {
                        stop_sidecar(&app);
                        schedule_sidecar_restart(
                            app.clone(),
                            "Gateway liveness probe failed repeatedly.".into(),
                        );
                    }
                    gateway_ownership::RecoveryAction::ReconnectExternal => {
                        start_external_gateway_reconnect(app.clone());
                    }
                }
            }
        }
    });
}

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = file_path_from_args(&argv) {
                open_path_in_ide(app, &path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_audio_recorder::init())
        .invoke_handler(tauri::generate_handler![
            read_cybara_api_key,
            get_gateway_url,
            get_gateway_startup_status,
            restart_gateway_sidecar,
            switch_to_local_gateway,
            get_desktop_variant,
            set_remote_gateway_url,
            use_local_gateway,
            start_native_recording,
            stop_native_recording,
            write_theme_file,
            desktop_update::get_desktop_update_state,
            desktop_update::check_desktop_update,
            desktop_update::install_desktop_update
        ])
        .setup(|app| {
            app.manage(SidecarState(std::sync::Mutex::new(
                ManagedSidecar::default(),
            )));
            app.manage(GatewaySupervisionState(std::sync::Mutex::new(
                gateway_supervision::GatewaySupervision::default(),
            )));
            app.manage(PendingOpen(std::sync::Mutex::new(None)));
            let intent_path = app.path().app_local_data_dir()?.join("gateway-intent.json");
            let intent_result =
                gateway_ownership::load_gateway_intent(&intent_path, CYBARA_DEFAULT_PORT);
            let intent_error = intent_result.as_ref().err().cloned();
            let loaded_intent = intent_result.unwrap_or_else(|error| {
                log::error!("{error}");
                gateway_ownership::LoadedGatewayIntent {
                    intent: gateway_ownership::GatewayIntent::attached_external(
                        CYBARA_DEFAULT_PORT,
                        "invalid-persisted-gateway-intent".into(),
                    ),
                    persisted: true,
                }
            });
            let allow_external_attach = !loaded_intent.persisted;
            let intent = loaded_intent.intent;
            app.manage(GatewayOwnershipState(std::sync::Mutex::new(
                gateway_ownership::GatewayOwnershipController::new(intent.clone()),
            )));
            app.manage(GatewayStartupState(std::sync::Mutex::new(
                intent_error
                    .as_ref()
                    .map(|error| {
                        GatewayStartupStatus::failed(
                            format!(
                                "The saved external gateway intent could not be read: {error}. Cybara refused to start a local replacement."
                            ),
                            gateway_ownership::GatewayOwnership::AttachedExternal,
                        )
                    })
                    .unwrap_or_else(|| GatewayStartupStatus::starting(intent.ownership)),
            )));
            app.manage(GatewayRuntimeState(std::sync::Mutex::new(
                gateway::GatewayEndpoint::loopback(intent.port),
            )));
            app.manage(desktop_update::DesktopUpdateManager::default());
            tray::setup(app)?;

            if let Some(path) = file_path_from_args(&std::env::args().collect::<Vec<_>>()) {
                set_pending_open(app.handle(), path);
            }

            // The watchdog is always started; it skips remote-hosted gateways and
            // supervises the managed sidecar once ownership flips to local.
            start_gateway_watchdog(app.handle().clone());

            // Remote gateway mode takes precedence when a URL is configured.
            if variant_supports_remote()
                && let Some(url) = load_remote_gateway_url(app.handle())
            {
                if let Err(error) = apply_remote_gateway(app.handle(), &url) {
                    set_gateway_startup_status(
                        app.handle(),
                        GatewayStartupStatus::failed(
                            format!("The configured Cybara server URL is invalid: {error}"),
                            gateway_ownership::GatewayOwnership::RemoteHosted,
                        ),
                    );
                }
                return Ok(());
            }

            // A remote-only build with no configured URL asks the operator.
            if !variant_supports_sidecar() {
                reset_remote_intent_to_local(app.handle());
                set_gateway_startup_status(app.handle(), GatewayStartupStatus::needs_remote_config());
                return Ok(());
            }

            // Managed local mode (or external attach during first discovery).
            reset_remote_intent_to_local(app.handle());
            if intent_error.is_none() {
                start_gateway_for_intent(app.handle().clone(), allow_external_attach);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Cybara");

    app.run(|app_handle, event| match &event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => shutdown_sidecar(app_handle),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Some(path) = path.to_str() {
                        open_path_in_ide(app_handle, path);
                        break;
                    }
                }
            }
        }
        _ => {}
    });
}

#[derive(Default)]
struct ManagedSidecar {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    generation: u64,
    launching: bool,
}

struct SidecarState(std::sync::Mutex<ManagedSidecar>);

struct GatewaySupervisionState(std::sync::Mutex<gateway_supervision::GatewaySupervision>);

struct GatewayOwnershipState(std::sync::Mutex<gateway_ownership::GatewayOwnershipController>);

struct PendingOpen(std::sync::Mutex<Option<String>>);

struct GatewayStartupState(std::sync::Mutex<GatewayStartupStatus>);

struct GatewayRuntimeState(std::sync::Mutex<gateway::GatewayEndpoint>);

#[cfg(test)]
mod tests {
    use super::{gateway_url_for_location, gateway_version_failure, write_theme_file};

    #[test]
    fn theme_export_writes_valid_json_to_theme_file() {
        let root = std::env::temp_dir().join(format!("cybara-theme-export-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create theme export root");
        let path = root.join("studio.cybara-theme.json");
        write_theme_file(
            path.to_string_lossy().into_owned(),
            "{\"version\":1}".into(),
        )
        .expect("write theme export");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read theme export"),
            "{\"version\":1}"
        );
        std::fs::remove_dir_all(root).expect("remove theme export root");
    }

    #[test]
    fn theme_export_rejects_wrong_extension_and_invalid_json() {
        let root = std::env::temp_dir();
        assert!(
            write_theme_file(
                root.join("studio.json").to_string_lossy().into_owned(),
                "{\"version\":1}".into()
            )
            .is_err()
        );
        assert!(
            write_theme_file(
                root.join("studio.cybara-theme.json")
                    .to_string_lossy()
                    .into_owned(),
                "not-json".into()
            )
            .is_err()
        );
    }

    #[test]
    fn gateway_version_failure_is_actionable_and_non_destructive() {
        let message = gateway_version_failure(
            "1.0.2281",
            Some("2.0.0"),
            "Gateway major version 2 is incompatible with desktop major version 1.",
        );
        assert!(message.contains("Desktop version: 1.0.2281"));
        assert!(message.contains("Gateway version: 2.0.0"));
        assert!(message.contains("will not replace or stop an external gateway"));
        assert!(!message.contains("occupied by an incompatible service"));
    }

    #[test]
    fn recovered_gateway_preserves_the_active_route() {
        let current =
            tauri::Url::parse("http://127.0.0.1:4271/chat?session=active-session#activity")
                .expect("parse current URL");
        let recovered = gateway_url_for_location("http://127.0.0.1:4272", &current)
            .expect("build recovered URL");
        assert_eq!(
            recovered.as_str(),
            "http://127.0.0.1:4272/chat?session=active-session#activity"
        );
    }

    #[test]
    fn initial_asset_url_opens_the_gateway_root() {
        let current = tauri::Url::parse("tauri://localhost/index.html").expect("parse asset URL");
        let recovered =
            gateway_url_for_location("http://127.0.0.1:4269", &current).expect("build initial URL");
        assert_eq!(recovered.as_str(), "http://127.0.0.1:4269/");
    }
}
