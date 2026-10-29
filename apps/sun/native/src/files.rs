//! Saving a file a chat page made (a diagram's SVG or PNG). The page sends the bytes as base64,
//! because Fire Code's window ignores a browser download link; Rust asks where with a Save dialog.
//!
//! A decoder of our own rather than a crate: it is twenty lines, and every dependency is one more
//! thing an offline build must already have (the Rust floor is pinned, see Cargo.toml).

/// Standard base64, padding optional, whitespace ignored. None when it is not base64.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    let mut ended = false;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                ended = true;
                continue;
            }
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        // Nothing may follow the padding.
        if ended {
            return None;
        }
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The page's suggested name, reduced to a plain file name: no folders, nothing Windows refuses.
/// It is only the dialog's starting suggestion - the user picks the actual place.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c })
        .take(120)
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "file".to_string() } else { trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_what_a_browser_encodes() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), b"");
        let png_head = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert_eq!(decode_base64("iVBORw0KGgo=").unwrap(), png_head);
        assert!(decode_base64("not base64!").is_none());
        assert!(decode_base64("aGk=aGk=").is_none());
    }

    #[test]
    fn a_suggested_name_cannot_name_a_folder() {
        assert_eq!(safe_file_name("..\\..\\Windows\\evil.svg"), "evil.svg");
        assert_eq!(safe_file_name("a/b:c?.png"), "b-c-.png");
        assert_eq!(safe_file_name("..."), "file");
        assert_eq!(safe_file_name("release-flow.svg"), "release-flow.svg");
    }
}
