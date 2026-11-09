//! DOM `KeyboardEvent.code` → physical key codes.
//! Physical (position-based) injection keeps the host's keyboard layout authoritative,
//! exactly like a local keyboard would.
//!
//! Columns: DOM code, Windows set-1 scancode (0xE0xx = extended), XKB keycode (evdev + 8).
//! Values follow Chromium's `dom_code_data.inc`.

pub struct KeyEntry {
    pub code: &'static str,
    pub win_scan: u16,
    pub xkb: u8,
}

macro_rules! keys {
    ($( $code:literal => $win:literal, $xkb:literal; )*) => {
        pub static KEYS: &[KeyEntry] = &[ $( KeyEntry { code: $code, win_scan: $win, xkb: $xkb }, )* ];
    };
}

keys! {
    "Escape" => 0x0001, 9;
    "Digit1" => 0x0002, 10; "Digit2" => 0x0003, 11; "Digit3" => 0x0004, 12; "Digit4" => 0x0005, 13;
    "Digit5" => 0x0006, 14; "Digit6" => 0x0007, 15; "Digit7" => 0x0008, 16; "Digit8" => 0x0009, 17;
    "Digit9" => 0x000A, 18; "Digit0" => 0x000B, 19;
    "Minus" => 0x000C, 20; "Equal" => 0x000D, 21; "Backspace" => 0x000E, 22; "Tab" => 0x000F, 23;
    "KeyQ" => 0x0010, 24; "KeyW" => 0x0011, 25; "KeyE" => 0x0012, 26; "KeyR" => 0x0013, 27;
    "KeyT" => 0x0014, 28; "KeyY" => 0x0015, 29; "KeyU" => 0x0016, 30; "KeyI" => 0x0017, 31;
    "KeyO" => 0x0018, 32; "KeyP" => 0x0019, 33;
    "BracketLeft" => 0x001A, 34; "BracketRight" => 0x001B, 35; "Enter" => 0x001C, 36;
    "ControlLeft" => 0x001D, 37;
    "KeyA" => 0x001E, 38; "KeyS" => 0x001F, 39; "KeyD" => 0x0020, 40; "KeyF" => 0x0021, 41;
    "KeyG" => 0x0022, 42; "KeyH" => 0x0023, 43; "KeyJ" => 0x0024, 44; "KeyK" => 0x0025, 45;
    "KeyL" => 0x0026, 46;
    "Semicolon" => 0x0027, 47; "Quote" => 0x0028, 48; "Backquote" => 0x0029, 49;
    "ShiftLeft" => 0x002A, 50; "Backslash" => 0x002B, 51;
    "KeyZ" => 0x002C, 52; "KeyX" => 0x002D, 53; "KeyC" => 0x002E, 54; "KeyV" => 0x002F, 55;
    "KeyB" => 0x0030, 56; "KeyN" => 0x0031, 57; "KeyM" => 0x0032, 58;
    "Comma" => 0x0033, 59; "Period" => 0x0034, 60; "Slash" => 0x0035, 61; "ShiftRight" => 0x0036, 62;
    "NumpadMultiply" => 0x0037, 63; "AltLeft" => 0x0038, 64; "Space" => 0x0039, 65; "CapsLock" => 0x003A, 66;
    "F1" => 0x003B, 67; "F2" => 0x003C, 68; "F3" => 0x003D, 69; "F4" => 0x003E, 70; "F5" => 0x003F, 71;
    "F6" => 0x0040, 72; "F7" => 0x0041, 73; "F8" => 0x0042, 74; "F9" => 0x0043, 75; "F10" => 0x0044, 76;
    "NumLock" => 0xE045, 77; "ScrollLock" => 0x0046, 78;
    "Numpad7" => 0x0047, 79; "Numpad8" => 0x0048, 80; "Numpad9" => 0x0049, 81; "NumpadSubtract" => 0x004A, 82;
    "Numpad4" => 0x004B, 83; "Numpad5" => 0x004C, 84; "Numpad6" => 0x004D, 85; "NumpadAdd" => 0x004E, 86;
    "Numpad1" => 0x004F, 87; "Numpad2" => 0x0050, 88; "Numpad3" => 0x0051, 89; "Numpad0" => 0x0052, 90;
    "NumpadDecimal" => 0x0053, 91;
    "IntlBackslash" => 0x0056, 94; "F11" => 0x0057, 95; "F12" => 0x0058, 96; "IntlRo" => 0x0073, 97;
    "Convert" => 0x0079, 100; "KanaMode" => 0x0070, 101; "NonConvert" => 0x007B, 102;
    "NumpadEnter" => 0xE01C, 104; "ControlRight" => 0xE01D, 105; "NumpadDivide" => 0xE035, 106;
    "PrintScreen" => 0xE037, 107; "AltRight" => 0xE038, 108;
    "Home" => 0xE047, 110; "ArrowUp" => 0xE048, 111; "PageUp" => 0xE049, 112; "ArrowLeft" => 0xE04B, 113;
    "ArrowRight" => 0xE04D, 114; "End" => 0xE04F, 115; "ArrowDown" => 0xE050, 116; "PageDown" => 0xE051, 117;
    "Insert" => 0xE052, 118; "Delete" => 0xE053, 119;
    "AudioVolumeMute" => 0xE020, 121; "AudioVolumeDown" => 0xE02E, 122; "AudioVolumeUp" => 0xE030, 123;
    "Power" => 0xE05E, 124; "NumpadEqual" => 0x0059, 125; "Pause" => 0x0045, 127;
    "NumpadComma" => 0x007E, 129; "IntlYen" => 0x007D, 132;
    "MetaLeft" => 0xE05B, 133; "MetaRight" => 0xE05C, 134; "ContextMenu" => 0xE05D, 135;
    "BrowserStop" => 0xE068, 136; "Sleep" => 0xE05F, 150; "WakeUp" => 0xE063, 151;
    "LaunchMail" => 0xE06C, 163; "BrowserFavorites" => 0xE066, 164; "BrowserBack" => 0xE06A, 166;
    "BrowserForward" => 0xE069, 167; "MediaTrackNext" => 0xE019, 171; "MediaPlayPause" => 0xE022, 172;
    "MediaTrackPrevious" => 0xE010, 173; "MediaStop" => 0xE024, 174; "LaunchApp1" => 0xE06B, 156;
    "LaunchApp2" => 0xE021, 148; "MediaSelect" => 0xE06D, 179;
    "BrowserHome" => 0xE032, 180; "BrowserRefresh" => 0xE067, 181; "BrowserSearch" => 0xE065, 225;
    "F13" => 0x0064, 191; "F14" => 0x0065, 192; "F15" => 0x0066, 193; "F16" => 0x0067, 194;
    "F17" => 0x0068, 195; "F18" => 0x0069, 196; "F19" => 0x006A, 197; "F20" => 0x006B, 198;
    "F21" => 0x006C, 199; "F22" => 0x006D, 200; "F23" => 0x006E, 201; "F24" => 0x0076, 202;
}

