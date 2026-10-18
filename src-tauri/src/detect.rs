//! 壳外 DSH 探测：点「启动 DSH」或壳刚打开时，目标端口上可能已经有 DSH Web 在听
//! （上次壳异常退出留下的残留进程，或用户自己在终端里起的）。不检测就重复拉起，
//! 只会拿到一个端口冲突的原始报错；检测到了就按「外部运行中」报送，不再启动第二个进程。
//!
//! 探测地址跟随 profile：DSH 的 webserver 可以绑在具体网卡 IP 上（局域网访问），
//! 那时回环根本连不进去——写死 127.0.0.1 就会把「已经在跑」误判成「端口空闲」，
//! 然后拉起第二个进程、DSH 自己报 EADDRINUSE（真实事故，DSH 0.2.1-rc.2 + host 192.168.1.7）。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use dsharbor_core::endpoint::{self, Endpoint};
use dsharbor_core::launch::{self, LaunchConfig};

use crate::plugin::Target;
use crate::profile;

/// DSH Web 的默认端口（profile 没写 webserver 块、壳也没覆盖时用它）。
pub const DSH_DEFAULT_PORT: u16 = 3080;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_millis(1000);
/// 指纹只看响应开头这么多字节。
const MAX_SNIFF_BYTES: usize = 16 * 1024;
/// DSH 未授权请求的固定文案（dsh-client-connection 的 writeUnauthorized）。
/// 真实 DSH 对未登录的 `GET /` 就回这一句，页面标题要登录后才拿得到。
const UNAUTHORIZED_MARK: &str = "dsh web authentication required";

/// 纯逻辑：启动端口的优先级（壳覆盖 > profile 托管 > 附加参数 --port > DSH 默认）。
///
/// 「壳覆盖」= 界面里填的自定义端口，它经 launcher 层 patch 注入、优先级最高。
/// 之后是 profile 里写死的 webserver 端口：**实测它压过 DSH 自己的 `--port`**
/// （真机：profile 写 3080 + `--port 3097` 启动，仍监听 3080），所以附加参数
/// 排在它后面。`--port` 只在 profile 没写端口时才生效。
fn resolved_port(
    override_port: Option<u16>,
    managed_port: Option<u16>,
    flag_port: Option<u16>,
) -> u16 {
    override_port
        .or(managed_port)
        .or(flag_port)
        .unwrap_or(DSH_DEFAULT_PORT)
}

/// 纯逻辑：启动地址上 host 的来源。
///
/// profile 里写死的 webserver host 压过 `--host` 旗标（真机实测：profile 写
/// 192.168.1.7 时 `--host 127.0.0.1` 不生效）。只有 profile 没写 host 时
/// 才轮到 `--host`——包括壳自定义端口的情况：这时覆盖层不带 host 行，
/// `--host` 依然有效。
fn resolved_host_source(managed_host: Option<String>, flag_host: Option<String>) -> Option<String> {
    managed_host.or(flag_host)
}

/// 本次启动真正会落到哪个地址：host 跟随 profile / 附加参数（WSL 固定回环），
/// 端口按上面的优先级。
pub fn effective_endpoint(config: &LaunchConfig) -> Endpoint {
    let hint = profile::port_hint(config).ok();
    let managed_port = hint.as_ref().and_then(|hint| hint.port);
    let managed_host = hint.and_then(|hint| hint.host);
    let flag_port = launch::extract_configured_port(&config.extra_args);
    let flag_host = launch::extract_configured_host(&config.extra_args);

    let port = resolved_port(config.port, managed_port, flag_port);
    let via_wsl = matches!(Target::of(config), Target::Wsl { .. });
    let host = endpoint::resolve_reachable_host(
        resolved_host_source(managed_host, flag_host).as_deref(),
        via_wsl,
    );
    Endpoint::new(host, port)
}

/// 目标地址现在有没有服务在听（跟随 profile 的 host；WSL2 的 localhost 转发让
/// 发行版的回环监听在 Windows 侧也能探到）。
pub fn port_alive(endpoint: &Endpoint) -> bool {
    connect(endpoint, CONNECT_TIMEOUT).is_ok()
}

/// 连上后问一句 `GET /`，判断对面是不是 DSH。
///
/// Some(true) = 确认是 DSH；Some(false) = 确认不是；None = 没读出可辨认的内容。
///
/// 判据取自 DSH 0.2.1-rc.2 的实际响应（实测）：未登录时首页返回 401 + 固定文案
/// `dsh web authentication required; reopen the URL printed by dsh web.`，
/// 正文里**没有** DeepSeek/Harness 字样（那是登录后的页面才有）。所以只看标题词
/// 会把任何真实 DSH 都判成「别的程序」。两者任一命中即认定 DSH。
pub fn dsh_fingerprint(endpoint: &Endpoint) -> Option<bool> {
    let mut stream = connect(endpoint, CONNECT_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    // HTTP/1.0 + Connection: close：读端就绪即断，不拖连接。
    let request = format!(
        "GET / HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n",
        endpoint.authority()
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= MAX_SNIFF_BYTES {
                    break;
                }
            }
            // 读超时等错误：拿到多少算多少（服务端不关连接时也能靠超时收尾）。
            Err(_) => break,
        }
    }
    if buf.is_empty() {
        return None;
    }
    Some(looks_like_dsh(&buf))
}

