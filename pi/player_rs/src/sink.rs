//! Real-hardware output sink: the Linux spidev bus (`/dev/spidev<bus>.<device>`).
//!
//! The FPGA (spi_ws281x) and SK9822 both take framed bytes over SPI mode 0; the
//! FPGA path clocks rate-matched to the WS drain (see `wire::matched_speed_hz`).
//! Lives in the binary crate so the pure render library stays free of the
//! Linux-only `spidev` dependency.

use ledmapper_player_rs::render::Sink;
use spidev::{SpiModeFlags, Spidev, SpidevOptions, SpidevTransfer};
use std::io::Write;

pub struct SpidevSink {
    spi: Spidev,
    /// Set once a combined message hit EMSGSIZE: send two writes from then on.
    split: bool,
}

impl SpidevSink {
    pub fn open(bus: u8, device: u8, max_speed_hz: u32) -> std::io::Result<Self> {
        let mut spi = Spidev::open(format!("/dev/spidev{bus}.{device}"))?;
        let opts = SpidevOptions::new()
            .bits_per_word(8)
            .max_speed_hz(max_speed_hz)
            .mode(SpiModeFlags::SPI_MODE_0)
            .build();
        spi.configure(&opts)?;
        Ok(Self { spi, split: false })
    }
}

impl Sink for SpidevSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.spi.write_all(data)
    }

    /// CSR + STREAM as ONE `SPI_IOC_MESSAGE(2)`: a single syscall, so the
    /// frame-done-to-STREAM latency doesn't include a second kernel entry.
    /// `cs_change` on the first transfer deasserts CS between them (the spi
    /// core's default ~10 us CS-high), so the FPGA still sees two transactions.
    ///
    /// spidev checks a message against `bufsiz` with each transfer rounded up to
    /// ARCH_DMA_MINALIGN (128 B on arm64), so the pair needs
    /// `128 + align128(stream) <= bufsiz`: 3,968 B of STREAM at the default 4096,
    /// any 20 x 1024 frame at MAX's 65536. On EMSGSIZE it falls back to two
    /// writes (each only needs `len <= bufsiz`) for good, logging once.
    fn write_frame(&mut self, config: &[u8], stream: &[u8]) -> std::io::Result<()> {
        if !self.split {
            let mut csr = SpidevTransfer::write(config);
            csr.cs_change = 1;
            let data = SpidevTransfer::write(stream);
            match self.spi.transfer_multiple(&mut [csr, data]) {
                Err(e) if e.raw_os_error() == Some(libc_emsgsize()) => {
                    eprintln!(
                        "player_rs: spidev: {} B CSR+STREAM message exceeds bufsiz ({e}); \
                         sending CSR and STREAM as two writes",
                        config.len() + stream.len()
                    );
                    self.split = true;
                }
                r => return r,
            }
        }
        self.write(config)?;
        self.write(stream)
    }
}

/// EMSGSIZE (90 on every Linux arch the player targets).
const fn libc_emsgsize() -> i32 {
    90
}
