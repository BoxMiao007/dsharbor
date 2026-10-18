//! 桥接通道客户端：向 DSH 进程内的 dsharbor-bridge 插件取带 token 的登录链接。
//!
//! 为什么手写 HTTP 客户端：只需要一个本机 GET，值不得为此引入 reqwest/ureq
//! 的传输栈与 TLS 依赖；手写版还能用本地 stub 服务器直接做自动化测试
//!（验收条款「取回 / 超时 / 重试 / 降级分支测试」）。
//!
//! 协议（插件侧见 plugins/dsharbor-bridge/lib/index.js）：
//! `GET /dsharbor-bridge/url?nonce=<nonce>` →
//!   200 `{"url":"http://<host>:<port>/?token=…","port":…,"channel":"bridge"}`
//!   403 nonce 不匹配 / 503 插件未启用（无 nonce 启动）或服务未就绪 / 405 非 GET
//!
//! 连接目标与返回 URL 的校验都用 `Endpoint`：DSH 可以把 webserver 绑在具体网卡
//! IP 上（局域网能访问界面），那时回环根本连不进去，写死 127.0.0.1 只会一直
//! 取不到链接（实测 DSH 0.2.1-rc.2 + 用户 profile 绑 192.168.1.7 就降级成了日志兜底）。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::endpoint::Endpoint;

/// 桥接插件注册的接口路径。
pub const ROUTE_PATH: &str = "/dsharbor-bridge/url";
/// 壳向 DSH 进程注入 nonce 的环境变量名（插件 patch 从 process.env 读取）。
pub const NONCE_ENV: &str = "DSHARBOR_BRIDGE_NONCE";

/// 生成 128-bit hex nonce。每次启动 DSH 现生成、经环境变量注入、不落盘；
/// 用途见 plugins/dsharbor-bridge 的注释（防止本接口被局域网直接调用）。
pub fn generate_nonce() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|err| format!("生成 nonce 失败：{err}"))?;
    Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 桥接取链接失败的原因（带可读描述，供界面与日志使用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// 端口还没监听（DSH 还没起来）——可重试。
    NotListening(String),
    /// 插件未启用（503：DSH 进程没带 nonce 启动）——终态，直接走日志兜底。
    Disabled(String),
    /// nonce 不匹配（403，可能有旧 DSH 进程占着端口）——不可重试。
    Forbidden,
    /// 其它 HTTP 状态码——不可重试。
    HttpStatus(u16),
    /// IO / 协议 / JSON 错误——可重试（多为启动早期的瞬时状况）。
    Io(String),
}

impl BridgeError {
    pub fn retriable(&self) -> bool {
        matches!(self, BridgeError::NotListening(_) | BridgeError::Io(_))
    }

    pub fn message(&self) -> String {
        match self {
            BridgeError::NotListening(detail) => {
                format!("DSH 的本地端口尚未就绪（{detail}）")
            }
            BridgeError::Disabled(detail) => format!("桥接插件未启用（{detail}）"),
            BridgeError::Forbidden => {
                "桥接接口返回 403：nonce 不匹配，可能有旧 DSH 进程占着端口".into()
            }
            BridgeError::HttpStatus(code) => format!("桥接接口返回意外状态码 {code}"),
            BridgeError::Io(detail) => format!("桥接通信失败：{detail}"),
        }
    }
}

/// 桥接客户端（一目标一实例；nonce 由壳持有）。
pub struct BridgeClient {
    endpoint: Endpoint,
    nonce: String,
    timeout: Duration,
}

impl BridgeClient {
    pub fn new(endpoint: Endpoint, nonce: String) -> Self {
        Self {
            endpoint,
            nonce,
            timeout: Duration::from_millis(800),
        }
    }

