# FPGA self-commissioning (Tang Nano 9K / spi_ws281x)

The DUT flashes its own FPGA over USB-JTAG before the player opens SPI, so a
deploy always drives matching, versioned gateware (see ../fpga.nix + ../apps.nix).

`spi_ws281x.fs` is the vendored bitstream (gitignored, a build artifact). Rebuild
it after any RTL change under //fpga/spi_ws281x:

    bazel build //fpga/spi_ws281x:spi_ws281x_tangnano9k
    cp bazel-bin/fpga/spi_ws281x/spi_ws281x_tangnano9k.fs spi_ws281x.fs

Then redeploy: `bazel run //pi/provisioning:update -- <host> --hostname <name>`.
