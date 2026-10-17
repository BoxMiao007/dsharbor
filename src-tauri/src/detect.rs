//! 壳外 DSH 探测：点「启动 DSH」或壳刚打开时，目标端口上可能已经有 DSH Web 在听
//! （上次壳异常退出留下的残留进程，或用户自己在终端里起的）。不检测就重复拉起，
//! 只会拿到一个端口冲突的原始报错；检测到了就按「外部运行中」报送，不再启动第二个进程。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use dsharbor_core::launch::LaunchConfig;

use crate::profile;

/// DSH Web 的默认端口（profile 没写 webserver 块、壳也没覆盖时用它）。
pub const DSH_DEFAULT_PORT: u16 = 3080;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_millis(1000);
/// 指纹只看响应开头这么多字节（页面标题在 <head> 里，足够了）。
const MAX_SNIFF_BYTES: usize = 16 * 1024;

/// 纯逻辑：启动端口的优先级（壳覆盖 > profile 托管 > DSH 默认），单独拆出便于无 IO 测试。
fn resolved_port(override_port: Option<u16>, managed_port: Option<u16>) -> u16 {
    override_port.or(managed_port).unwrap_or(DSH_DEFAULT_PORT)
}

/// 本次启动真正会落到哪个端口：壳注入的覆盖端口 > profile 里写死的托管端口 > DSH 默认。
pub fn effective_port(config: &LaunchConfig) -> u16 {
    let managed = profile::port_hint(config).ok().and_then(|hint| hint.port);
    resolved_port(config.port, managed)
}

/// 目标端口现在有没有服务在听（127.0.0.1；WSL2 的 localhost 转发让发行版内的 DSH 也能探到）。
pub fn port_alive(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).is_ok()
}

/// 连上后问一句 GET /，从响应正文里找 DSH 的指纹（DSH 窗口与页面标题都是 DeepSeek Harness）。
/// Some(true) = 确认是 DSH；Some(false) = 确认不是；None = 没读出可辨认的内容。
pub fn dsh_fingerprint(port: u16) -> Option<bool> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    // HTTP/1.0 + Connection: close：读端就绪即断，不拖连接。
    let request = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
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
    // 大小写不敏感地找标题词。
    let lower = buf.to_ascii_lowercase();
    let find = |needle: &[u8]| lower.windows(needle.len()).any(|w| w == needle);
    Some(find(b"deepseek") || find(b"harness"))
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
    fn resolved_port_prefers_override_over_managed_over_default() {
        assert_eq!(resolved_port(Some(3099), Some(3080)), 3099);
        assert_eq!(resolved_port(None, Some(3080)), 3080);
        assert_eq!(resolved_port(None, None), DSH_DEFAULT_PORT);
    }

    #[test]
    fn port_alive_reports_listener_and_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        assert!(port_alive(port));
        drop(listener);
        // 关掉后不再存活（连接被立刻拒绝；不挑端口复用时机）。
        assert!(!port_alive(port));
    }

    #[test]
    fn dsh_fingerprint_matches_dsh_page() {
        let page: &'static [u8] =
            b"HTTP/1.0 200 OK\r\n\r\n<html><title>DeepSeek Harness</title></html>";
        let (port, _server) = spawn_stub(page);
        assert_eq!(dsh_fingerprint(port), Some(true));
    }

    #[test]
    fn dsh_fingerprint_rejects_other_page() {
        let page: &'static [u8] =
            b"HTTP/1.0 200 OK\r\n\r\n<html><title>Router Admin</title></html>";
        let (port, _server) = spawn_stub(page);
        assert_eq!(dsh_fingerprint(port), Some(false));
    }
}