/// 响应字节里有没有 DSH 的特征（大小写不敏感）。
fn looks_like_dsh(raw: &[u8]) -> bool {
    let lower = raw.to_ascii_lowercase();
    let find = |needle: &[u8]| lower.windows(needle.len()).any(|w| w == needle);
    find(b"deepseek") || find(b"harness") || find(UNAUTHORIZED_MARK.as_bytes())
}

/// 连目标地址：IP 字面量走 `connect_timeout`（能设超时），主机名直接交给系统解析。
fn connect(endpoint: &Endpoint, timeout: Duration) -> std::io::Result<TcpStream> {
    match endpoint.host.parse::<std::net::IpAddr>() {
        Ok(ip) => TcpStream::connect_timeout(&SocketAddr::new(ip, endpoint.port), timeout),
        Err(_) => {
            let addr = format!("{}:{}", endpoint.host, endpoint.port);
            TcpStream::connect(addr.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// 起一个一次性 stub 服务，回发 `response` 后把收到的请求文本从通道交回。
    fn spawn_stub(response: &'static [u8]) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept stub");
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(response);
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (port, handle)
    }

    #[test]
    fn resolved_port_prefers_override_over_managed_over_flag_over_default() {
        assert_eq!(
            resolved_port(Some(3099), Some(3080), Some(3098)),
            3099,
            "界面端口最优先（经 launcher 层覆盖注入）"
        );
        assert_eq!(
            resolved_port(None, Some(3080), Some(3098)),
            3080,
            "profile 写死的 webserver 端口压过 --port（真机实测：profile 3080 + --port 3097 仍监听 3080）"
        );
        assert_eq!(
            resolved_port(None, None, Some(3098)),
            3098,
            "profile 没写端口时才轮到 --port"
        );
        assert_eq!(resolved_port(None, None, None), DSH_DEFAULT_PORT);
    }

    #[test]
    fn host_source_follows_what_actually_wins() {
        let managed = || Some("192.168.1.7".to_string());
        let flag = || Some("10.0.0.5".to_string());
        // profile 有 host：它压过 --host（真机实测 profile 192.168.1.7 时 --host 127.0.0.1 不生效）。
        assert_eq!(resolved_host_source(managed(), flag()), managed());
        // profile 没写 host：才轮到 --host。
        assert_eq!(resolved_host_source(None, flag()), flag());
        // 都没有：交给 resolve_host 兜回环。
        assert_eq!(resolved_host_source(None, None), None);
    }

    #[test]
    fn port_alive_reports_listener_and_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        assert!(port_alive(&Endpoint::loopback(port)));
        drop(listener);
        // 关掉后不再存活（连接被立刻拒绝；不挑端口复用时机）。
        assert!(!port_alive(&Endpoint::loopback(port)));
    }

    #[test]
    fn dsh_fingerprint_matches_dsh_page() {
        let page: &'static [u8] =
            b"HTTP/1.0 200 OK\r\n\r\n<html><title>DeepSeek Harness</title></html>";
        let (port, _server) = spawn_stub(page);
        assert_eq!(dsh_fingerprint(&Endpoint::loopback(port)), Some(true));
    }

    #[test]
    fn dsh_fingerprint_matches_unauthorized_dsh() {
        // 真实 DSH 0.2.1-rc.2 未登录的首页：401 + 固定文案，正文没有任何标题词。
        let page: &'static [u8] = b"HTTP/1.0 401 Unauthorized\r\nContent-Length: 68\r\n\r\ndsh web authentication required; reopen the URL printed by dsh web.\n";
        let (port, _server) = spawn_stub(page);
        assert_eq!(dsh_fingerprint(&Endpoint::loopback(port)), Some(true));
    }

    #[test]
    fn dsh_fingerprint_rejects_other_page() {
        let page: &'static [u8] =
            b"HTTP/1.0 200 OK\r\n\r\n<html><title>Router Admin</title></html>";
        let (port, _server) = spawn_stub(page);
        assert_eq!(dsh_fingerprint(&Endpoint::loopback(port)), Some(false));
    }

    #[test]
    fn request_host_header_follows_endpoint() {
        let page: &'static [u8] = b"HTTP/1.0 200 OK\r\n\r\nnothing";
        let (port, server) = spawn_stub(page);
        let _ = dsh_fingerprint(&Endpoint::loopback(port));
        let request = server.join().unwrap();
        assert!(request.starts_with(&format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}")));
    }
}
