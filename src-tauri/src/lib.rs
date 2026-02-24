use tauri::{Manager, Emitter, menu::{MenuBuilder, MenuItemBuilder}};
use tauri_plugin_window_state;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use async_stream::stream;
use actix_web::{web, App, HttpServer, HttpResponse, Error};
use actix_cors::Cors;
use uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<Vec<Choice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<Message>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Choice {
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<Delta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<Message>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Delta {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Message {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamError {
    pub error: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaModel {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Clone)]
struct StreamContext {
    token: CancellationToken,
}

#[derive(Deserialize)]
struct ProxyChatRequest {
    api_endpoint: String,
    api_key: Option<String>,
    request: ChatRequest,
}

#[derive(Deserialize)]
struct ProxyModelsRequest {
    api_endpoint: String,
    api_key: Option<String>,
}

type TokenMap = Arc<Mutex<HashMap<String, StreamContext>>>;

pub struct ProxyState {
    pub server_handle: Mutex<Option<actix_web::dev::ServerHandle>>,
}

async fn handle_chat(req: web::Json<ProxyChatRequest>) -> Result<HttpResponse, Error> {
    match proxy_chat_request(req.api_endpoint.clone(), req.api_key.clone(), req.request.clone()).await {
        Ok(content) => Ok(HttpResponse::Ok().json(serde_json::json!({"content": content}))),
        Err(e) => Ok(HttpResponse::InternalServerError().json(serde_json::json!({"error": e}))),
    }
}

async fn handle_chat_stream(req: web::Json<ProxyChatRequest>) -> Result<HttpResponse, Error> {
    use futures::StreamExt;
    use bytes::Bytes;

    match proxy_chat_stream(req.api_endpoint.clone(), req.api_key.clone(), req.request.clone()).await {
        Ok(stream) => {
            let mapped_stream = stream.map(|res| {
                match res {
                    Ok(s) => Ok(Bytes::from(s)),
                    Err(e) => Err(actix_web::error::ErrorInternalServerError(e)),
                }
            });

            Ok(HttpResponse::Ok()
                .content_type("text/event-stream")
                .streaming(mapped_stream))
        }
        Err(e) => Ok(HttpResponse::InternalServerError().json(serde_json::json!({"error": e}))),
    }
}

async fn handle_models(req: web::Json<ProxyModelsRequest>) -> Result<HttpResponse, Error> {
    match proxy_scan_ollama_models(req.api_endpoint.clone(), req.api_key.clone()).await {
        Ok(models) => Ok(HttpResponse::Ok().json(serde_json::json!({"models": models}))),
        Err(e) => Ok(HttpResponse::InternalServerError().json(serde_json::json!({"error": e}))),
    }
}

fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

fn add_auth_headers(builder: reqwest::RequestBuilder, api_key: Option<String>) -> reqwest::RequestBuilder {
    if let Some(key) = api_key {
        builder.header("Authorization", format!("Bearer {}", key))
    } else {
        builder
    }
}

async fn proxy_chat_request(
    api_endpoint: String,
    api_key: Option<String>,
    request: ChatRequest,
) -> Result<String, String> {
    let client = build_http_client(300)?;

    let mut req_builder = client
        .post(&api_endpoint)
        .header("Content-Type", "application/json");

    req_builder = add_auth_headers(req_builder, api_key);

    let response = req_builder
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!("API error: {} - {}", status, error_text));
    }

    let response_data: ChatResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let content = if let Some(choices) = response_data.choices {
        choices
            .first()
            .and_then(|choice| choice.message.as_ref())
            .and_then(|m| m.content.as_ref())
            .cloned()
            .unwrap_or_default()
    } else if let Some(msg) = response_data.message {
        msg.content.unwrap_or_default()
    } else {
        String::new()
    };

    Ok(content)
}

async fn proxy_chat_stream(
    api_endpoint: String,
    api_key: Option<String>,
    request: ChatRequest,
) -> Result<impl futures::Stream<Item = Result<String, std::io::Error>>, String> {
    let client = build_http_client(300)?;

    let mut req_builder = client
        .post(&api_endpoint)
        .header("Content-Type", "application/json");

    req_builder = add_auth_headers(req_builder, api_key);

    let response = req_builder
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!("API error: {} - {}", status, error_text));
    }

    let s = stream! {
        let stream = response.bytes_stream();

        use futures::TryStreamExt;
        use tokio_util::io::StreamReader;
        use tokio::io::AsyncBufReadExt;

        let reader = StreamReader::new(stream.map_err(std::io::Error::other));

        let mut lines = tokio::io::BufReader::new(reader).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                yield Ok("\n".to_string());
                continue;
            }
            
            if line.trim().starts_with(':') {
                continue;
            }

            if line.trim() == "[DONE]" {
                yield Ok("data: [DONE]\n".to_string());
                yield Ok("\n".to_string());
                break;
            }

            #[cfg(debug_assertions)]
            eprintln!("Passing through SSE line: {}", line);
            yield Ok(format!("{}\n", line));
            yield Ok("\n".to_string());
        }
    };

    Ok(s)
}