    /// 取一次登录链接。
    pub fn fetch(&self) -> Result<String, BridgeError> {
        let authority = self.endpoint.authority();
        let mut stream = connect(&self.endpoint, self.timeout)
            .map_err(|err| BridgeError::NotListening(format!("连接 {authority} 失败：{err}")))?;
        let _ = stream.set_read_timeout(Some(self.timeout));
        let _ = stream.set_write_timeout(Some(self.timeout));

        let request = format!(
            "GET {ROUTE_PATH}?nonce={} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n",
            self.nonce
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|err| BridgeError::Io(format!("发送请求失败：{err}")))?;
        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .map_err(|err| BridgeError::Io(format!("读取响应失败：{err}")))?;

        let (status, body) = parse_http_response(&raw)?;
        match status {
            200 => parse_url_json(&body, &self.endpoint),
            403 => Err(BridgeError::Forbidden),
            503 => {
                let detail = String::from_utf8_lossy(&body).trim().to_string();
                // 插件两种 503 必须区别对待：
                // - 「disabled … NONCE is not set」= 这个 DSH 进程没带 nonce，永远不会好，终态；
                // - 「bridge not ready …」= connection 服务晚于路由注册就绪，启动早期很常见，
                //   必须可重试。实测 DSH 0.2.1-rc.2 上第一次请求就会撞上它，若当终态就
                //   一次早到把桥接永久降级成日志兜底（用户名下的真实日志里就是这样）。
                if detail.contains("not ready") {
                    Err(BridgeError::NotListening(detail))
                } else {
                    Err(BridgeError::Disabled(detail))
                }
            }
            other => Err(BridgeError::HttpStatus(other)),
        }
    }
}

/// 连目标地址：IP 字面量走 `connect_timeout`（能设超时），主机名先解析再连。
fn connect(endpoint: &Endpoint, timeout: Duration) -> std::io::Result<TcpStream> {
    match endpoint.host.parse::<std::net::IpAddr>() {
        Ok(ip) => TcpStream::connect_timeout(&SocketAddr::new(ip, endpoint.port), timeout),
        Err(_) => {
            let addr = format!("{}:{}", endpoint.host, endpoint.port);
            TcpStream::connect(addr.as_str())
        }
    }
}

/// 带重试的取链接：重试策略与「取一次 / 等待」都可注入，便于自动化测试。
/// 只有 `retriable()` 的错误才重试；终态错误立即返回。
pub fn fetch_with_retry<F, S>(
    mut fetch: F,
    mut sleep: S,
    attempts: u32,
    interval: Duration,
) -> Result<String, BridgeError>
where
    F: FnMut() -> Result<String, BridgeError>,
    S: FnMut(Duration),
{
    let mut last: Option<BridgeError> = None;
    for index in 0..attempts.max(1) {
        match fetch() {
            Ok(url) => return Ok(url),
            Err(err) => {
                let more = index + 1 < attempts;
                if !err.retriable() || !more {
                    return Err(err);
                }
                last = Some(err);
                sleep(interval);
            }
        }
    }
    Err(last.unwrap_or_else(|| BridgeError::Io("未发起任何请求".into())))
}

/// 解析 HTTP 响应：状态码 + 响应体（支持 Content-Length 与 chunked）。
fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), BridgeError> {
    let header_end = find_subslice(raw, b"\r\n\r\n")
        .ok_or_else(|| BridgeError::Io("响应里找不到空行分隔的头部".into()))?;
    let header_text = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| BridgeError::Io(format!("无法解析状态行：{status_line:?}")))?;

    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("transfer-encoding:") {
            if value.contains("chunked") {
                chunked = true;
            }
        } else if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().ok();
        }
    }

    let body = &raw[header_end + 4..];
    let body = if chunked {
        dechunk(body)?
    } else if let Some(length) = content_length {
        body[..length.min(body.len())].to_vec()
    } else {
        body.to_vec()
    };
    Ok((status, body))
}

/// 解码 chunked 传输编码。
fn dechunk(body: &[u8]) -> Result<Vec<u8>, BridgeError> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = find_subslice(rest, b"\r\n")
            .ok_or_else(|| BridgeError::Io("chunk 头缺少换行".into()))?;
        let size_text = String::from_utf8_lossy(&rest[..line_end]);
        let size_text = size_text.split(';').next().unwrap_or("").trim().to_string();
        let size = usize::from_str_radix(&size_text, 16)
            .map_err(|_| BridgeError::Io(format!("chunk 大小非法：{size_text:?}")))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return Err(BridgeError::Io("chunk 数据不完整".into()));
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    Ok(out)
}

