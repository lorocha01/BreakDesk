//! RGBA/BGRA → I420 (BT.601 limited range) with optional downscaling.
//! Output dimensions are always even (H.264 4:2:0 requirement).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    Rgba,
    Bgra,
}

/// Reusable I420 frame buffer (no per-frame allocations once sized).
#[derive(Default)]
pub struct I420Frame {
    pub width: usize,
    pub height: usize,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    xmap: Vec<(u32, u32)>,
}

impl I420Frame {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure(&mut self, w: usize, h: usize) {
        if self.width != w || self.height != h {
            self.width = w;
            self.height = h;
            self.y.resize(w * h, 0);
            self.u.resize((w / 2) * (h / 2), 0);
            self.v.resize((w / 2) * (h / 2), 0);
        }
    }

    pub fn strides(&self) -> (usize, usize, usize) {
        (self.width, self.width / 2, self.width / 2)
    }
}

/// Computes output dims: fit inside `max_w`×`max_h` (if non-zero) keeping aspect, never upscaling,
/// multiplied by `scale` (≤ 1), rounded down to even, at least 2×2.
pub fn target_size(src_w: u32, src_h: u32, max_w: u32, max_h: u32, scale: f32) -> (u32, u32) {
    let mut f = 1.0f64;
    if max_w > 0 && max_h > 0 {
        f = f
            .min(max_w as f64 / src_w as f64)
            .min(max_h as f64 / src_h as f64);
    }
    f *= (scale as f64).clamp(0.05, 1.0);
    let w = ((src_w as f64 * f).floor() as u32).max(2) & !1;
    let h = ((src_h as f64 * f).floor() as u32).max(2) & !1;
    (w.min(src_w & !1).max(2), h.min(src_h & !1).max(2))
}

#[inline(always)]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8
}