#[tauri::command]
async fn send_chat_request(
    api_endpoint: String,
    api_key: Option<String>,
    request: ChatRequest,
) -> Result<String, String> {
    proxy_chat_request(api_endpoint, api_key, request).await
}

#[tauri::command]
async fn send_chat_stream(
    api_endpoint: String,
    api_key: Option<String>,
    request: ChatRequest,
    window: tauri::Window,
    stream_id: Option<String>,
) -> Result<String, String> {
    let stream_id = stream_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Store stream context for cancellation
    let token_map = window.state::<TokenMap>();
    let token = CancellationToken::new();

    {
        let mut map = token_map.lock().map_err(|e| format!("Lock error: {}", e))?;
        map.insert(stream_id.clone(), StreamContext {
            token: token.clone(),
        });
    }

    let stream = proxy_chat_stream(api_endpoint, api_key, request).await?;

    let mut stream_content = String::new();
    use futures::StreamExt;

    tokio::pin!(stream);

    while let Some(chunk_result) = stream.next().await {
        if token.is_cancelled() {
            break;
        }

        match chunk_result {
            Ok(chunk) => {
                stream_content.push_str(&chunk);

                // Emit chunk to frontend
                #[cfg(debug_assertions)]
                eprintln!("Emitting chunk: [{} bytes] '{}'", chunk.len(), chunk);
                let _ = window.emit(&format!("stream-{}", stream_id), chunk.clone());
            }
            Err(e) => {
                eprintln!("Stream error: {}", e);
                let _ = window.emit(&format!("stream-error-{}", stream_id), &e.to_string());
                break;
            }
        }
    }

    // Clean up
    {
        let mut map = token_map.lock().map_err(|e| format!("Lock error: {}", e))?;
        map.remove(&stream_id);
    }

    Ok(stream_id)
}

#[tauri::command]
async fn scan_ollama_models(
    api_endpoint: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    proxy_scan_ollama_models(api_endpoint, api_key).await
}

#[tauri::command]
async fn cancel_stream(
    stream_id: String,
    token_map: tauri::State<'_, TokenMap>,
) -> Result<bool, String> {
    let mut map = token_map.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(ctx) = map.get(&stream_id) {
        ctx.token.cancel();
        map.remove(&stream_id);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview_window) = app.get_webview_window("main") {
        webview_window.open_devtools();
        Ok(())
    } else {
        Err("Failed to get webview window".to_string())
    }
}

#[tauri::command]
async fn manage_proxy_server(
    enable: bool,
    port: Option<u16>,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    let target_port = port.unwrap_or(8080);

    // 1. Stop existing server if any
    let existing_handle = {
        let mut handle_lock = state.server_handle.lock().map_err(|e| e.to_string())?;
        handle_lock.take()
    };

    if let Some(h) = existing_handle {
        h.stop(true).await;
        println!("HTTP proxy server stopped");
    }

    // 2. Start new server if enabled
    if enable {
        let server = HttpServer::new(|| {
            App::new()
                .wrap(
                    Cors::default()
                        .allow_any_origin()
                        .allow_any_method()
                        .allow_any_header()
                        .supports_credentials()
                        .max_age(3600),
                )
                .route("/chat", web::post().to(handle_chat))
                .route("/chat/stream", web::post().to(handle_chat_stream))
                .route("/models", web::post().to(handle_models))
        })
        .bind(format!("127.0.0.1:{}", target_port))
        .map_err(|e| format!("Failed to bind HTTP server to port {}: {}", target_port, e))?
        .run();

        let handle = server.handle();
        tauri::async_runtime::spawn(async move {
            println!("HTTP proxy server running on http://127.0.0.1:{}", target_port);
            if let Err(e) = server.await {
                eprintln!("HTTP server error: {}", e);
            }
        });

        let mut handle_lock = state.server_handle.lock().map_err(|e| e.to_string())?;
        *handle_lock = Some(handle);
    }

    Ok(())
}