/// 从 200 响应体里取 url 字段，并把主机改写成「壳刚连上的那个端点」，端口保持
/// 响应里报的值。
///
/// 为什么要改写主机：插件可能跑在 WSL 里、或按 bind 地址给出 `http://0.0.0.0:3080/`
/// 这类不可达写法；壳知道真正连得通的地址（Endpoint）。端口不能改成壳算出来的值：
/// DSH 可能没按请求的端口起（端口被占时自己换、或 profile 里另有配置），
/// 响应里的端口才是它实际在听的那个。
fn parse_url_json(body: &[u8], endpoint: &Endpoint) -> Result<String, BridgeError> {
    let text = String::from_utf8_lossy(body);
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| BridgeError::Io(format!("响应不是合法 JSON：{err}")))?;
    let raw = value
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if raw.is_empty() {
        return Err(BridgeError::Io("响应 JSON 缺少 url 字段".into()));
    }
    let mut url = url::Url::parse(raw)
        .map_err(|err| BridgeError::Io(format!("响应里的 url 无法解析（{raw}）：{err}")))?;
    if url.scheme() != "http" {
        return Err(BridgeError::Io(format!(
            "响应里的 url 不是 http 地址：{url}"
        )));
    }
    url.set_host(Some(&host_with_brackets(&endpoint.host)))
        .map_err(|_| BridgeError::Io(format!("无法把 url 的主机改成 {}：{url}", endpoint.host)))?;
    if url.port().is_none() {
        url.set_port(Some(endpoint.port)).map_err(|_| {
            BridgeError::Io(format!("无法把 url 的端口改成 {}：{url}", endpoint.port))
        })?;
    }
    Ok(url.to_string())
}

