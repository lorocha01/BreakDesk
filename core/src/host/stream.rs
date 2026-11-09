//! Capture → convert → encode loop on a dedicated OS thread.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::capture::{open_capturer, Capturer};
use crate::convert::{target_size, to_i420, I420Frame};
use crate::encoder::{EncoderParams, H264Encoder};
use crate::protocol::{MonitorInfo, QualityPreset};

pub struct EncodedSample {
    pub data: Vec<u8>,
    pub duration: Duration,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct StreamStats {
    pub fps: f32,
    pub encode_ms: f32,
    pub bitrate_kbps: u32,
    pub width: u32,
    pub height: u32,
}

pub enum StreamEvent {
    MonitorChanged {
        index: usize,
        width: u32,
        height: u32,
    },
}

/// Knobs shared between the session (async) and the capture thread.
pub struct StreamShared {
    pub running: AtomicBool,
    /// Capture only while the viewer is authorized and connected.
    pub active: AtomicBool,
    pub monitor: AtomicUsize,
    pub fps: AtomicU32,
    pub preset: Mutex<QualityPreset>,
    pub viewport: Mutex<(u32, u32)>,
    pub keyframe: AtomicBool,
    pub stats: Mutex<StreamStats>,
    pub current_monitor: Mutex<Option<MonitorInfo>>,
}

impl StreamShared {
    pub fn new(preset: QualityPreset, fps: u32) -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(true),
            active: AtomicBool::new(false),
            monitor: AtomicUsize::new(0),
            fps: AtomicU32::new(fps.clamp(5, 60)),
            preset: Mutex::new(preset),
            viewport: Mutex::new((0, 0)),
            keyframe: AtomicBool::new(true),
            stats: Mutex::new(StreamStats::default()),
            current_monitor: Mutex::new(None),
        })
    }
}

/// Computes the encode size for a captured frame under the current preset.
pub fn encode_size(
    src_w: u32,
    src_h: u32,
    preset: QualityPreset,
    viewport: (u32, u32),
) -> (u32, u32) {
    let (mut mw, mut mh, mut scale) = (3840u32, 2160u32, 1.0f32);
    match preset {
        QualityPreset::Auto => {
            if viewport.0 >= 160 && viewport.1 >= 120 {
                mw = viewport.0.min(3840);
                mh = viewport.1.min(2160);
            }
        }
        QualityPreset::Speed if src_w > 1920 => {
            scale = 0.5;
        }
        _ => {}
    }
    if src_w < mw && src_h < mh {
        // keep fit() from rejecting small screens
        mw = mw.max(src_w);
        mh = mh.max(src_h);
    }
    target_size(src_w, src_h, mw, mh, scale)
}

pub fn spawn(
    shared: Arc<StreamShared>,
    tx: tokio::sync::mpsc::Sender<EncodedSample>,
    events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
) {
    std::thread::Builder::new()
        .name("nexo-capture".into())
        .spawn(move || run(shared, tx, events))
        .expect("spawn capture thread");
}

