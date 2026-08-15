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
