//! Real-hardware output sink: the Linux spidev bus (`/dev/spidev<bus>.<device>`).
//!
//! The FPGA (spi_ws281x) and SK9822 both take framed bytes over SPI mode 0; the
//! FPGA path clocks rate-matched to the WS drain (see `wire::matched_speed_hz`).
//! Lives in the binary crate so the pure render library stays free of the
//! Linux-only `spidev` dependency.

use ledmapper_player_rs::render::Sink;
use spidev::{SpiModeFlags, Spidev, SpidevOptions};
use std::io::Write;

pub struct SpidevSink {
    spi: Spidev,
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
        Ok(Self { spi })
    }
}

impl Sink for SpidevSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.spi.write_all(data)
    }
}
