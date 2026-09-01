//! Wire framing for the Pi player's LED outputs — a byte-exact Rust port of
//! `pi/led_driver/led_driver/{fpga_spi,spi}.py`. Pure (colours -> bytes), so it
//! is unit-tested without hardware, against the same vectors the Python encoder
//! tests pin.
//!
//! Two output backends, matching the Python driver:
//!   * the `spi_ws281x` FPGA (this module's top level): the Pi streams pixel
//!     data over SPI and the FPGA fans it out to N WS281x strips.
//!   * SK9822 / APA102 (the [`apa102`] submodule): the Pi drives the strip
//!     directly over SPI.

/// One pixel as `[r, g, b]`, 0..=255 per channel.
pub type Rgb = [u8; 3];

// ---------------------------------------------------------------------------
// spi_ws281x FPGA framing (port of fpga_spi.py)
//
// Wire protocol (matching fpga/spi_ws281x/{spi_ctrl,csr,ws281x_stream}.v):
//   * a transaction begins on CS-low with a 1-byte opcode;
//   * 0x01 WRITE_CSR: an address byte then value byte(s) (address auto-
//     increments). CSR 0x00 = num_ports (active outputs), 0x01 = led_type;
//   * 0x02 STREAM: the rest is pixel data, round-robin across the ports —
//     byte i goes to port i mod num_ports. CS-high latches (WS reset pulse).
// ---------------------------------------------------------------------------

pub const OP_WRITE_CSR: u8 = 0x01;
pub const OP_STREAM: u8 = 0x02;
pub const CSR_NUM_PORTS: u8 = 0x00;
pub const CSR_LED_TYPE: u8 = 0x01;

/// WS2812: one byte is 8 bits * 1.25 us = 10 us on the wire.
pub const WS_BYTE_US: f64 = 10.0;

/// A colour order as a permutation of indices into `[r, g, b]`. WS2812 = GRB =
/// `[1, 0, 2]`. Matches the player core's `hw_color_order_perm` convention.
pub const GRB: [u8; 3] = [1, 0, 2];
/// The identity order (`[r, g, b]`).
pub const RGB_ORDER: [u8; 3] = [0, 1, 2];

/// One pixel in the strip's wire byte order (`order` permutes `[r, g, b]`).
pub fn to_wire(px: Rgb, order: [u8; 3]) -> [u8; 3] {
    [
        px[order[0] as usize],
        px[order[1] as usize],
        px[order[2] as usize],
    ]
}

/// Parse a colour-order string like `"GRB"` into an index permutation.
pub fn order_from_str(s: &str) -> Option<[u8; 3]> {
    let idx = |c| match c {
        'R' => Some(0u8),
        'G' => Some(1),
        'B' => Some(2),
        _ => None,
    };
    let mut it = s.chars();
    let a = idx(it.next()?)?;
    let b = idx(it.next()?)?;
    let c = idx(it.next()?)?;
    if it.next().is_some() {
        return None;
    }
    Some([a, b, c])
}

/// A WRITE_CSR transaction: opcode, start address, then value byte(s).
pub fn encode_csr(addr: u8, values: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + values.len());
    out.push(OP_WRITE_CSR);
    out.push(addr);
    out.extend_from_slice(values);
    out
}

/// WRITE_CSR transaction that sets the active port count.
pub fn set_num_ports(num_ports: u8) -> Vec<u8> {
    encode_csr(CSR_NUM_PORTS, &[num_ports])
}

/// A STREAM transaction for one frame across `port_frames.len()` ports.
///
/// `port_frames[p]` is port p's pixels. Each port's wire bytes are interleaved
/// round-robin (byte i -> port i mod N); shorter ports are zero-padded so every
/// port stays byte-aligned in the interleave.
pub fn encode_stream(port_frames: &[Vec<Rgb>], order: [u8; 3]) -> Vec<u8> {
    let port_bytes: Vec<Vec<u8>> = port_frames
        .iter()
        .map(|pf| {
            let mut v = Vec::with_capacity(pf.len() * 3);
            for &px in pf {
                v.extend_from_slice(&to_wire(px, order));
            }
            v
        })
        .collect();
    let width = port_bytes.iter().map(|pb| pb.len()).max().unwrap_or(0);

    let mut out = Vec::with_capacity(1 + width * port_bytes.len());
    out.push(OP_STREAM);
    for k in 0..width {
        for pb in &port_bytes {
            out.push(pb.get(k).copied().unwrap_or(0));
        }
    }
    out
}

