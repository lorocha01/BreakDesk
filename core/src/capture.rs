//! Screen capture. `xcap` backend today; the `Capturer` trait leaves room for a
//! DXGI Desktop Duplication / Windows.Graphics.Capture backend later.

use anyhow::{anyhow, Result};

use crate::convert::PixelOrder;
use crate::protocol::MonitorInfo;

pub struct Frame {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub order: PixelOrder,
}

pub trait Capturer {
    fn info(&self) -> &MonitorInfo;
    fn capture(&mut self) -> Result<Frame>;
}

/// Lists monitors in a stable order (primary first, then by position).
pub fn list_monitors() -> Result<Vec<MonitorInfo>> {
    Ok(sorted_xcap_monitors()?
        .into_iter()
        .map(|(info, _)| info)
        .collect())
}

fn sorted_xcap_monitors() -> Result<Vec<(MonitorInfo, xcap::Monitor)>> {
    let mons = xcap::Monitor::all().map_err(|e| anyhow!("listing monitors: {e}"))?;
    let mut v: Vec<(MonitorInfo, xcap::Monitor)> = mons
        .into_iter()
        .filter_map(|m| {
            let info = MonitorInfo {
                index: 0,
                name: m
                    .friendly_name()
                    .or_else(|_| m.name())
                    .unwrap_or_else(|_| "Monitor".into()),
                x: m.x().ok()?,
                y: m.y().ok()?,
                width: m.width().ok()?,
                height: m.height().ok()?,
                scale: m.scale_factor().unwrap_or(1.0),
                primary: m.is_primary().unwrap_or(false),
            };
            (info.width > 0 && info.height > 0).then_some((info, m))
        })
        .collect();
    v.sort_by_key(|(i, _)| (!i.primary, i.x, i.y));
    for (idx, (i, _)) in v.iter_mut().enumerate() {
        i.index = idx;
    }
    if v.is_empty() {
        return Err(anyhow!("no monitors found"));
    }
    Ok(v)
}

pub struct XcapCapturer {
    info: MonitorInfo,
    monitor: xcap::Monitor,
}

impl XcapCapturer {
    /// Opens monitor `index` (falls back to the primary one if out of range).
    pub fn open(index: usize) -> Result<Self> {
        let mut all = sorted_xcap_monitors()?;
        let pick = if index < all.len() { index } else { 0 };
        let (info, monitor) = all.swap_remove(pick);
        Ok(Self { info, monitor })
    }
}

impl Capturer for XcapCapturer {
    fn info(&self) -> &MonitorInfo {
        &self.info
    }

    fn capture(&mut self) -> Result<Frame> {
        let img = self
            .monitor
            .capture_image()
            .map_err(|e| anyhow!("capture failed: {e}"))?;
        let (w, h) = (img.width() as usize, img.height() as usize);
        Ok(Frame {
            data: img.into_raw(),
            width: w,
            height: h,
            stride: w * 4,
            order: PixelOrder::Rgba,
        })
    }
}

pub fn open_capturer(index: usize) -> Result<Box<dyn Capturer>> {
    let xcap = XcapCapturer::open(index)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_some() {
            match x11::X11Capturer::open(xcap.info.clone()) {
                Ok(c) => return Ok(Box::new(c)),
                Err(e) => tracing::debug!("x11 capturer unavailable, using xcap: {e}"),
            }
        }
    }
    Ok(Box::new(xcap))
}

/// X11 backend with one persistent connection (xcap reconnects three times per frame and
/// converts pixel-by-pixel, which is slow and occasionally fails under load).
#[cfg(all(unix, not(target_os = "macos")))]
mod x11 {
    use super::{Capturer, Frame};
    use crate::convert::PixelOrder;
    use crate::protocol::MonitorInfo;
    use anyhow::{anyhow, Result};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, ImageFormat, ImageOrder};
    use x11rb::rust_connection::RustConnection;

    pub struct X11Capturer {
        info: MonitorInfo,
        conn: RustConnection,
        root: u32,
    }

    impl X11Capturer {
        pub fn open(info: MonitorInfo) -> Result<Self> {
            let (conn, screen) = x11rb::connect(None)?;
            let setup = conn.setup();
            let s = &setup.roots[screen];
            let fmt = setup
                .pixmap_formats
                .iter()
                .find(|f| f.depth == s.root_depth)
                .ok_or_else(|| anyhow!("no pixmap format"))?;
            if fmt.bits_per_pixel != 32 || setup.image_byte_order != ImageOrder::LSB_FIRST {
                return Err(anyhow!("unsupported visual (bpp {})", fmt.bits_per_pixel));
            }
            let root = s.root;
            Ok(Self { info, conn, root })
        }
    }

    impl Capturer for X11Capturer {
        fn info(&self) -> &MonitorInfo {
            &self.info
        }

        fn capture(&mut self) -> Result<Frame> {
            let (w, h) = (self.info.width as u16, self.info.height as u16);
            let reply = self
                .conn
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    self.root,
                    self.info.x as i16,
                    self.info.y as i16,
                    w,
                    h,
                    !0,
                )?
                .reply()?;
            let (w, h) = (w as usize, h as usize);
            if reply.data.len() < w * h * 4 {
                return Err(anyhow!("short image reply"));
            }
            // 32 bpp little-endian ZPixmap = B,G,R,X per pixel
            Ok(Frame {
                data: reply.data,
                width: w,
                height: h,
                stride: w * 4,
                order: PixelOrder::Bgra,
            })
        }
    }
}
