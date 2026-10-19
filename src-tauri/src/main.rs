// 发布版不附带控制台窗口（debug 保留，便于查看 panic 与日志）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    huawei_music_desktop_lib::run()
}