pub fn lookup(code: &str) -> Option<&'static KeyEntry> {
    // Linear search over ~130 entries is negligible next to the injection syscall.
    KEYS.iter().find(|k| k.code == code)
}

/// True for modifier codes (used to release stuck modifiers when a session ends).
pub fn is_modifier(code: &str) -> bool {
    matches!(
        code,
        "ShiftLeft"
            | "ShiftRight"
            | "ControlLeft"
            | "ControlRight"
            | "AltLeft"
            | "AltRight"
            | "MetaLeft"
            | "MetaRight"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn covers_standard_keyboard() {
        let mut must: Vec<String> = vec![];
        must.extend(('A'..='Z').map(|c| format!("Key{c}")));
        must.extend((0..=9).map(|d| format!("Digit{d}")));
        must.extend((1..=24).map(|f| format!("F{f}")));
        must.extend((0..=9).map(|d| format!("Numpad{d}")));
        for c in [
            "Escape",
            "Enter",
            "Tab",
            "Backspace",
            "Space",
            "CapsLock",
            "ShiftLeft",
            "ShiftRight",
            "ControlLeft",
            "ControlRight",
            "AltLeft",
            "AltRight",
            "MetaLeft",
            "MetaRight",
            "ContextMenu",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Insert",
            "Delete",
            "PrintScreen",
            "ScrollLock",
            "Pause",
            "NumLock",
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            "NumpadEnter",
            "Minus",
            "Equal",
            "BracketLeft",
            "BracketRight",
            "Backslash",
            "Semicolon",
            "Quote",
            "Backquote",
            "Comma",
            "Period",
            "Slash",
            "IntlBackslash",
            "IntlRo",
            "AudioVolumeMute",
            "AudioVolumeUp",
            "AudioVolumeDown",
            "MediaPlayPause",
            "MediaTrackNext",
            "MediaTrackPrevious",
            "MediaStop",
        ] {
            must.push(c.to_string());
        }
        for c in &must {
            assert!(lookup(c).is_some(), "missing mapping for {c}");
        }
    }

    #[test]
    fn codes_are_unique_and_consistent() {
        let mut codes = HashSet::new();
        let mut scans = HashSet::new();
        let mut xkbs = HashSet::new();
        for k in KEYS {
            assert!(codes.insert(k.code), "duplicate code {}", k.code);
            assert!(
                scans.insert(k.win_scan),
                "duplicate scancode for {}",
                k.code
            );
            assert!(xkbs.insert(k.xkb), "duplicate xkb for {}", k.code);
            assert!(k.xkb >= 8);
            assert!(k.win_scan & 0xFF00 == 0 || k.win_scan & 0xFF00 == 0xE000);
        }
        assert_eq!(lookup("KeyA").unwrap().win_scan, 0x1E);
        assert_eq!(lookup("ArrowLeft").unwrap().win_scan, 0xE04B);
        assert_eq!(lookup("KeyA").unwrap().xkb, 38);
    }
}
