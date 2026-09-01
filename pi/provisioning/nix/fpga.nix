# FPGA (Tang Nano 9K / spi_ws281x) self-commissioning for the LED Mapper DUT.
#
# The Tang Nano's USB-JTAG is plugged into the Pi (the DUT), so the DUT flashes
# its own FPGA from the bitstream shipped in this image — no external flasher.
# The player service (apps.nix) loads the bitstream in an ExecStartPre BEFORE it
# opens SPI, so a fresh deploy always drives a matching, versioned gateware.
#
# This module provides the system-side pieces: openFPGALoader on the image and a
# udev rule giving the Tang Nano a stable dev node + libusb access. The actual
# `openFPGALoader` invocation is wired into the led-driver unit in apps.nix.
{ pkgs, ... }:
{
  # Flasher for the commission step (and for hands-on debugging over ssh).
  environment.systemPackages = [ pkgs.openfpgaloader ];

  # Tang Nano 9K on-board debugger is an FTDI FT2232C/D (VID:PID 0403:6010).
  # Give it a stable node (/dev/tangnano9k) and open access so the commission
  # step (and openFPGALoader generally) can claim it over libusb. `uaccess` +
  # the dialout group cover both root (ExecStartPre=+) and interactive use.
  # NOTE: confirm idVendor/idProduct against `lsusb` on the DUT — some Tang Nano
  # revisions use a BL702 (33aa:0120) instead of the FT2232.
  services.udev.extraRules = ''
    SUBSYSTEM=="usb", ATTR{idVendor}=="0403", ATTR{idProduct}=="6010", \
      MODE="0660", GROUP="dialout", TAG+="uaccess", SYMLINK+="tangnano9k"
  '';
}