/// `Url::set_host` 对 IPv6 要求带方括号。
fn host_with_brackets(host: &str) -> String {
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(addr)) => format!("[{addr}]"),
        _ => host.to_string(),
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// 起一个一次性 stub 服务器：返回固定字节，并把收到的请求文本发回测试。
    fn spawn_stub(response: Vec<u8>) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定占位端口失败");
        let port = listener.local_addr().expect("读取端口失败").port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let count = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..count]).to_string());
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (port, rx)
    }

    fn http_response(status_line: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut raw = format!("{status_line}\r\n{headers}\r\n\r\n").into_bytes();
        raw.extend_from_slice(body);
        raw
    }

    #[test]
    fn fetches_url_from_stub() {
        let body = br#"{"url":"http://127.0.0.1:3080/?token=STUB","port":3080,"channel":"bridge"}"#;
        let headers = format!(
            "Content-Length: {}\r\nContent-Type: application/json",
            body.len()
        );
        let response = http_response("HTTP/1.1 200 OK", &headers, body);
        let (port, requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "feedface".into());
        let url = client.fetch().expect("应取回 URL");
        // 主机归一成本次连接的端点，端口与 token 保留响应里的值。
        assert_eq!(url, "http://127.0.0.1:3080/?token=STUB");
        let request = requests.recv().expect("应收到请求");
        assert!(request.starts_with("GET /dsharbor-bridge/url?nonce=feedface HTTP/1.1"));
    }

    #[test]
    fn handles_chunked_response() {
        // 在 JSON 中间切一刀，分两块传输，验证 chunked 解码。
        let full = r#"{"url":"http://127.0.0.1:3090/?token=CHUNKED"}"#;
        let (first, second) = full.split_at(6);
        let body = format!(
            "{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            first.len(),
            first,
            second.len(),
            second
        );
        let response = http_response(
            "HTTP/1.1 200 OK",
            "Transfer-Encoding: chunked",
            body.as_bytes(),
        );
        let (port, _requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        assert_eq!(
            client.fetch().expect("chunked 也应取回"),
            "http://127.0.0.1:3090/?token=CHUNKED"
        );
    }

    #[test]
    fn forbidden_nonce_is_terminal() {
        let response = http_response("HTTP/1.1 403 Forbidden", "Content-Length: 0", b"");
        let (port, _requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        let err = client.fetch().unwrap_err();
        assert_eq!(err, BridgeError::Forbidden);
        assert!(!err.retriable());
    }

    #[test]
    fn disabled_returns_readable_reason() {
        let body = br#"{"error":"bridge disabled: DSHARBOR_BRIDGE_NONCE is not set for this DSH process"}"#;
        let headers = format!("Content-Length: {}", body.len());
        let response = http_response("HTTP/1.1 503 Service Unavailable", &headers, body);
        let (port, _requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        let err = client.fetch().unwrap_err();
        assert!(matches!(err, BridgeError::Disabled(_)));
        assert!(!err.retriable());
        assert!(err.message().contains("未启用"));
    }

    #[test]
    fn not_ready_503_is_retriable() {
        // 实测 DSH 0.2.1-rc.2：路由先就绪、connection 服务后到，第一次请求就会
        // 拿到这个 503。当终态处理会让桥接一次早到就永久降级。
        let body = br#"{"error":"bridge not ready: web server or connection service unavailable"}"#;
        let headers = format!("Content-Length: {}", body.len());
        let response = http_response("HTTP/1.1 503 Service Unavailable", &headers, body);
        let (port, _requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        let err = client.fetch().unwrap_err();
        assert!(matches!(err, BridgeError::NotListening(_)));
        assert!(err.retriable());
    }

    #[test]
    fn rewrites_url_host_to_the_endpoint_we_connected_to() {
        // 插件在 WSL 里、或按 bind 地址给出 0.0.0.0 时，链接主机必须换成本次真正
        // 连得上的端点；路径与 token 原样保留（否则登录态会丢）。
        let body = br#"{"url":"http://0.0.0.0:3099/?token=KEEP","port":3099}"#;
        // 主机换成实际连通的 LAN 地址，端口用响应里报的 3099。
        let url = parse_url_json(body, &Endpoint::new("192.168.1.7", 3099)).unwrap();
        assert_eq!(url, "http://192.168.1.7:3099/?token=KEEP");
    }

    #[test]
    fn rewrite_keeps_ipv6_brackets() {
        let body = br#"{"url":"http://127.0.0.1:3099/?token=X"}"#;
        let url = parse_url_json(body, &Endpoint::new("::1", 3080)).unwrap();
        assert_eq!(url, "http://[::1]:3099/?token=X");
    }

    #[test]
    fn rejects_non_http_url() {
        let body = br#"{"url":"https://evil.example/?token=X"}"#;
        let headers = format!("Content-Length: {}", body.len());
        let response = http_response("HTTP/1.1 200 OK", &headers, body);
        let (port, _requests) = spawn_stub(response);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        let err = client.fetch().unwrap_err();
        assert!(matches!(err, BridgeError::Io(_)));
        assert!(err.message().contains("http"));
    }

    #[test]
    fn connection_refused_is_retriable() {
        // 找一个没人监听的端口：先绑定再释放。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = BridgeClient::new(Endpoint::loopback(port), "aa".into());
        let err = client.fetch().unwrap_err();
        assert!(matches!(err, BridgeError::NotListening(_)));
        assert!(err.retriable());
    }

    #[test]
    fn retry_succeeds_after_transient_failures() {
        let attempts = std::cell::Cell::new(0);
        let mut slept = Vec::new();
        let result = fetch_with_retry(
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    Err(BridgeError::NotListening("还没起来".into()))
                } else {
                    Ok("http://127.0.0.1:3080/?token=OK".into())
                }
            },
            |duration| slept.push(duration),
            5,
            Duration::from_millis(10),
        );
        assert_eq!(result.unwrap(), "http://127.0.0.1:3080/?token=OK");
        assert_eq!(attempts.get(), 3);
        assert_eq!(slept.len(), 2);
    }

    #[test]
    fn retry_stops_immediately_on_terminal_error() {
        let attempts = std::cell::Cell::new(0);
        let result = fetch_with_retry(
            || {
                attempts.set(attempts.get() + 1);
                Err(BridgeError::Disabled("没 nonce".into()))
            },
            |_| {},
            5,
            Duration::from_millis(10),
        );
        assert!(matches!(result, Err(BridgeError::Disabled(_))));
        assert_eq!(attempts.get(), 1, "终态错误不应重试");
    }

    #[test]
    fn retry_gives_up_after_attempts() {
        let attempts = std::cell::Cell::new(0);
        let mut slept = 0;
        let result = fetch_with_retry(
            || {
                attempts.set(attempts.get() + 1);
                Err(BridgeError::NotListening("还没起来".into()))
            },
            |_| slept += 1,
            3,
            Duration::from_millis(10),
        );
        assert!(matches!(result, Err(BridgeError::NotListening(_))));
        assert_eq!(attempts.get(), 3);
        assert_eq!(slept, 2, "最后一次失败后不再等待");
    }

    #[test]
    fn nonce_is_random_hex() {
        let first = generate_nonce().expect("应能生成");
        let second = generate_nonce().expect("应能生成");
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second, "每次生成的 nonce 不应相同");
    }
}
