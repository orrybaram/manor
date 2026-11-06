//! Keep DATA frames on UTF-8 character boundaries.
//!
//! The daemon decodes each DATA frame on its own (`payload.toString("utf-8")`),
//! so a character split across two frames would turn into two replacement
//! characters. node-pty avoided that by decoding with a streaming decoder; we
//! hold back an incomplete sequence at the end of a read until the next one.
//! Invalid bytes pass through untouched: the daemon replaces them exactly as
//! it would have before.

/// How many bytes at the end of `buf` are the start of a UTF-8 sequence that
/// isn't finished yet (0–3).
pub fn incomplete_tail(buf: &[u8]) -> usize {
    let n = buf.len();
    // A sequence is at most 4 bytes, so its lead byte is within the last 3.
    for back in 1..=3.min(n) {
        let b = buf[n - back];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte: keep looking for the lead
        }
        let needed = match b {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0, // ASCII or a byte that can't lead: nothing to hold
        };
        return if back < needed { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_back_each_unfinished_prefix() {
        for ch in ["é", "终", "🦀"] {
            let bytes = ch.as_bytes();
            for cut in 1..bytes.len() {
                let mut buf = b"ab".to_vec();
                buf.extend_from_slice(&bytes[..cut]);
                assert_eq!(incomplete_tail(&buf), cut, "{ch} cut at {cut}");
            }
            let mut whole = b"ab".to_vec();
            whole.extend_from_slice(bytes);
            assert_eq!(incomplete_tail(&whole), 0, "{ch} whole");
        }
    }

    #[test]
    fn passes_ascii_and_invalid_bytes() {
        assert_eq!(incomplete_tail(b""), 0);
        assert_eq!(incomplete_tail(b"plain"), 0);
        assert_eq!(incomplete_tail(&[b'a', 0xFF]), 0);
        assert_eq!(incomplete_tail(&[0x80, 0x80, 0x80]), 0);
        assert_eq!(incomplete_tail(&[b'a', 0xC0]), 0);
    }

    #[test]
    fn splitting_any_stream_anywhere_keeps_frames_valid() {
        let text = "manor 终端 ターミナル 🦀🧪👩‍💻 é́ 𝔐𝔞𝔫𝔬𝔯\n".repeat(20);
        let bytes = text.as_bytes();
        for chunk in 1..=7 {
            let mut carry: Vec<u8> = Vec::new();
            let mut out = Vec::new();
            for piece in bytes.chunks(chunk) {
                carry.extend_from_slice(piece);
                let hold = incomplete_tail(&carry);
                let send = carry.len() - hold;
                if send > 0 {
                    assert!(std::str::from_utf8(&carry[..send]).is_ok());
                    out.extend_from_slice(&carry[..send]);
                    carry.drain(..send);
                }
            }
            out.extend_from_slice(&carry);
            assert_eq!(out, bytes);
        }
    }
}
