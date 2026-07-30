// Release builds attach to no console: the shell is tray-only and must never
// flash a terminal on login. Debug builds keep the console for spike logging.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    photo_pigeon_tray_lib::run();
}
