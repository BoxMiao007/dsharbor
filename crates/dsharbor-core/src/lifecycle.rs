//! 轻量模式的壳状态机（纯逻辑，全自动测试）。
//!
//! 语义对齐用户需求：关闭主窗口 = 销毁它的 WebView（不是隐藏、不是最小化）释放界面内存、
//! DSH 后端常驻、托盘保留；DSH 界面窗口与主窗口相互独立——关其中一个不连带关另一个。
//! 托盘菜单：浏览器打开 / 当前程序打开 / 打开启动界面 / 重启 DSH / 完全退出；
//! 单击托盘图标打开哪个窗口由壳设置决定（启动界面或程序窗口）。
//!
//! 这里只做「状态 → 迁移 → 副作用清单」，不做任何真实 IO；
//! 外壳侧订阅 `handle()` 返回的 `ShellAction` 去执行，这样状态机的迁移和
//! 副作用序列（最容易出错的部分：托盘状态不同步、唤醒白屏、反复关开）可以
//! 用事件序列直接测出来。

/// 壳所处状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellState {
    /// 普通态：主窗口存在（可见或最小化）。
    Normal,
    /// 轻量态：主窗口已销毁，DSH 常驻，托盘保留。
    Light,
    /// 退出中：先停 DSH，再退壳；期间忽略其它事件。
    Exiting,
}

/// 驱动状态机的事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellEvent {
    /// 用户请求关闭主窗口（点 X / Alt+F4）。
    WindowCloseRequested,
    /// 托盘「显示窗口」。
    TrayShow,
    /// 托盘「重启 DSH」。
    TrayRestart,
    /// 托盘「完全退出」。
    TrayQuit,
}

/// 状态机给出的副作用，外壳按序执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellAction {
    /// 只销毁主窗口（启动界面）。DSH 界面窗口相互独立——用户关它才会关；
    /// DSH 后端与托盘始终保留。
    DestroyMainWindow,
    /// 重建主窗口（DSH 界面由用户点「打开 DSH 界面」再开）。
    CreateWindow,
    /// 把已存在的主窗口带到前台。
    FocusWindow,
    /// 停掉当前 DSH 再拉起新的（界面靠 1 秒轮询自然刷新状态与登录链接）。
    RestartDsh,
    /// 停掉 DSH 并退出应用。
    StopDshAndExit,
}

/// 壳状态机。
#[derive(Debug)]
pub struct ShellMachine {
    state: ShellState,
    window_open: bool,
}

impl Default for ShellMachine {
    fn default() -> Self {
        Self {
            state: ShellState::Normal,
            window_open: true,
        }
    }
}

impl ShellMachine {
    pub fn state(&self) -> ShellState {
        self.state
    }

    /// 主窗口当前是否存在（测试与托盘提示用）。
    pub fn window_open(&self) -> bool {
        self.window_open
    }