async fn proxy_scan_ollama_models(
    api_endpoint: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let url = url::Url::parse(&api_endpoint)
        .map_err(|e| format!("Invalid API endpoint URL: {}", e))?;

    let tags_url = format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().ok_or("Missing host")?,
        "/api/tags"
    );

    let client = build_http_client(30)?;

    let mut req_builder = client.get(&tags_url).header("Content-Type", "application/json");

    req_builder = add_auth_headers(req_builder, api_key);

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!("API error: {} - {}", status, error_text));
    }

    let data: OllamaTagsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let model_names: Vec<String> = data.models.into_iter().map(|m| m.name).collect();

    Ok(model_names)
}

#[tauri::command]
async fn show_native_menu(
    window: tauri::Window,
    has_selection: bool,
    can_copy: bool,
    can_cut: bool,
    has_clipboard: bool,
    is_in_chat: bool,
) -> Result<(), String> {

    let copy = MenuItemBuilder::with_id("copy", "复制")
        .accelerator("CmdOrCtrl+C")
        .enabled(has_selection && can_copy)
        .build(&window)
        .map_err(|e| e.to_string())?;

    let paste = MenuItemBuilder::with_id("paste", "粘贴")
        .accelerator("CmdOrCtrl+V")
        .enabled(has_clipboard && !is_in_chat)
        .build(&window)
        .map_err(|e| e.to_string())?;

    let cut = MenuItemBuilder::with_id("cut", "剪切")
        .accelerator("CmdOrCtrl+X")
        .enabled(can_cut && has_selection)
        .build(&window)
        .map_err(|e| e.to_string())?;

    let inspect = MenuItemBuilder::with_id("inspect", "检查")
        .build(&window)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(&window)
        .item(&copy)
        .item(&cut)
        .item(&paste)
        .separator()
        .item(&inspect)
        .build()
        .map_err(|e| e.to_string())?;

    window.popup_menu(&menu).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn run_code_as_file(
    content: String,
    extension: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let file_name = format!("neox-code-{}.{}", uuid::Uuid::new_v4(), extension);
    let file_path = temp_dir.join(file_name);

    std::fs::write(&file_path, content).map_err(|e| format!("Failed to write temp file: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/C", "start", "", &file_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token_map: TokenMap = Arc::new(Mutex::new(HashMap::new()));
    let proxy_state = ProxyState {
        server_handle: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_system_fonts::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all())
                .build(),
        )
        .manage(token_map)
        .manage(proxy_state)
        .invoke_handler(tauri::generate_handler![
            send_chat_request,
            send_chat_stream,
            cancel_stream,
            scan_ollama_models,
            open_devtools,
            manage_proxy_server,
            show_native_menu,
            run_code_as_file,
        ])
        .setup(|app| {
            app.on_menu_event(|app_handle, event| {
                let id = event.id().as_ref();
                let _ = app_handle.emit("menu-action", id);
            });
            if let Some(window) = app.get_webview_window("main") {
                let script = r#"
(function () {
  let isFullscreen = false;
  const updateFullscreenState = () => {
    if (window.__TAURI__) {
      window.__TAURI__.window.getCurrentWindow().isFullscreen().then(f => {
        isFullscreen = f;
        document.body.classList.toggle('fullscreen-mode', f);
      });
    }
  };
  updateFullscreenState();
  window.addEventListener('resize', updateFullscreenState);

  function handleKeyboardEvents(e) {
    const key = e.key;
    const isCtrlOrMeta = e.ctrlKey || e.metaKey;

    const isReload = key === 'F5' || (isCtrlOrMeta && (key === 'r' || key === 'R'));
    if (isReload) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return false;
    }

    if (key === 'F11') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (window.__TAURI__) {
        const win = window.__TAURI__.window.getCurrentWindow();
        win.isFullscreen().then(f => {
          win.setFullscreen(!f);
          isFullscreen = !f;
          document.body.classList.toggle('fullscreen-mode', !f);
        });
      }
      return false;
    }

    if (key === 'Escape' && isFullscreen) {
      e.preventDefault();
    }
    return true;
  }

  window.addEventListener('keydown', handleKeyboardEvents, { capture: true });
})();
"#;

                if let Err(err) = window.eval(script) {
                    eprintln!("failed to inject reload-block script: {}", err);
                }
                let _ = window.set_decorations(false);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