/// Split a flat pixel list into `num_ports` contiguous per-port runs.
///
/// With `port_counts` the split follows those lengths (the driver's per-channel
/// topology); otherwise the pixels are divided as evenly as possible, with the
/// remainder going to the earliest ports.
pub fn split_ports(
    colors: &[Rgb],
    num_ports: usize,
    port_counts: Option<&[usize]>,
) -> Result<Vec<Vec<Rgb>>, String> {
    let counts: Vec<usize> = match port_counts {
        Some(pc) => {
            if pc.len() != num_ports {
                return Err(format!(
                    "port_counts has {} entries, expected {}",
                    pc.len(),
                    num_ports
                ));
            }
            pc.to_vec()
        }
        None => {
            let base = colors.len() / num_ports;
            let extra = colors.len() % num_ports;
            (0..num_ports)
                .map(|p| base + usize::from(p < extra))
                .collect()
        }
    };

    let mut out = Vec::with_capacity(num_ports);
    let mut i = 0usize;
    for c in counts {
        let end = (i + c).min(colors.len());
        let start = i.min(colors.len());
        out.push(colors[start..end].to_vec());
        i += c;
    }
    Ok(out)
}

/// SPI clock (Hz) that delivers ~`num_ports` bytes per WS byte-time.
///
/// The FPGA drains one byte per port per WS byte-time, so the aggregate byte
/// rate is `num_ports / ws_byte_us`; x8 for bits. Clocking much faster overflows
/// the per-port buffer; slower risks a mid-frame gap.
pub fn matched_speed_hz(num_ports: u32) -> u32 {
    (f64::from(num_ports) * 8.0 * 1_000_000.0 / WS_BYTE_US) as u32
}

/// Encodes the driver's per-frame colours into `spi_ws281x` transactions.
///
/// Reused across frames: [`configure`](FpgaCodec::configure) (the CSR write) is
/// sent once per frame at the driver's discretion, then
/// [`frame`](FpgaCodec::frame) / [`dark`](FpgaCodec::dark) produce a STREAM
/// transaction. Each is written via a separate SPI transfer so CS frames it.
#[derive(Clone, Debug)]
pub struct FpgaCodec {
    pub num_ports: usize,
    pub order: [u8; 3],
    pub port_counts: Option<Vec<usize>>,
}

impl FpgaCodec {
    pub fn new(
        num_ports: usize,
        order: [u8; 3],
        port_counts: Option<Vec<usize>>,
    ) -> Result<Self, String> {
        if num_ports < 1 {
            return Err(format!("num_ports must be >= 1, got {num_ports}"));
        }
        if let Some(pc) = &port_counts {
            if pc.len() != num_ports {
                return Err(format!(
                    "port_counts has {} entries, expected {}",
                    pc.len(),
                    num_ports
                ));
            }
        }
        Ok(Self {
            num_ports,
            order,
            port_counts,
        })
    }

    /// The CSR write that sets the active port count.
    pub fn configure(&self) -> Vec<u8> {
        set_num_ports(self.num_ports as u8)
    }

    /// A STREAM transaction for one flat frame of `colors`.
    pub fn frame(&self, colors: &[Rgb]) -> Vec<u8> {
        let ports = split_ports(colors, self.num_ports, self.port_counts.as_deref())
            .expect("port_counts validated at construction");
        encode_stream(&ports, self.order)
    }

    /// A STREAM transaction with every LED off.
    pub fn dark(&self, n: usize) -> Vec<u8> {
        self.frame(&vec![[0, 0, 0]; n])
    }
}

// ---------------------------------------------------------------------------
// SK9822 / APA102 framing (port of spi.py)
//
//   * start frame: 4 x 0x00
//   * per LED: 0xE0 | brightness5 then B, G, R (APA102 colour order)
//   * end frame: ceil(n/16) (min 4) x 0x00 — the SK9822 32-bit latch plus
//     enough extra clock to flush a long cascade.
// ---------------------------------------------------------------------------

