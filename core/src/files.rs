//! File-transfer helpers shared by the host (`files` data channel) and the Tauri shell
//! (viewer-side downloads): binary frame header, path sanitization, directory listing.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const CHUNK: usize = 16 * 1024;
pub const HIGH_WATER: usize = 1024 * 1024;
pub const LOW_WATER: usize = 256 * 1024;

/// `[u32 BE transferId][u32 BE fileIndex]`
pub fn encode_header(id: u32, file_index: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + payload.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(&file_index.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

pub fn decode_header(frame: &[u8]) -> Option<(u32, u32, &[u8])> {
    if frame.len() < 8 {
        return None;
    }
    let id = u32::from_be_bytes(frame[0..4].try_into().ok()?);
    let idx = u32::from_be_bytes(frame[4..8].try_into().ok()?);
    Some((id, idx, &frame[8..]))
}

const WIN_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Sanitizes one path component; returns None for components that must be dropped.
pub fn sanitize_component(c: &str) -> Option<String> {
    let c = c.trim();
    if c.is_empty() || c == "." || c == ".." {
        return None;
    }
    let mut s: String = c
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"|?*\\/".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    // Windows forbids trailing dots/spaces.
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        return None;
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WIN_RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    if s.len() > 240 {
        s = s.chars().take(200).collect();
    }
    Some(s)
}

/// Turns an untrusted relative path (either separator) into a safe relative PathBuf.
/// Any `..`, root, or drive prefix is rejected outright.
pub fn sanitize_rel_path(rel: &str) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    for raw in rel.split(['/', '\\']) {
        let t = raw.trim();
        if t == ".." {
            return Err(anyhow!("path traversal rejected"));
        }
        if t.len() == 2 && t.ends_with(':') {
            return Err(anyhow!("drive prefix rejected"));
        }
        if let Some(c) = sanitize_component(t) {
            out.push(c);
        }
    }
    if out.as_os_str().is_empty() {
        return Err(anyhow!("empty path"));
    }
    Ok(out)
}

/// Joins `rel` (sanitized) under `root` and guarantees the result stays inside `root`.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = sanitize_rel_path(rel)?;
    for c in rel.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(anyhow!("invalid component"));
        }
    }
    Ok(root.join(rel))
}