#[inline(always)]
fn chroma(r: i32, g: i32, b: i32) -> (u8, u8) {
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// Converts a packed 4-byte-per-pixel image (`stride` bytes per row) into `out`, scaled to `dst_w`×`dst_h`.
/// When downscaling, each destination pixel averages a 2×2 neighbourhood around its source position.
#[allow(clippy::too_many_arguments)]
pub fn to_i420(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    stride: usize,
    order: PixelOrder,
    dst_w: usize,
    dst_h: usize,
    out: &mut I420Frame,
) {
    assert!(
        dst_w >= 2 && dst_h >= 2 && dst_w.is_multiple_of(2) && dst_h.is_multiple_of(2),
        "dst dims must be even"
    );
    assert!(
        src.len() >= stride * (src_h - 1) + src_w * 4,
        "source buffer too small"
    );
    out.ensure(dst_w, dst_h);
    let (ri, bi) = match order {
        PixelOrder::Rgba => (0usize, 2usize),
        PixelOrder::Bgra => (2, 0),
    };
    let scaled = dst_w != src_w || dst_h != src_h;
    // Precompute source x offsets (byte index of the sample and of its right neighbour).
    out.xmap.clear();
    for x in 0..dst_w {
        let sx = if scaled { x * src_w / dst_w } else { x };
        let sx1 = if scaled { (sx + 1).min(src_w - 1) } else { sx };
        out.xmap.push(((sx * 4) as u32, (sx1 * 4) as u32));
    }
    let I420Frame {
        y: ybuf,
        u: ubuf,
        v: vbuf,
        xmap,
        ..
    } = out;
    let cw = dst_w / 2;

    let sample = |row0: &[u8], row1: &[u8], xm: (u32, u32)| -> (i32, i32, i32) {
        let (a, b) = (xm.0 as usize, xm.1 as usize);
        if !scaled {
            return (row0[a + ri] as i32, row0[a + 1] as i32, row0[a + bi] as i32);
        }
        let r =
            row0[a + ri] as i32 + row0[b + ri] as i32 + row1[a + ri] as i32 + row1[b + ri] as i32;
        let g = row0[a + 1] as i32 + row0[b + 1] as i32 + row1[a + 1] as i32 + row1[b + 1] as i32;
        let bl =
            row0[a + bi] as i32 + row0[b + bi] as i32 + row1[a + bi] as i32 + row1[b + bi] as i32;
        ((r + 2) >> 2, (g + 2) >> 2, (bl + 2) >> 2)
    };
    let src_row = |sy: usize| &src[sy * stride..sy * stride + src_w * 4];

    for cy in 0..dst_h / 2 {
        let y0 = cy * 2;
        let y1 = y0 + 1;
        let (sy0, sy1) = if scaled {
            (y0 * src_h / dst_h, y1 * src_h / dst_h)
        } else {
            (y0, y1)
        };
        let r00 = src_row(sy0);
        let r01 = src_row(if scaled {
            (sy0 + 1).min(src_h - 1)
        } else {
            sy0
        });
        let r10 = src_row(sy1);
        let r11 = src_row(if scaled {
            (sy1 + 1).min(src_h - 1)
        } else {
            sy1
        });
        let yrow0 = &mut ybuf[y0 * dst_w..(y0 + 1) * dst_w];
        // split borrow for the second row
        let (yrow0, yrow1) = {
            let p = yrow0.as_mut_ptr();
            // SAFETY: rows y0 and y1 are disjoint slices of ybuf; y1 < dst_h.
            unsafe {
                (
                    std::slice::from_raw_parts_mut(p, dst_w),
                    std::slice::from_raw_parts_mut(p.add(dst_w), dst_w),
                )
            }
        };
        let urow = &mut ubuf[cy * cw..(cy + 1) * cw];
        let vrow = &mut vbuf[cy * cw..(cy + 1) * cw];
        for cx in 0..cw {
            let x0 = cx * 2;
            let (ra, ga, ba) = sample(r00, r01, xmap[x0]);
            let (rb, gb, bb) = sample(r00, r01, xmap[x0 + 1]);
            let (rc, gc, bc) = sample(r10, r11, xmap[x0]);
            let (rd, gd, bd) = sample(r10, r11, xmap[x0 + 1]);
            yrow0[x0] = luma(ra, ga, ba);
            yrow0[x0 + 1] = luma(rb, gb, bb);
            yrow1[x0] = luma(rc, gc, bc);
            yrow1[x0 + 1] = luma(rd, gd, bd);
            let (u, v) = chroma(
                (ra + rb + rc + rd + 2) >> 2,
                (ga + gb + gc + gd + 2) >> 2,
                (ba + bb + bc + bd + 2) >> 2,
            );
            urow[cx] = u;
            vrow[cx] = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: usize, h: usize, rgba: [u8; 4]) -> Vec<u8> {
        rgba.iter().copied().cycle().take(w * h * 4).collect()
    }

    #[test]
    fn target_size_even_and_fit() {
        assert_eq!(target_size(1920, 1080, 0, 0, 1.0), (1920, 1080));
        assert_eq!(target_size(1921, 1081, 0, 0, 1.0), (1920, 1080));
        assert_eq!(target_size(1920, 1080, 1280, 1280, 1.0), (1280, 720));
        assert_eq!(target_size(2560, 1440, 0, 0, 0.5), (1280, 720));
        assert_eq!(target_size(1366, 768, 4000, 4000, 1.0), (1366, 768)); // no upscale
        let (w, h) = target_size(1366, 768, 1001, 999, 1.0);
        assert!(w % 2 == 0 && h % 2 == 0 && w <= 1001 && h <= 999);
        assert_eq!(target_size(3, 3, 0, 0, 1.0), (2, 2));
    }

    #[test]
    fn colors_bt601_limited() {
        let mut f = I420Frame::new();
        for (rgba, (ey, eu, ev)) in [
            ([0, 0, 0, 255], (16, 128, 128)),
            ([255, 255, 255, 255], (235, 128, 128)),
            ([255, 0, 0, 255], (82, 90, 240)),
            ([0, 255, 0, 255], (145, 54, 34)),
            ([0, 0, 255, 255], (41, 240, 110)),
        ] {
            let img = solid(8, 4, rgba);
            to_i420(&img, 8, 4, 32, PixelOrder::Rgba, 8, 4, &mut f);
            assert!(
                f.y.iter().all(|&v| (v as i32 - ey).abs() <= 1),
                "Y for {rgba:?}: {}",
                f.y[0]
            );
            assert!(
                f.u.iter().all(|&v| (v as i32 - eu).abs() <= 1),
                "U for {rgba:?}: {}",
                f.u[0]
            );
            assert!(
                f.v.iter().all(|&v| (v as i32 - ev).abs() <= 1),
                "V for {rgba:?}: {}",
                f.v[0]
            );
        }
    }

    #[test]
    fn bgra_equals_swapped_rgba() {
        let mut a = I420Frame::new();
        let mut b = I420Frame::new();
        to_i420(
            &solid(4, 2, [10, 200, 30, 255]),
            4,
            2,
            16,
            PixelOrder::Rgba,
            4,
            2,
            &mut a,
        );
        to_i420(
            &solid(4, 2, [30, 200, 10, 255]),
            4,
            2,
            16,
            PixelOrder::Bgra,
            4,
            2,
            &mut b,
        );
        assert_eq!(a.y, b.y);
        assert_eq!(a.u, b.u);
        assert_eq!(a.v, b.v);
    }

    #[test]
    fn downscale_dims_buffers_and_layout() {
        // left half black, right half white
        let (w, h) = (64usize, 32usize);
        let mut img = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in w / 2..w {
                img[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        let mut f = I420Frame::new();
        to_i420(&img, w, h, w * 4, PixelOrder::Rgba, 32, 16, &mut f);
        assert_eq!((f.width, f.height), (32, 16));
        assert_eq!(f.y.len(), 512);
        assert_eq!(f.u.len(), 128);
        assert_eq!(f.y[0], 16);
        assert_eq!(f.y[31], 235);
        // stride with padding is honoured
        let stride = w * 4 + 16;
        let mut padded = vec![0u8; stride * h];
        for y in 0..h {
            padded[y * stride..y * stride + w * 4]
                .copy_from_slice(&img[y * w * 4..(y + 1) * w * 4]);
        }
        let mut g = I420Frame::new();
        to_i420(&padded, w, h, stride, PixelOrder::Rgba, 32, 16, &mut g);
        assert_eq!(f.y, g.y);
    }
}
