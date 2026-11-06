//! The daemon ↔ helper frame protocol, version 1. See
//! `electron/terminal-host/pty-subprocess-ipc.ts` for the source of truth.
//!
//! Frame layout: `[type: u8] [payload length: u32 BE] [payload]`.

pub const SPAWN: u8 = 0x01;
pub const WRITE: u8 = 0x02;
pub const RESIZE: u8 = 0x03;
pub const KILL: u8 = 0x04;
pub const SIGNAL: u8 = 0x05;
pub const DISPOSE: u8 = 0x06;
pub const PAUSE: u8 = 0x07;
pub const RESUME: u8 = 0x08;

pub const READY: u8 = 0x11;
pub const SPAWNED: u8 = 0x12;
pub const DATA: u8 = 0x13;
pub const EXIT: u8 = 0x14;
pub const ERROR: u8 = 0x15;
pub const FGPROC: u8 = 0x16;
pub const RESIZED: u8 = 0x17;

const HEADER: usize = 5;

/// Append one encoded frame to `out`.
pub fn encode_into(out: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    out.reserve(HEADER + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
}

/// Streaming decoder: feed it bytes, take out complete frames.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    start: usize,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) {
        if self.start > 0 && self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete frame, if one has arrived.
    pub fn next_frame(&mut self) -> Option<(u8, Vec<u8>)> {
        let avail = &self.buf[self.start..];
        if avail.len() < HEADER {
            self.compact();
            return None;
        }
        let len = u32::from_be_bytes([avail[1], avail[2], avail[3], avail[4]]) as usize;
        if avail.len() < HEADER + len {
            self.compact();
            return None;
        }
        let kind = avail[0];
        let payload = avail[HEADER..HEADER + len].to_vec();
        self.start += HEADER + len;
        Some((kind, payload))
    }

    fn compact(&mut self) {
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        if self.buf.capacity() > 1 << 20 && self.buf.len() < 1 << 16 {
            self.buf.shrink_to(1 << 16);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_frames_split_anywhere() {
        let mut wire = Vec::new();
        encode_into(&mut wire, WRITE, b"hello");
        encode_into(&mut wire, PAUSE, b"");
        encode_into(&mut wire, RESIZE, br#"{"cols":80,"rows":24}"#);
        for split in 0..wire.len() {
            let mut d = Decoder::default();
            let mut got = Vec::new();
            d.push(&wire[..split]);
            while let Some(f) = d.next_frame() {
                got.push(f);
            }
            d.push(&wire[split..]);
            while let Some(f) = d.next_frame() {
                got.push(f);
            }
            assert_eq!(
                got,
                vec![
                    (WRITE, b"hello".to_vec()),
                    (PAUSE, vec![]),
                    (RESIZE, br#"{"cols":80,"rows":24}"#.to_vec())
                ],
                "split at {split}"
            );
        }
    }

    #[test]
    fn header_is_type_then_big_endian_length() {
        let mut out = Vec::new();
        encode_into(&mut out, DATA, &[7u8; 258]);
        assert_eq!(&out[..5], &[DATA, 0, 0, 1, 2]);
        assert_eq!(out.len(), 5 + 258);
    }
}
