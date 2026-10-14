//! 控制台输出解码。
//!
//! 子进程输出的编码各不相同，必须在读管道时统一探测，否则界面上会出现乱码：
//! - node / npx / bash（UTF-8；读块边界可能截断多字节字符，需要暂存尾巴）；
//! - cmd.exe 的内置错误（中文 Windows 上是 GBK/CP936）；
//! - wsl.exe 自身的提示（UTF-16LE，第一条之前带 BOM，后续行可能没有）。
//!
//! 用法：每条流建一个解码器，按到达顺序喂原始字节，拿到可见文本。

/// 按流探测并解码控制台输出。
pub struct ConsoleDecoder {
    encoding: Option<Encoding>,
    /// UTF-8 模式下暂存的不完整多字节尾巴；UTF-16 模式下暂存落单的半个码元。
    pending: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Utf16Le,
    Utf16Be,
    /// 首个数据块是合法 UTF-8（或只是尾部被截断）时选用。
    Utf8,
    /// 首个数据块不是合法 UTF-8 时按 GBK 处理（中文 Windows 的 cmd 错误信息）。
    Gbk,
}

impl Default for ConsoleDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl ConsoleDecoder {
    pub fn new() -> Self {
        Self {
            encoding: None,
            pending: Vec::new(),
        }
    }

    /// 喂入一块原始字节，返回本次能解码出的文本（不完整的字符会被暂存到下次）。
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        let encoding = *self.encoding.get_or_insert_with(|| sniff(bytes));

        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);

        let decoded = match encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let usable = buf.len() - buf.len() % 2;
                let u16s: Vec<u16> = buf[..usable]
                    .chunks_exact(2)
                    .map(|pair| {
                        if encoding == Encoding::Utf16Le {
                            u16::from_le_bytes([pair[0], pair[1]])
                        } else {
                            u16::from_be_bytes([pair[0], pair[1]])
                        }
                    })
                    .collect();
                self.pending = buf[usable..].to_vec();
                String::from_utf16_lossy(&u16s)
            }
            Encoding::Gbk => encoding_rs::GBK.decode(&buf).0.into_owned(),
            Encoding::Utf8 => {
                let mut out = String::new();
                let mut rest: &[u8] = &buf;
                loop {
                    match std::str::from_utf8(rest) {
                        Ok(text) => {
                            out.push_str(text);
                            break;
                        }
                        Err(err) => {
                            let valid = err.valid_up_to();
                            // SAFETY 语义上安全：valid_up_to 之前一定是合法 UTF-8。
                            out.push_str(
                                std::str::from_utf8(&rest[..valid]).expect("valid utf8 prefix"),
                            );
                            match err.error_len() {
                                // 真正的非法字节：替换并继续。
                                Some(bad_len) => {
                                    out.push('\u{FFFD}');
                                    rest = &rest[valid + bad_len..];
                                }
                                // 只是尾部被截断：留到下次。
                                None => {
                                    self.pending = rest[valid..].to_vec();
                                    break;
                                }
                            }
                        }
                    }
                }
                out
            }
        };

        // 统一的 BOM 清理：UTF-16 流第二、三块里不会再出现 BOM，
        // 这里只处理开头多出来的 U+FEFF。
        decoded
            .strip_prefix('\u{FEFF}')
            .map(str::to_string)
            .unwrap_or(decoded)
    }
}

fn sniff(bytes: &[u8]) -> Encoding {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Encoding::Utf16Le;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Encoding::Utf16Be;
    }
    // 无 BOM 的 UTF-16LE（纯 ASCII 内容的常见形状）：低字节在前、高字节全 0。
    if bytes.len() >= 4
        && bytes[0] != 0
        && bytes[1] == 0
        && bytes.iter().skip(1).step_by(2).all(|b| *b == 0)
    {
        return Encoding::Utf16Le;
    }
    match std::str::from_utf8(bytes) {
        // 合法，或尾部只是多字节字符被截断（首个读块可能短到只有一个前导字节）
        // → 都按 UTF-8 流处理；GBK 文本几乎不会恰好以"不完整 UTF-8 前缀"开头。
        Ok(_) => Encoding::Utf8,
        Err(err) if err.error_len().is_none() => Encoding::Utf8,
        Err(_) => Encoding::Gbk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_text_passes_through() {
        let mut d = ConsoleDecoder::new();
        assert_eq!(
            d.feed("dsh web: http://127.0.0.1:3080/?token=abc\n".as_bytes()),
            "dsh web: http://127.0.0.1:3080/?token=abc\n"
        );
    }

    #[test]
    fn utf8_multibyte_split_across_chunks_is_rejoined() {
        let text = "中文输出正常";
        let bytes = text.as_bytes();
        // 在"中"的第 2、3 字节之间切一刀，模拟读管道截断。
        let mut d = ConsoleDecoder::new();
        let first = d.feed(&bytes[..1]);
        let second = d.feed(&bytes[1..]);
        assert_eq!(format!("{first}{second}"), text);
        assert!(!first.contains('\u{FFFD}'));
    }

    #[test]
    fn utf16le_with_bom_decodes() {
        let mut raw = vec![0xFF, 0xFE];
        for unit in "没有与所提供名称匹配的分发版本".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        let mut d = ConsoleDecoder::new();
        assert_eq!(d.feed(&raw), "没有与所提供名称匹配的分发版本");
    }

    #[test]
    fn utf16le_without_bom_ascii_decodes() {
        let mut raw = Vec::new();
        for unit in "The system cannot find the path".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        let mut d = ConsoleDecoder::new();
        assert_eq!(d.feed(&raw), "The system cannot find the path");
    }

    #[test]
    fn utf16le_split_across_chunks_is_rejoined() {
        let mut raw = vec![0xFF, 0xFE];
        for unit in "恢复".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        let (a, b) = raw.split_at(5); // 落在第二个字的中间
        let mut d = ConsoleDecoder::new();
        assert_eq!(format!("{}{}", d.feed(a), d.feed(b)), "恢复");
    }

    #[test]
    fn gbk_error_message_decodes_to_chinese() {
        // 用 encoding_rs 自己编码出 GBK 字节，验证解码链路（含探测）。
        let (raw, _, _) = encoding_rs::GBK.encode("拒绝访问。");
        let mut d = ConsoleDecoder::new();
        assert_eq!(d.feed(&raw), "拒绝访问。");
    }

    #[test]
    fn plain_ascii_is_utf8() {
        let mut d = ConsoleDecoder::new();
        assert_eq!(d.feed(b"ok"), "ok");
    }
}