pub mod apa102 {
    use super::Rgb;
    use std::collections::BTreeSet;

    fn brightness_byte(level: u8) -> Result<u8, String> {
        if level > 31 {
            return Err(format!("brightness must be 0..31, got {level}"));
        }
        Ok(0xE0 | level)
    }

    fn end_frame_len(n: usize) -> usize {
        // SK9822 needs a 32-bit end latch; long strips need ~n/16 extra clock.
        std::cmp::max(4, n.div_ceil(16))
    }

    /// Total framed length for `n` LEDs (start + LED frames + end).
    pub fn buffer_len(n: usize) -> usize {
        4 + 4 * n + end_frame_len(n)
    }

    /// Encode one hue-code frame: every LED lit with its OWN colour (the
    /// driver's normal frame path).
    pub fn frame_bytes_colors(colors: &[Rgb], brightness: u8) -> Result<Vec<u8>, String> {
        let bright = brightness_byte(brightness)?;
        let mut buf = Vec::with_capacity(buffer_len(colors.len()));
        buf.extend_from_slice(&[0, 0, 0, 0]); // start frame
        for &[r, g, b] in colors {
            buf.extend_from_slice(&[bright, b, g, r]); // APA102 order: B, G, R
        }
        buf.resize(buf.len() + end_frame_len(colors.len()), 0); // end frame
        Ok(buf)
    }

