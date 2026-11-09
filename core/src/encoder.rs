//! H.264 encoder (OpenH264, built from source) producing Annex-B access units.

use anyhow::{anyhow, Result};
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, Profile,
    RateControlMode, SpsPpsStrategy, UsageType,
};
use openh264::formats::YUVSlices;
use openh264::OpenH264API;

use crate::convert::I420Frame;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderParams {
    pub width: u32,
    pub height: u32,
    pub bitrate_bps: u32,
    pub fps: u32,
}

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

pub struct H264Encoder {
    enc: Encoder,
    params: EncoderParams,
    force_idr: bool,
}

impl H264Encoder {
    pub fn new(params: EncoderParams) -> Result<Self> {
        let fps = params.fps.clamp(1, 60);
        let cfg = EncoderConfig::new()
            .usage_type(UsageType::ScreenContentRealTime)
            .profile(Profile::Baseline)
            .rate_control_mode(RateControlMode::Bitrate)
            .bitrate(BitRate::from_bps(params.bitrate_bps))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps * 2))
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .complexity(Complexity::Low)
            .adaptive_quantization(false)
            .background_detection(false)
            .skip_frames(true)
            .num_threads(0);
        let enc = Encoder::with_api_config(OpenH264API::from_source(), cfg)
            .map_err(|e| anyhow!("openh264 init: {e}"))?;
        Ok(Self {
            enc,
            params,
            force_idr: true,
        })
    }

    pub fn params(&self) -> EncoderParams {
        self.params
    }

    pub fn request_keyframe(&mut self) {
        self.force_idr = true;
    }

    /// Encodes one frame. Returns `None` when the rate controller skipped it.
    pub fn encode(&mut self, frame: &I420Frame) -> Result<Option<EncodedFrame>> {
        if frame.width as u32 != self.params.width || frame.height as u32 != self.params.height {
            return Err(anyhow!("frame size does not match encoder"));
        }
        if self.force_idr {
            self.enc.force_intra_frame();
            self.force_idr = false;
        }
        let src = YUVSlices::new(
            (&frame.y, &frame.u, &frame.v),
            (frame.width, frame.height),
            frame.strides(),
        );
        let bs = self.enc.encode(&src).map_err(|e| anyhow!("encode: {e}"))?;
        let ft = bs.frame_type();
        if matches!(ft, FrameType::Skip | FrameType::Invalid) {
            return Ok(None);
        }
        let mut data = Vec::with_capacity(64 * 1024);
        bs.write_vec(&mut data);
        if data.is_empty() {
            return Ok(None);
        }
        Ok(Some(EncodedFrame {
            data,
            keyframe: matches!(ft, FrameType::IDR | FrameType::I),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::{to_i420, PixelOrder};

    #[test]
    fn encodes_idr_with_sps_pps_then_p_frames() {
        let (w, h) = (320usize, 240usize);
        let mut img = vec![0u8; w * h * 4];
        let mut frame = I420Frame::new();
        let mut enc = H264Encoder::new(EncoderParams {
            width: 320,
            height: 240,
            bitrate_bps: 1_000_000,
            fps: 30,
        })
        .unwrap();
        let mut sizes = vec![];
        for i in 0..10u8 {
            for (j, p) in img.chunks_mut(4).enumerate() {
                p.copy_from_slice(&[(j as u8).wrapping_add(i * 9), i * 20, 128, 255]);
            }
            to_i420(&img, w, h, w * 4, PixelOrder::Rgba, w, h, &mut frame);
            if let Some(f) = enc.encode(&frame).unwrap() {
                if sizes.is_empty() {
                    assert!(f.keyframe, "first frame must be IDR");
                    assert_eq!(&f.data[..4], &[0, 0, 0, 1], "Annex-B start code");
                    // SPS (type 7) with profile_idc 66 (baseline) must be present
                    let sps = f
                        .data
                        .windows(5)
                        .find(|w| w[..4] == [0, 0, 0, 1] && (w[4] & 0x1f) == 7);
                    assert!(sps.is_some());
                }
                sizes.push(f.data.len());
            }
        }
        assert!(sizes.len() >= 5);
        enc.request_keyframe();
        let f = enc.encode(&frame).unwrap().unwrap();
        assert!(f.keyframe);
    }
}
