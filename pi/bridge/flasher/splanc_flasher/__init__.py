"""Splanc Bridge Flasher engine (pi/bridge/README.md, "The flasher").

    releases   find the newest pi-bridge-v* image for a board; download, verify, unpack
    disks      removable disks only (the safety boundary)
    flash      elevated raw write + read-back, then the settings on the boot partition
    bootfiles  render the WiFi profile / settings files the image applies at boot
    rawwrite   the tiny privileged worker
    elevate    wrap the worker in the OS's admin prompt

Adapted from td-deploy Studio's flasher (github.com/fughilli/td-deploy, MIT).
stdlib only (+ certifi in the frozen app; zstd from Python 3.14 or `zstandard`).
"""
