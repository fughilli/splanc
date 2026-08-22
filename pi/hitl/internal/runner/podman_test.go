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
// a USB path AND is UP, ignoring the onboard (UART/platform) one and a
// present-but-DOWN dongle, and returns "" when none qualifies. hci entries are
// sorted so the pick is deterministic.
func TestResolveUSBHCI(t *testing.T) {
	mkHCI := func(root, name, target string) {
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
		hci := filepath.Join(root, name)
		if err := os.MkdirAll(hci, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(hci, "device")); err != nil {
			t.Fatal(err)
		}
	}
	allUp := func(int) bool { return true }

	// Onboard UART hci0 + a USB dongle hci1 that is UP → pick hci1.
	root := resolvedTempDir(t)
	mkHCI(root, "hci0", filepath.Join(root, "_serial", "serial0-0", "bluetooth", "hci0"))
	mkHCI(root, "hci1", filepath.Join(root, "_usb", "usb3", "3-1", "3-1:1.0", "bluetooth", "hci1"))
	if got := resolveUSBHCIIn(root, allUp); got != "hci1" {
		t.Errorf("resolveUSBHCIIn = %q, want \"hci1\" (the UP USB controller)", got)
	}

	// Same topology but the USB dongle is DOWN (firmware not loaded) → fall back to
	// "" so the caller uses the onboard default rather than a dead adapter.
	downUSB := func(id int) bool { return id != 1 } // hci1 (the dongle) is down
	if got := resolveUSBHCIIn(root, downUSB); got != "" {
		t.Errorf("resolveUSBHCIIn with a DOWN dongle = %q, want \"\" (fall back)", got)
	}

	// No USB controller at all → "".
	onlyUART := resolvedTempDir(t)
	mkHCI(onlyUART, "hci0", filepath.Join(onlyUART, "_serial", "bluetooth", "hci0"))
	if got := resolveUSBHCIIn(onlyUART, allUp); got != "" {
		t.Errorf("resolveUSBHCIIn with no USB controller = %q, want \"\"", got)
	}
}