    /// Encode one frame: LEDs in `on_ids` lit with `color`/`brightness`, rest
    /// off (the dark/debug frame path).
    pub fn frame_bytes(
        on_ids: &BTreeSet<usize>,
        n: usize,
        color: Rgb,
        brightness: u8,
    ) -> Result<Vec<u8>, String> {
        let bright = brightness_byte(brightness)?;
        let [r, g, b] = color;
        let on_led = [bright, b, g, r];
        let off_led = [0xE0u8, 0, 0, 0]; // brightness 0, colour 0 -> dark
        let mut buf = Vec::with_capacity(buffer_len(n));
        buf.extend_from_slice(&[0, 0, 0, 0]); // start frame
        for i in 0..n {
            buf.extend_from_slice(if on_ids.contains(&i) { &on_led } else { &off_led });
        }
        buf.resize(buf.len() + end_frame_len(n), 0); // end frame
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::apa102;
    use super::*;
    use std::collections::BTreeSet;

    // ---- FPGA (spi_ws281x) framing ----

    #[test]
    fn pixel_wire_order_is_grb() {
        // logical RGB (10, 20, 30) -> wire GRB (20, 10, 30)
        assert_eq!(to_wire([10, 20, 30], GRB), [20, 10, 30]);
        assert_eq!(to_wire([10, 20, 30], RGB_ORDER), [10, 20, 30]);
        assert_eq!(order_from_str("GRB"), Some(GRB));
        assert_eq!(order_from_str("RGB"), Some(RGB_ORDER));
        assert_eq!(order_from_str("XYZ"), None);
        assert_eq!(order_from_str("GRBB"), None);
    }

    #[test]
    fn csr_num_ports_encoding() {
        assert_eq!(set_num_ports(2), vec![OP_WRITE_CSR, CSR_NUM_PORTS, 2]);
        assert_eq!(encode_csr(0x01, &[0xAA]), vec![0x01, 0x01, 0xAA]);
        assert_eq!(encode_csr(0x00, &[3, 4]), vec![0x01, 0x00, 3, 4]);
    }

    #[test]
    fn stream_round_robin_interleave() {
        // two ports, one pixel each: port0 red, port1 blue (GRB on the wire).
        let ports = vec![vec![[255u8, 0, 0]], vec![[0u8, 0, 255]]];
        // port0 wire = [0,255,0], port1 wire = [0,0,255]; interleave byte-by-byte
        let expected = vec![OP_STREAM, 0, 0, 255, 0, 0, 255];
        assert_eq!(encode_stream(&ports, GRB), expected);
    }

    #[test]
    fn stream_pads_short_ports() {
        // port0 has 2 px, port1 has 1 px -> port1 zero-padded to 6 bytes.
        let ports = vec![
            vec![[1u8, 2, 3], [4, 5, 6]],
            vec![[7u8, 8, 9]],
        ];
        // port0 wire (GRB): [2,1,3, 5,4,6]; port1 wire: [8,7,9] + pad [0,0,0]
        let expected = vec![
            OP_STREAM, //
            2, 8, // k=0
            1, 7, // k=1
            3, 9, // k=2
            5, 0, // k=3 (port1 padded)
            4, 0, // k=4
            6, 0, // k=5
        ];
        assert_eq!(encode_stream(&ports, GRB), expected);
    }

    #[test]
    fn split_ports_even_and_topology() {
        let colors: Vec<Rgb> = (0..5).map(|i| [i, i, i]).collect();
        // 5 across 2 ports -> [3, 2] (remainder to earliest)
        let ports = split_ports(&colors, 2, None).unwrap();
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].len(), 3);
        assert_eq!(ports[1].len(), 2);
        // explicit topology
        let ports = split_ports(&colors, 3, Some(&[1, 3, 1])).unwrap();
        assert_eq!(ports.iter().map(|p| p.len()).collect::<Vec<_>>(), [1, 3, 1]);
        // mismatched counts error
        assert!(split_ports(&colors, 2, Some(&[1, 1, 1])).is_err());
    }

    #[test]
    fn codec_configure_frame_dark() {
        let codec = FpgaCodec::new(2, GRB, None).unwrap();
        assert_eq!(codec.configure(), vec![OP_WRITE_CSR, CSR_NUM_PORTS, 2]);
        // two LEDs, split [1,1]: led0 red -> port0, led1 blue -> port1
        let frame = codec.frame(&[[255, 0, 0], [0, 0, 255]]);
        assert_eq!(frame, vec![OP_STREAM, 0, 0, 255, 0, 0, 255]);
        // dark: all zero payload, still one byte per port per k
        let dark = codec.dark(2);
        assert_eq!(dark[0], OP_STREAM);
        assert!(dark[1..].iter().all(|&b| b == 0));
        assert_eq!(dark.len(), 1 + 3 * 2); // 3 bytes/px * 1 px/port * 2 ports
        assert!(FpgaCodec::new(0, GRB, None).is_err());
    }

    #[test]
    fn matched_speed() {
        assert_eq!(matched_speed_hz(1), 800_000);
        assert_eq!(matched_speed_hz(8), 6_400_000);
    }

    // ---- APA102 / SK9822 framing ----

    #[test]
    fn apa102_buffer_len_and_end_frame() {
        assert_eq!(apa102::buffer_len(0), 4 + 0 + 4);
        assert_eq!(apa102::buffer_len(1), 4 + 4 + 4);
        assert_eq!(apa102::buffer_len(16), 4 + 64 + 4);
        assert_eq!(apa102::buffer_len(17), 4 + 68 + 4); // ceil(17/16)=2 -> max(4,2)=4
    }

    #[test]
    fn apa102_colors_frame_order_and_brightness() {
        let buf = apa102::frame_bytes_colors(&[[10, 20, 30]], 31).unwrap();
        // start(4) + [0xFF, B, G, R] + end(4)
        assert_eq!(&buf[0..4], &[0, 0, 0, 0]);
        assert_eq!(&buf[4..8], &[0xE0 | 31, 30, 20, 10]);
        assert_eq!(&buf[8..], &[0, 0, 0, 0]);
        assert_eq!(buf.len(), apa102::buffer_len(1));
        assert!(apa102::frame_bytes_colors(&[[0, 0, 0]], 32).is_err());
    }

    #[test]
    fn apa102_subset_frame() {
        let on: BTreeSet<usize> = [1].into_iter().collect();
        let buf = apa102::frame_bytes(&on, 2, [255, 255, 255], 31).unwrap();
        assert_eq!(&buf[0..4], &[0, 0, 0, 0]); // start
        assert_eq!(&buf[4..8], &[0xE0, 0, 0, 0]); // led0 off
        assert_eq!(&buf[8..12], &[0xE0 | 31, 255, 255, 255]); // led1 on
        assert_eq!(buf.len(), apa102::buffer_len(2));
    }
}