/// Returns `path` or `name (1).ext`, `name (2).ext`, … if it already exists.
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(Path::new(""));
    for i in 1..10_000 {
        let p = parent.join(format!("{stem} ({i}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    parent.join(format!("{stem} ({}){ext}", crate::protocol::random_id()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// ms since epoch
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

pub fn roots() -> Vec<DirEntry> {
    let mut v = vec![];
    #[cfg(windows)]
    {
        let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
        for i in 0..26u32 {
            if mask & (1 << i) != 0 {
                let letter = (b'A' + i as u8) as char;
                let p = format!("{letter}:\\");
                v.push(DirEntry {
                    name: format!("{letter}:"),
                    path: p,
                    is_dir: true,
                    size: 0,
                    modified: 0,
                });
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(h) = dirs::home_dir() {
            v.push(DirEntry {
                name: "Home".into(),
                path: h.to_string_lossy().into_owned(),
                is_dir: true,
                size: 0,
                modified: 0,
            });
        }
        v.push(DirEntry {
            name: "/".into(),
            path: "/".into(),
            is_dir: true,
            size: 0,
            modified: 0,
        });
    }
    v
}

pub fn list_dir(path: &str) -> Result<Listing> {
    if path.trim().is_empty() {
        return Ok(Listing {
            path: String::new(),
            parent: None,
            entries: roots(),
        });
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(anyhow!("path must be absolute"));
    }
    let mut entries = vec![];
    for e in std::fs::read_dir(&p)? {
        let Ok(e) = e else { continue };
        let Ok(md) = e.metadata() else { continue };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            modified,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    // Parent of a drive root / filesystem root is the virtual roots list ('').
    let parent = match p.parent() {
        Some(par) if par != p => Some(par.to_string_lossy().into_owned()),
        _ => Some(String::new()),
    };
    Ok(Listing {
        path: p.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// A file to send in a `get` transfer.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedFile {
    pub abs: PathBuf,
    pub rel_path: String,
    pub size: u64,
}

/// Expands a file or folder into the files to send; folder contents keep the folder name as prefix.
pub fn plan_get(path: &Path) -> Result<Vec<PlannedFile>> {
    let md = std::fs::metadata(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    if md.is_file() {
        return Ok(vec![PlannedFile {
            abs: path.to_path_buf(),
            rel_path: name,
            size: md.len(),
        }]);
    }
    let mut out = vec![];
    let mut stack = vec![(path.to_path_buf(), name)];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let child_rel = format!("{rel}/{}", e.file_name().to_string_lossy());
            if ft.is_dir() {
                stack.push((e.path(), child_rel));
            } else if ft.is_file() {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(PlannedFile {
                    abs: e.path(),
                    rel_path: child_rel,
                    size,
                });
            }
            if out.len() > 100_000 {
                return Err(anyhow!("too many files"));
            }
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip() {
        let f = encode_header(0xDEADBEEF, 7, b"abc");
        assert_eq!(&f[..8], &[0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 7]);
        assert_eq!(decode_header(&f), Some((0xDEADBEEF, 7, &b"abc"[..])));
        assert_eq!(decode_header(&[1, 2, 3]), None);
        assert_eq!(
            decode_header(&encode_header(1, 0, b"")),
            Some((1, 0, &b""[..]))
        );
    }

    #[test]
    fn sanitize_rejects_traversal_and_prefixes() {
        assert!(sanitize_rel_path("../etc/passwd").is_err());
        assert!(sanitize_rel_path("a/../../b").is_err());
        assert!(sanitize_rel_path("a\\..\\b").is_err());
        assert!(sanitize_rel_path("C:\\Windows\\x").is_err());
        assert!(sanitize_rel_path("").is_err());
        assert!(sanitize_rel_path("/").is_err());
        assert_eq!(
            sanitize_rel_path("/abs/file.txt").unwrap(),
            PathBuf::from("abs").join("file.txt")
        );
        assert_eq!(
            sanitize_rel_path("dir\\sub/f.txt").unwrap(),
            PathBuf::from("dir").join("sub").join("f.txt")
        );
        assert_eq!(
            sanitize_rel_path("a/./b").unwrap(),
            PathBuf::from("a").join("b")
        );
        assert_eq!(
            sanitize_rel_path("CON.txt").unwrap(),
            PathBuf::from("_CON.txt")
        );
        assert_eq!(
            sanitize_rel_path("we<i>rd?.txt").unwrap(),
            PathBuf::from("we_i_rd_.txt")
        );
        assert_eq!(
            sanitize_rel_path("trail. ").unwrap(),
            PathBuf::from("trail")
        );
        let root = Path::new("/tmp/root");
        assert!(safe_join(root, "x/y.bin").unwrap().starts_with(root));
    }

    #[test]
    fn unique_names() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        assert_eq!(unique_path(&p), p);
        std::fs::write(&p, b"1").unwrap();
        assert_eq!(unique_path(&p), d.path().join("a (1).txt"));
        std::fs::write(d.path().join("a (1).txt"), b"1").unwrap();
        assert_eq!(unique_path(&p), d.path().join("a (2).txt"));
    }

    #[test]
    fn listing_and_plan() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("pasta/sub")).unwrap();
        std::fs::write(d.path().join("pasta/a.txt"), b"hello").unwrap();
        std::fs::write(d.path().join("pasta/sub/b.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(d.path().join("z.txt"), b"z").unwrap();
        let l = list_dir(d.path().to_str().unwrap()).unwrap();
        assert_eq!(l.entries[0].name, "pasta");
        assert!(l.entries[0].is_dir);
        assert_eq!(l.entries[1].size, 1);
        assert!(list_dir("relative/path").is_err());
        assert!(!list_dir("").unwrap().entries.is_empty());
        let plan = plan_get(&d.path().join("pasta")).unwrap();
        assert_eq!(
            plan.iter().map(|p| p.rel_path.as_str()).collect::<Vec<_>>(),
            vec!["pasta/a.txt", "pasta/sub/b.bin"]
        );
        assert_eq!(plan[1].size, 100);
        let single = plan_get(&d.path().join("z.txt")).unwrap();
        assert_eq!(single[0].rel_path, "z.txt");
    }
}
