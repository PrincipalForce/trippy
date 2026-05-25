//! Stereo delay with feedback. Time can be set in samples or synced to BPM.

use super::Fx;

pub struct Delay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    sample_rate: f32,
    pub delay_samples: usize,
    pub feedback: f32,
    pub wet: f32,
    pub dry: f32,
    /// Cross-channel feedback factor — 0 = no cross, 1 = full ping-pong.
    pub ping_pong: f32,
}

impl Delay {
    pub fn new(sample_rate: f32, max_seconds: f32) -> Self {
        let cap = ((sample_rate * max_seconds).ceil() as usize).max(2);
        Self {
            buf_l: vec![0.0; cap],
            buf_r: vec![0.0; cap],
            write: 0,
            sample_rate,
            delay_samples: (sample_rate * 0.25) as usize,
            feedback: 0.4,
            wet: 0.35,
            dry: 1.0,
            ping_pong: 0.0,
        }
    }

    pub fn set_time_seconds(&mut self, sec: f32) {
        let s = (sec * self.sample_rate) as usize;
        self.delay_samples = s.clamp(1, self.buf_l.len() - 1);
    }

    pub fn set_time_beats(&mut self, beats: f32, bpm: f32) {
        let sec = beats * 60.0 / bpm.max(1.0);
        self.set_time_seconds(sec);
    }
}

impl Fx for Delay {
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let cap = self.buf_l.len();
        for i in 0..l.len() {
            let read = (self.write + cap - self.delay_samples) % cap;
            let dl = self.buf_l[read];
            let dr = self.buf_r[read];
            let cross = self.ping_pong.clamp(0.0, 1.0);
            let fb_l = dl * (1.0 - cross) + dr * cross;
            let fb_r = dr * (1.0 - cross) + dl * cross;
            // Write input + feedback into buffer.
            self.buf_l[self.write] = l[i] + fb_l * self.feedback;
            self.buf_r[self.write] = r[i] + fb_r * self.feedback;
            // Output = dry + wet*delayed
            l[i] = l[i] * self.dry + dl * self.wet;
            r[i] = r[i] * self.dry + dr * self.wet;
            self.write = (self.write + 1) % cap;
        }
    }

    fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.write = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impulse_produces_delayed_copy() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, 1.0);
        d.delay_samples = 100;
        d.wet = 1.0;
        d.dry = 0.0;
        d.feedback = 0.0;
        let n = 500;
        let mut l = vec![0.0; n];
        l[0] = 1.0;
        let mut r = vec![0.0; n];
        d.process(&mut l, &mut r);
        // Sample 100 of output should be ~1.0 (the delayed impulse).
        assert!((l[100] - 1.0).abs() < 1e-6, "got l[100]={}", l[100]);
        // Other samples should be ~0.
        assert!(l[50].abs() < 1e-6);
    }

    #[test]
    fn feedback_creates_echoes() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, 1.0);
        d.delay_samples = 50;
        d.wet = 1.0;
        d.dry = 0.0;
        d.feedback = 0.5;
        let n = 200;
        let mut l = vec![0.0; n];
        l[0] = 1.0;
        let mut r = vec![0.0; n];
        d.process(&mut l, &mut r);
        // Second echo at sample 100 should be ~0.5.
        assert!((l[100] - 0.5).abs() < 1e-3);
    }
}
