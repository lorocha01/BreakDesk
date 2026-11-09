//! Remote input injection. Runs on its own OS thread so slow system calls never stall the
//! async runtime, and so platform handles (X11 connection, etc.) stay on one thread.
//!
//! Windows: native `SendInput` with physical scancodes and virtual-desktop absolute mouse
//! coordinates (multi-monitor aware). Other platforms: `enigo` (X11 keycodes via `raw`).

use std::collections::HashSet;
use std::sync::mpsc;

use crate::keymap::{self, KeyEntry};
use crate::protocol::MonitorInfo;

#[derive(Debug, Clone)]
pub enum InputCmd {
    /// Normalized (0..1) position on `monitor`.
    MouseMove {
        x: f64,
        y: f64,
        monitor: MonitorInfo,
    },
    Button {
        b: u8,
        down: bool,
    },
    Wheel {
        dx: f64,
        dy: f64,
    },
    Key {
        code: String,
        key: String,
        down: bool,
    },
    Combo(Vec<String>),
    Text(String),
    /// Releases every key/button the remote side is still holding.
    ReleaseAll,
}

/// Converts a normalized position to absolute physical desktop coordinates.
pub fn to_desktop(x: f64, y: f64, m: &MonitorInfo) -> (i32, i32) {
    let nx = if x.is_finite() {
        x.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let ny = if y.is_finite() {
        y.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let px = m.x + (nx * (m.width.saturating_sub(1)) as f64).round() as i32;
    let py = m.y + (ny * (m.height.saturating_sub(1)) as f64).round() as i32;
    (px, py)
}

trait Backend {
    fn move_abs(&mut self, x: i32, y: i32);
    fn button(&mut self, b: u8, down: bool);
    /// Wheel in "notches" ×120 (Windows WHEEL_DELTA units); positive dy scrolls down.
    fn wheel(&mut self, dx120: i32, dy120: i32);
    fn key(&mut self, k: &KeyEntry, down: bool);
    fn unicode(&mut self, ch: char, down: bool);
    fn text(&mut self, s: &str);
}

#[derive(Clone)]
pub struct InputHandle {
    tx: mpsc::Sender<InputCmd>,
}

impl InputHandle {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<InputCmd>();
        std::thread::Builder::new()
            .name("nexo-input".into())
            .spawn(move || run(rx))
            .expect("spawn input thread");
        Self { tx }
    }

    pub fn send(&self, cmd: InputCmd) {
        let _ = self.tx.send(cmd);
    }
}

fn run(rx: mpsc::Receiver<InputCmd>) {
    let mut backend: Option<Box<dyn Backend>> = None;
    let mut held_keys: Vec<String> = vec![];
    let mut held_buttons: HashSet<u8> = HashSet::new();
    // DOM wheel deltas are ~100 px per notch; convert to 120-unit notches with remainder carry.
    let (mut acc_x, mut acc_y) = (0.0f64, 0.0f64);

    while let Ok(cmd) = rx.recv() {
        if backend.is_none() {
            match make_backend() {
                Ok(b) => backend = Some(b),
                Err(e) => {
                    tracing::error!("input backend unavailable: {e}");
                    continue;
                }
            }
        }
        let be = backend.as_mut().unwrap();
        match cmd {
            InputCmd::MouseMove { x, y, monitor } => {
                let (px, py) = to_desktop(x, y, &monitor);
                be.move_abs(px, py);
            }
            InputCmd::Button { b, down } => {
                if b > 2 {
                    continue;
                }
                if down {
                    held_buttons.insert(b);
                } else {
                    held_buttons.remove(&b);
                }
                be.button(b, down);
            }
            InputCmd::Wheel { dx, dy } => {
                if !dx.is_finite() || !dy.is_finite() {
                    continue;
                }
                acc_x += dx.clamp(-5000.0, 5000.0) * 1.2;
                acc_y += dy.clamp(-5000.0, 5000.0) * 1.2;
                let (sx, sy) = (acc_x.trunc() as i32, acc_y.trunc() as i32);
                // Non-Windows backends scroll in whole notches.
                let (sx, sy) = if cfg!(windows) {
                    (sx, sy)
                } else {
                    ((sx / 120) * 120, (sy / 120) * 120)
                };
                acc_x -= sx as f64;
                acc_y -= sy as f64;
                if sx != 0 || sy != 0 {
                    be.wheel(sx, sy);
                }
            }
            InputCmd::Key { code, key, down } => {
                if let Some(k) = keymap::lookup(&code) {
                    if down {
                        if !held_keys.contains(&code) {
                            held_keys.push(code.clone());
                        }
                    } else {
                        held_keys.retain(|c| c != &code);
                    }
                    be.key(k, down);
                } else if let Some(ch) = single_char(&key) {
                    be.unicode(ch, down);
                }
            }
            InputCmd::Combo(codes) => {
                let entries: Vec<&KeyEntry> = codes
                    .iter()
                    .take(6)
                    .filter_map(|c| keymap::lookup(c))
                    .collect();
                for k in &entries {
                    be.key(k, true);
                }
                for k in entries.iter().rev() {
                    be.key(k, false);
                }
            }
            InputCmd::Text(t) => {
                let t: String = t.chars().take(10_000).collect();
                be.text(&t);
            }
            InputCmd::ReleaseAll => {
                for code in held_keys.drain(..).rev() {
                    if let Some(k) = keymap::lookup(&code) {
                        be.key(k, false);
                    }
                }
                for b in held_buttons.drain() {
                    be.button(b, false);
                }
                acc_x = 0.0;
                acc_y = 0.0;
            }
        }
    }
}

fn single_char(key: &str) -> Option<char> {
    let mut it = key.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

#[cfg(windows)]
fn make_backend() -> anyhow::Result<Box<dyn Backend>> {
    Ok(Box::new(win::WinBackend))
}

#[cfg(not(windows))]
fn make_backend() -> anyhow::Result<Box<dyn Backend>> {
    Ok(Box::new(other::EnigoBackend::new()?))
}

#[cfg(windows)]
mod win {
    use super::Backend;
    use crate::keymap::KeyEntry;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    pub struct WinBackend;

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn kbd(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    impl Backend for WinBackend {
        fn move_abs(&mut self, x: i32, y: i32) {
            let (vx, vy, vw, vh) = unsafe {
                (
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
                )
            };
            let nx = (((x - vx) as i64 * 65535) / (vw as i64 - 1)) as i32;
            let ny = (((y - vy) as i64 * 65535) / (vh as i64 - 1)) as i32;
            send(&[mouse(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                nx,
                ny,
                0,
            )]);
        }

        fn button(&mut self, b: u8, down: bool) {
            let f = match (b, down) {
                (0, true) => MOUSEEVENTF_LEFTDOWN,
                (0, false) => MOUSEEVENTF_LEFTUP,
                (1, true) => MOUSEEVENTF_MIDDLEDOWN,
                (1, false) => MOUSEEVENTF_MIDDLEUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                _ => MOUSEEVENTF_RIGHTUP,
            };
            send(&[mouse(f, 0, 0, 0)]);
        }

        fn wheel(&mut self, dx120: i32, dy120: i32) {
            if dy120 != 0 {
                send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, -dy120)]);
            }
            if dx120 != 0 {
                send(&[mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx120)]);
            }
        }

        fn key(&mut self, k: &KeyEntry, down: bool) {
            let mut flags = KEYEVENTF_SCANCODE;
            if k.win_scan & 0xFF00 == 0xE000 {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            if !down {
                flags |= KEYEVENTF_KEYUP;
            }
            // Pause has no usable scancode form; use its virtual key.
            if k.code == "Pause" {
                let f = if down {
                    KEYBD_EVENT_FLAGS(0)
                } else {
                    KEYEVENTF_KEYUP
                };
                send(&[kbd(VK_PAUSE.0, 0, f)]);
                return;
            }
            send(&[kbd(0, k.win_scan & 0xFF, flags)]);
        }

        fn unicode(&mut self, ch: char, down: bool) {
            let mut buf = [0u16; 2];
            let flags = if down {
                KEYEVENTF_UNICODE
            } else {
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            };
            let inputs: Vec<INPUT> = ch
                .encode_utf16(&mut buf)
                .iter()
                .map(|&u| kbd(0, u, flags))
                .collect();
            send(&inputs);
        }

        fn text(&mut self, s: &str) {
            let mut inputs = Vec::with_capacity(s.len() * 2);
            for u in s.replace("\r\n", "\n").encode_utf16() {
                if u == b'\n' as u16 {
                    inputs.push(kbd(VK_RETURN.0, 0, KEYBD_EVENT_FLAGS(0)));
                    inputs.push(kbd(VK_RETURN.0, 0, KEYEVENTF_KEYUP));
                    continue;
                }
                inputs.push(kbd(0, u, KEYEVENTF_UNICODE));
                inputs.push(kbd(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            for chunk in inputs.chunks(200) {
                send(chunk);
            }
        }
    }
}

#[cfg(not(windows))]
mod other {
    use super::Backend;
    use crate::keymap::KeyEntry;
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

    pub struct EnigoBackend {
        e: Enigo,
    }

    impl EnigoBackend {
        pub fn new() -> anyhow::Result<Self> {
            let e = Enigo::new(&Settings {
                release_keys_when_dropped: true,
                ..Settings::default()
            })
            .map_err(|e| anyhow::anyhow!("enigo: {e}"))?;
            Ok(Self { e })
        }
    }

    fn dir(down: bool) -> Direction {
        if down {
            Direction::Press
        } else {
            Direction::Release
        }
    }

    impl Backend for EnigoBackend {
        fn move_abs(&mut self, x: i32, y: i32) {
            let _ = self.e.move_mouse(x, y, Coordinate::Abs);
        }
        fn button(&mut self, b: u8, down: bool) {
            let btn = match b {
                0 => Button::Left,
                1 => Button::Middle,
                _ => Button::Right,
            };
            let _ = self.e.button(btn, dir(down));
        }
        fn wheel(&mut self, dx120: i32, dy120: i32) {
            if dy120 != 0 {
                let _ = self.e.scroll(dy120 / 120, Axis::Vertical);
            }
            if dx120 != 0 {
                let _ = self.e.scroll(dx120 / 120, Axis::Horizontal);
            }
        }
        fn key(&mut self, k: &KeyEntry, down: bool) {
            #[cfg(target_os = "macos")]
            {
                let _ = (k, down);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = self.e.raw(k.xkb as u16, dir(down));
            }
        }
        fn unicode(&mut self, ch: char, down: bool) {
            let _ = self.e.key(Key::Unicode(ch), dir(down));
        }
        fn text(&mut self, s: &str) {
            let _ = self.e.text(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_to_desktop_with_offset() {
        let m = MonitorInfo {
            index: 1,
            name: "B".into(),
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: false,
        };
        assert_eq!(to_desktop(0.0, 0.0, &m), (-1920, 0));
        assert_eq!(to_desktop(1.0, 1.0, &m), (-1, 1079));
        assert_eq!(to_desktop(0.5, 0.5, &m), (-960, 540));
        assert_eq!(to_desktop(7.0, -3.0, &m), (-1, 0));
        assert_eq!(to_desktop(f64::NAN, 0.0, &m), (-1920, 0));
    }

    #[test]
    fn single_char_fallback() {
        assert_eq!(single_char("ç"), Some('ç'));
        assert_eq!(single_char("Dead"), None);
        assert_eq!(single_char(""), None);
    }
}
