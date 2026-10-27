//! 原子写：把「先截断再写」换成「写同目录临时文件 + rename 覆盖」。
//!
//! 为什么值得单开一个模块：用户配置（`config.json`、环境里的 `package.json` /
//! `cordis.patch.yml`）都是「写了一半就等于毁掉」的文件——`std::fs::write` 先
//! truncate 再 write，壳被强杀、断电、磁盘满时中断在两步之间，留下空文件或半截
//! JSON；而 `settings::load` 读坏时只能回默认值，界面下一次自动保存就把默认值
//! 固化下去，用户设置等于静默归零。rename 在同一分区上是原子的（Windows 上走
//! MoveFileEx 的替换语义），读者要么看到旧内容、要么看到新内容，不存在中间态。
//!
//! 这里只提供两个原语：宿主侧的 `write_host`、以及「在 WSL 发行版里做同一件事」
//! 的命令串 `wsl_script`。临时文件叫什么、放在哪由调用方决定，本模块不碰业务路径。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 临时文件名里的进程内序号：同一进程里并发写同一个目标时也不会互相盖掉临时文件。
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// rename 的重试次数与间隔。
///
/// Windows 上目标文件被杀毒软件/索引服务短暂占用时 rename 会失败（错误 5/32），
/// 这类占用通常几十毫秒就消失；重试几次比让用户的配置写不进去划算。
const RENAME_ATTEMPTS: u32 = 3;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(50);

/// 与目标同目录的唯一临时文件名：`<原名>.<pid>-<序号>-<纳秒>.tmp`。
fn temp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|span| span.subsec_nanos())
        .unwrap_or(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    path.with_file_name(format!("{name}.{}-{seq}-{nanos}.tmp", std::process::id()))
}

/// 原子写宿主文件：内容先落到同目录临时文件，再 rename 盖住目标。
///
/// 失败时目标文件保持原样（最坏是临时文件没删干净），调用方拿到的错误里带两层
/// 路径，便于用户自己去看。
pub fn write_host(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = temp_path(path);
    if let Err(err) = std::fs::write(&tmp, content) {
        // 临时文件没写成（磁盘满、目录不可写）：清掉可能留下的半截临时文件，
        // 别在用户目录里留垃圾。
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败（{}）：{err}", tmp.display()));
    }
    let mut last_error = String::new();
    for _ in 0..RENAME_ATTEMPTS {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(err) => last_error = err.to_string(),
        }
        std::thread::sleep(RENAME_RETRY_DELAY);
    }
    // 重试用完还换不上：临时文件留着没用（还可能被当成真正的配置文件），删掉。
    let _ = std::fs::remove_file(&tmp);
    Err(format!(
        "替换 {} 失败（已重试 {RENAME_ATTEMPTS} 次）：{last_error}",
        path.display()
    ))
}

/// 在 WSL 发行版里做同一件事的命令串：先写 `<path>.tmp`，成功了再 `mv -f` 覆盖。
///
/// 用法是 `bash -lc <本串>` 并从 stdin 送内容：`cat` 读满 stdin 才会退，
/// 中途失败（管道断、磁盘满）时 `&&` 后面的 `mv` 不执行，目标文件保持原样。
/// 单引号就是路径的安全边界——调用方传来的路径只含 `[A-Za-z0-9._/-]`
/// （环境名过 `profiles::validate_name`），结构里不含引号。
pub fn wsl_script(path: &str) -> String {
    format!("cat > '{path}.tmp' && mv -f -- '{path}.tmp' '{path}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本进程专用的临时目录（与其它模块的测试同一套做法）。
    fn scratch(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dsharbor-atomic-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_host_creates_then_replaces_and_leaves_no_temp_file() {
        let root = scratch("write");
        let path = root.join("config.json");

        write_host(&path, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_host(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");

        // rename 之后目录里只剩目标文件：临时文件不能在用户目录里越攒越多。
        assert_eq!(names_in(&root), vec!["config.json".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_host_keeps_the_old_content_when_the_directory_is_missing() {
        // 目标目录不存在：临时文件写不进去，此时目标（也不存在）不会被创建，
        // 更不会出现「空的目标文件 + 报错」这种半截状态。
        let root = scratch("missing");
        let path = root.join("nope").join("config.json");
        assert!(write_host(&path, b"x").is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn temp_paths_are_unique_and_stay_next_to_the_target() {
        let root = scratch("tmp");
        let path = root.join("package.json");
        let first = temp_path(&path);
        let second = temp_path(&path);

        assert_ne!(first, second, "同一目标连着取两次不能拿到同一个临时文件名");
        assert_eq!(first.parent(), Some(root.as_path()));
        let name = first.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("package.json."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wsl_script_writes_a_temp_file_then_moves_it_into_place() {
        let path = "/home/u/.dsh/profiles/web/package.json";
        let script = wsl_script(path);
        assert_eq!(
            script,
            "cat > '/home/u/.dsh/profiles/web/package.json.tmp' && \
             mv -f -- '/home/u/.dsh/profiles/web/package.json.tmp' \
             '/home/u/.dsh/profiles/web/package.json'"
        );
    }
}
