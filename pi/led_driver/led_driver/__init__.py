"""spi_ws281x FPGA SPI framing (``fpga_spi``): the Python reference encoder the
HITL harness cross-checks the Rust player's raw SPI against
(//pi/hitl/harness:hitl_fpga_ws281x).

The Python M1 pattern driver that used to live here (graycode/driver/control/
spi) was retired: the Pi runs the Rust player (//pi/player_rs), and the hue code
has one implementation, the Rust kernel //firmware/pattern.
"""