    /// 处理一遍事件，返回要执行的副作用（按序）。
    pub fn handle(&mut self, event: ShellEvent) -> Vec<ShellAction> {
        // 退出中：忽略其余一切事件，避免退出流程被打断（托盘状态不同步的根源）。
        if self.state == ShellState::Exiting {
            return Vec::new();
        }
        match event {
            ShellEvent::WindowCloseRequested => {
                if !self.window_open {
                    // 防御：无窗口时不应收到关闭事件；收到了也不该重复销毁。
                    return Vec::new();
                }
                self.window_open = false;
                self.state = ShellState::Light;
                vec![ShellAction::DestroyMainWindow]
            }
            ShellEvent::TrayShow => {
                if self.window_open {
                    vec![ShellAction::FocusWindow]
                } else {
                    self.window_open = true;
                    self.state = ShellState::Normal;
                    vec![ShellAction::CreateWindow]
                }
            }
            ShellEvent::TrayRestart => vec![ShellAction::RestartDsh],
            ShellEvent::TrayQuit => {
                self.state = ShellState::Exiting;
                vec![ShellAction::StopDshAndExit]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(machine: &mut ShellMachine, events: &[ShellEvent]) -> Vec<Vec<ShellAction>> {
        events.iter().map(|event| machine.handle(*event)).collect()
    }

    #[test]
    fn close_then_show_enters_light_and_comes_back() {
        let mut machine = ShellMachine::default();
        let actions = drive(
            &mut machine,
            &[ShellEvent::WindowCloseRequested, ShellEvent::TrayShow],
        );
        assert_eq!(
            actions,
            vec![
                vec![ShellAction::DestroyMainWindow],
                vec![ShellAction::CreateWindow]
            ]
        );
        assert_eq!(machine.state(), ShellState::Normal);
        assert!(machine.window_open());
    }

    #[test]
    fn five_close_open_rounds_stay_consistent() {
        // AC：连续「关→开」≥5 轮不白屏、托盘状态不错乱。
        let mut machine = ShellMachine::default();
        for round in 0..5 {
            assert_eq!(
                machine.state(),
                ShellState::Normal,
                "第 {round} 轮开始应为普通态"
            );
            let closed = machine.handle(ShellEvent::WindowCloseRequested);
            assert_eq!(closed, vec![ShellAction::DestroyMainWindow]);
            assert_eq!(machine.state(), ShellState::Light);
            assert!(!machine.window_open());
            let shown = machine.handle(ShellEvent::TrayShow);
            assert_eq!(shown, vec![ShellAction::CreateWindow]);
            assert_eq!(machine.state(), ShellState::Normal);
        }
    }

    #[test]
    fn duplicate_close_is_ignored() {
        let mut machine = ShellMachine::default();
        machine.handle(ShellEvent::WindowCloseRequested);
        assert_eq!(
            machine.handle(ShellEvent::WindowCloseRequested),
            Vec::new(),
            "轻量态下没有窗口可关，不应重复销毁"
        );
        assert_eq!(machine.state(), ShellState::Light);
    }

    #[test]
    fn show_while_visible_only_focuses() {
        let mut machine = ShellMachine::default();
        assert_eq!(
            machine.handle(ShellEvent::TrayShow),
            vec![ShellAction::FocusWindow]
        );
        assert_eq!(machine.state(), ShellState::Normal);
    }

    #[test]
    fn restart_keeps_state_in_both_modes() {
        let mut machine = ShellMachine::default();
        assert_eq!(
            machine.handle(ShellEvent::TrayRestart),
            vec![ShellAction::RestartDsh]
        );
        assert_eq!(machine.state(), ShellState::Normal);

        machine.handle(ShellEvent::WindowCloseRequested);
        assert_eq!(
            machine.handle(ShellEvent::TrayRestart),
            vec![ShellAction::RestartDsh],
            "轻量态也能重启 DSH"
        );
        assert_eq!(machine.state(), ShellState::Light);
        assert!(!machine.window_open());
    }

    #[test]
    fn quit_from_normal_and_light_both_stop_then_exit() {
        // 普通态退出
        let mut normal = ShellMachine::default();
        assert_eq!(
            normal.handle(ShellEvent::TrayQuit),
            vec![ShellAction::StopDshAndExit]
        );
        assert_eq!(normal.state(), ShellState::Exiting);

        // 轻量态退出
        let mut light = ShellMachine::default();
        light.handle(ShellEvent::WindowCloseRequested);
        assert_eq!(
            light.handle(ShellEvent::TrayQuit),
            vec![ShellAction::StopDshAndExit]
        );
        assert_eq!(light.state(), ShellState::Exiting);
    }

    #[test]
    fn events_are_ignored_while_exiting() {
        let mut machine = ShellMachine::default();
        machine.handle(ShellEvent::TrayQuit);
        let ignored = drive(
            &mut machine,
            &[
                ShellEvent::WindowCloseRequested,
                ShellEvent::TrayShow,
                ShellEvent::TrayRestart,
                ShellEvent::TrayQuit,
            ],
        );
        assert!(ignored.iter().all(|actions| actions.is_empty()));
        assert_eq!(machine.state(), ShellState::Exiting);
    }
}