fn run(
    shared: Arc<StreamShared>,
    tx: tokio::sync::mpsc::Sender<EncodedSample>,
    events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
) {
    let mut capturer: Option<Box<dyn Capturer>> = None;
    let mut cap_index = usize::MAX;
    let mut frame = I420Frame::new();
    let mut enc: Option<H264Encoder> = None;
    let mut last_sample = Instant::now();
    let mut window_start = Instant::now();
    let (mut frames, mut bytes, mut work_ms) = (0u32, 0u64, 0f32);
    let mut last_err = Instant::now() - Duration::from_secs(60);

    while shared.running.load(Ordering::Relaxed) {
        if !shared.active.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(30));
            continue;
        }
        let fps = shared.fps.load(Ordering::Relaxed).clamp(5, 60);
        let interval = Duration::from_secs_f64(1.0 / fps as f64);
        let t0 = Instant::now();

        let want = shared.monitor.load(Ordering::Relaxed);
        if capturer.is_none() || want != cap_index {
            match open_capturer(want) {
                Ok(c) => {
                    let info = c.info().clone();
                    cap_index = want;
                    if info.index != want {
                        shared.monitor.store(info.index, Ordering::Relaxed);
                        cap_index = info.index;
                    }
                    let _ = events.send(StreamEvent::MonitorChanged {
                        index: info.index,
                        width: info.width,
                        height: info.height,
                    });
                    *shared.current_monitor.lock() = Some(info);
                    capturer = Some(c);
                    shared.keyframe.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    if last_err.elapsed() > Duration::from_secs(5) {
                        tracing::warn!("open capturer: {e}");
                        last_err = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
        }

        let raw = match capturer.as_mut().unwrap().capture() {
            Ok(f) => f,
            Err(e) => {
                if last_err.elapsed() > Duration::from_secs(5) {
                    tracing::warn!("{e}");
                    last_err = Instant::now();
                }
                capturer = None; // reopen (resolution change, session switch, ...)
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
        };

        let preset = *shared.preset.lock();
        let viewport = *shared.viewport.lock();
        let (tw, th) = encode_size(raw.width as u32, raw.height as u32, preset, viewport);
        to_i420(
            &raw.data,
            raw.width,
            raw.height,
            raw.stride,
            raw.order,
            tw as usize,
            th as usize,
            &mut frame,
        );

        let params = EncoderParams {
            width: tw,
            height: th,
            bitrate_bps: preset.bitrate_bps(),
            fps,
        };
        if enc.as_ref().map(|e| e.params()) != Some(params) {
            match H264Encoder::new(params) {
                Ok(e) => enc = Some(e),
                Err(e) => {
                    tracing::error!("encoder: {e}");
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
        }
        let e = enc.as_mut().unwrap();
        if shared.keyframe.swap(false, Ordering::Relaxed) {
            e.request_keyframe();
        }
        match e.encode(&frame) {
            Ok(Some(ef)) => {
                let now = Instant::now();
                let duration =
                    (now - last_sample).clamp(Duration::from_millis(1), Duration::from_secs(1));
                last_sample = now;
                bytes += ef.data.len() as u64;
                frames += 1;
                if tx
                    .blocking_send(EncodedSample {
                        data: ef.data,
                        duration,
                    })
                    .is_err()
                {
                    break;
                }
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!("{err}");
                enc = None;
            }
        }
        work_ms += t0.elapsed().as_secs_f32() * 1000.0;

        let win = window_start.elapsed();
        if win >= Duration::from_secs(2) {
            let secs = win.as_secs_f32();
            *shared.stats.lock() = StreamStats {
                fps: frames as f32 / secs,
                encode_ms: if frames > 0 {
                    work_ms / frames as f32
                } else {
                    0.0
                },
                bitrate_kbps: ((bytes * 8) as f32 / secs / 1000.0) as u32,
                width: tw,
                height: th,
            };
            window_start = Instant::now();
            frames = 0;
            bytes = 0;
            work_ms = 0.0;
        }

        let spent = t0.elapsed();
        if spent < interval {
            std::thread::sleep(interval - spent);
        }
    }
    shared.active.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_sizes() {
        assert_eq!(
            encode_size(1920, 1080, QualityPreset::Quality, (0, 0)),
            (1920, 1080)
        );
        assert_eq!(
            encode_size(3840, 2160, QualityPreset::Speed, (0, 0)),
            (1920, 1080)
        );
        assert_eq!(
            encode_size(1920, 1080, QualityPreset::Speed, (0, 0)),
            (1920, 1080)
        );
        assert_eq!(
            encode_size(2560, 1440, QualityPreset::Auto, (1280, 800)),
            (1280, 720)
        );
        assert_eq!(
            encode_size(1366, 768, QualityPreset::Auto, (4000, 3000)),
            (1366, 768)
        );
        assert_eq!(
            encode_size(5120, 2880, QualityPreset::Balanced, (0, 0)),
            (3840, 2160)
        );
    }
}
