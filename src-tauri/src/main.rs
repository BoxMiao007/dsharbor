// 发布构建时隐藏 Windows 控制台窗口：轻量壳不该带一个黑框。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsharbor_lib::run()
}
