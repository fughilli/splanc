package runner

import (
	"os"
	"path/filepath"
	"testing"
)

// resolvedTempDir is t.TempDir() with symlinks resolved. deviceMapping /
// reservedTTYNode resolve their device paths through filepath.EvalSymlinks, and
// on macOS the temp root (/var/folders/…) is itself a symlink to /private/var/…,
// so comparing against the raw temp path would spuriously mismatch. On Linux the
// temp root has no symlinks, so this is a no-op.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// The by-id path of an ESP32-C6 embeds its MAC (…_60:55:F9:11:7D:10-if00), so the
// --device host path contains colons. deviceMapping must split on the container
// path (not the first colon), resolve the symlink to the real /dev node, and keep
// the requested in-container path — otherwise podman gets a truncated, non-device
// path and the board silently never appears in the container.
func TestDeviceMappingResolvesColonByIDSymlink(t *testing.T) {
	dir := resolvedTempDir(t)
	node := filepath.Join(dir, "ttyACM0") // stand-in for the real /dev node
	if err := os.WriteFile(node, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	byID := filepath.Join(dir, "usb-Espressif_USB_JTAG_serial_debug_unit_60:55:F9:11:7D:10-if00")
	if err := os.Symlink(node, byID); err != nil {
		t.Fatal(err)
	}

	arg, ok := deviceMapping(byID + ":/dev/ttyACM0")
	if !ok {
		t.Fatal("deviceMapping should resolve a present by-id symlink")
	}
	if want := node + ":/dev/ttyACM0"; arg != want {
		t.Errorf("deviceMapping = %q, want %q (resolved node + in-container path)", arg, want)
	}
}

// A bare device path (no container mapping) resolves through, and a missing
// device is skipped so a reservation can still come up with no board attached.
func TestDeviceMappingBareAndMissing(t *testing.T) {
	dir := resolvedTempDir(t)
	node := filepath.Join(dir, "ttyACM0")
	if err := os.WriteFile(node, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if arg, ok := deviceMapping(node); !ok || arg != node {
		t.Errorf("bare present device = (%q, %v), want (%q, true)", arg, ok, node)
	}
	if _, ok := deviceMapping(filepath.Join(dir, "absent") + ":/dev/ttyACM0"); ok {
		t.Error("a missing host device must be skipped (ok=false)")
	}
}

// resolveBLEAdapter maps the configured value to a concrete adapter: "" and a
// literal "hciN" pass through unchanged (no sysfs lookup).
func TestResolveBLEAdapterLiteral(t *testing.T) {
	if got := (&PodmanRunner{cfg: PodmanConfig{BLEAdapter: ""}}).resolveBLEAdapter(); got != "" {
		t.Errorf("empty BLEAdapter = %q, want \"\"", got)
	}
	if got := (&PodmanRunner{cfg: PodmanConfig{BLEAdapter: "hci1"}}).resolveBLEAdapter(); got != "hci1" {
		t.Errorf("literal BLEAdapter = %q, want \"hci1\"", got)
	}
}

// resolveUSBHCIIn picks the Bluetooth controller whose device symlink resolves to
// a USB path, ignoring the onboard (UART/platform) one, and returns "" when none
// is on USB. hci entries are sorted so the pick is deterministic.
func TestResolveUSBHCI(t *testing.T) {
	root := resolvedTempDir(t)
	// Fake sysfs: an onboard UART controller (hci0) and a USB dongle (hci1).
	uartDev := filepath.Join(root, "_serial", "serial0-0", "bluetooth", "hci0")
	usbDev := filepath.Join(root, "_usb", "usb3", "3-1", "3-1:1.0", "bluetooth", "hci1")
	for _, d := range []string{uartDev, usbDev} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mkHCI := func(name, target string) {
		hci := filepath.Join(root, name)
		if err := os.MkdirAll(hci, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(hci, "device")); err != nil {
			t.Fatal(err)
		}
	}
	mkHCI("hci0", uartDev)
	mkHCI("hci1", usbDev)
	if got := resolveUSBHCIIn(root); got != "hci1" {
		t.Errorf("resolveUSBHCIIn = %q, want \"hci1\" (the USB controller)", got)
	}

	// With no USB controller, it returns "" (caller falls back to the default).
	onlyUART := resolvedTempDir(t)
	d := filepath.Join(onlyUART, "_serial", "bluetooth", "hci0")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	hci := filepath.Join(onlyUART, "hci0")
	if err := os.MkdirAll(hci, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(d, filepath.Join(hci, "device")); err != nil {
		t.Fatal(err)
	}
	if got := resolveUSBHCIIn(onlyUART); got != "" {
		t.Errorf("resolveUSBHCIIn with no USB controller = %q, want \"\"", got)
	}
}
