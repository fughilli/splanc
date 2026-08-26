# FPGA self-commissioning (Tang Nano 9K / spi_ws281x)

The DUT flashes its own FPGA over USB-JTAG before the player opens SPI, so a
deploy always drives matching, versioned gateware (see ../fpga.nix + ../apps.nix
`fpgaCommission`).

The bitstream is **Bazel-built, not committed**. apps.nix prefers
`SBC_FPGA_BITSTREAM` (an absolute path read under `--impure`) and otherwise falls
back to `./spi_ws281x.fs` here. Refresh it after any RTL change under
//fpga/spi_ws281x and redeploy:

    bazel build //fpga/spi_ws281x:spi_ws281x_tangnano9k
    cp bazel-bin/fpga/spi_ws281x/spi_ws281x_tangnano9k.fs \
       pi/provisioning/nix/fpga/spi_ws281x.fs
    bazel run //pi/provisioning:update -- <host> --hostname <name>

TODO (the clean data dependency): teach sbc-deploy's `sbc_application` to take an
`fpga_bitstream` label, add it to the deploy target's data, and export its
runfiles path as `SBC_FPGA_BITSTREAM` in the same env passthrough that already
carries `SBC_DEPLOY_PUBKEY_FILE` to the `--impure` eval. Then a single
`bazel run …:update` builds + injects the gateware — no copy, no gitignored file.
