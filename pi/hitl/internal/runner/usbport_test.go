package runner

import (
	"os"
	"path/filepath"
	"testing"
)

// resolveUSBPort must follow a serial tty's sysfs `device` link and walk up to the
// enclosing usb_device (the dir carrying busnum), returning its stable physical
// port id — the handle that survives the board's re-enumerations, unlike the
// devnum. Build a fake sysfs tree so this runs without hardware.
func TestResolveUSBPortWalksToUSBDevice(t *testing.T) {
	base := t.TempDir()
	usbDev := filepath.Join(base, "sys", "devices", "pci", "usb1", "1-2")
	iface := filepath.Join(usbDev, "1-2:1.0") // the CDC-ACM interface, one level below
	if err := os.MkdirAll(iface, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, val := range map[string]string{"busnum": "3\n", "devnum": "77\n", "dev": "189:76\n"} {
		if err := os.WriteFile(filepath.Join(usbDev, name), []byte(val), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	classTTY := filepath.Join(base, "class", "tty")
	if err := os.MkdirAll(filepath.Join(classTTY, "ttyACM0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(iface, filepath.Join(classTTY, "ttyACM0", "device")); err != nil {
		t.Fatal(err)
	}

	old := sysClassTTY
	sysClassTTY = classTTY
	defer func() { sysClassTTY = old }()

	portDir, portID, err := resolveUSBPort("/dev/ttyACM0")
	if err != nil {
		t.Fatalf("resolveUSBPort: %v", err)
	}
	if portID != "1-2" {
		t.Errorf("portID = %q, want %q", portID, "1-2")
	}
	n, err := readUSBNode(portDir)
	if err != nil {
		t.Fatalf("readUSBNode: %v", err)
	}
	if want := (usbNode{busnum: 3, devnum: 77, major: 189, minor: 76}); n != want {
		t.Errorf("readUSBNode = %+v, want %+v", n, want)
	}
}

// A tty whose sysfs chain has no usb_device ancestor (not a USB device) yields an
// error, so isolateUSB falls back to the whole-bus mount instead of silently
// isolating nothing.
func TestResolveUSBPortNonUSB(t *testing.T) {
	base := t.TempDir()
	leaf := filepath.Join(base, "sys", "devices", "platform", "serial0")
	if err := os.MkdirAll(leaf, 0o755); err != nil {
		t.Fatal(err)
	}
	classTTY := filepath.Join(base, "class", "tty")
	if err := os.MkdirAll(filepath.Join(classTTY, "ttyS0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(leaf, filepath.Join(classTTY, "ttyS0", "device")); err != nil {
		t.Fatal(err)
	}
	old := sysClassTTY
	sysClassTTY = classTTY
	defer func() { sysClassTTY = old }()

	if _, _, err := resolveUSBPort("/dev/ttyS0"); err == nil {
		t.Fatal("resolveUSBPort should error for a non-USB tty")
	}
}

// syncUSBNodes reconciles the private tree to hold exactly the reserved board's
// node, and — crucially — prunes the previous node when the board re-enumerates to
// a new devnum. Stub mknod (real device nodes need root) with a plain file so the
// path/prune logic is testable.
func TestSyncUSBNodesReenumerates(t *testing.T) {
	var made []int
	old := mknodChar
	mknodChar = func(path string, dev int) error {
		made = append(made, dev)
		return os.WriteFile(path, nil, 0o644)
	}
	defer func() { mknodChar = old }()

	dest := t.TempDir()

	if err := syncUSBNodes(dest, usbNode{busnum: 3, devnum: 77, major: 189, minor: 76}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "003", "077")); err != nil {
		t.Errorf("seeded node 003/077 missing: %v", err)
	}
	if len(made) != 1 || made[0] != makedev(189, 76) {
		t.Errorf("mknod calls = %v, want one for %d", made, makedev(189, 76))
	}

	// Board resets: same port, new devnum + minor. The stale node must be gone and
	// only the new one present — the whole point of surviving re-enumeration.
	if err := syncUSBNodes(dest, usbNode{busnum: 3, devnum: 81, major: 189, minor: 84}); err != nil {
		t.Fatalf("resync: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "003", "077")); !os.IsNotExist(err) {
		t.Errorf("stale node 003/077 not pruned (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "003", "081")); err != nil {
		t.Errorf("new node 003/081 missing: %v", err)
	}

	// A bus change prunes the old bus dir entirely.
	if err := syncUSBNodes(dest, usbNode{busnum: 4, devnum: 5, major: 189, minor: 90}); err != nil {
		t.Fatalf("resync bus: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "003")); !os.IsNotExist(err) {
		t.Errorf("stale bus dir 003 not pruned (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "004", "005")); err != nil {
		t.Errorf("new node 004/005 missing: %v", err)
	}

	// Board unplugged for good: clear the tree so no stale node lingers.
	if err := clearUSBNodes(dest); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if entries, _ := os.ReadDir(dest); len(entries) != 0 {
		t.Errorf("clearUSBNodes left %d entries", len(entries))
	}
}

// reservedTTYNode picks the DUT's pinned serial tty (the device mapped to
// /dev/ttyACM0) and resolves it through the by-id symlink — that node is what we
// anchor the USB-port lookup on.
func TestReservedTTYNode(t *testing.T) {
	dir := resolvedTempDir(t)
	node := filepath.Join(dir, "ttyACM3")
	if err := os.WriteFile(node, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	byID := filepath.Join(dir, "usb-Espressif_USB_JTAG_serial_debug_unit_60:55:F9:11:7D:10-if00")
	if err := os.Symlink(node, byID); err != nil {
		t.Fatal(err)
	}
	dev := Device{Name: "c6-0", Devices: []string{byID + ":/dev/ttyACM0"}}
	if got := reservedTTYNode(dev); got != node {
		t.Errorf("reservedTTYNode = %q, want resolved %q", got, node)
	}
	if got := reservedTTYNode(Device{Name: "empty"}); got != "" {
		t.Errorf("reservedTTYNode with no devices = %q, want \"\"", got)
	}
}

// makedev must match the kernel/glibc encoding so the node we create carries the
// major:minor libusb expects from sysfs.
func TestMakedev(t *testing.T) {
	if got := makedev(189, 76); got != 189<<8|76 {
		t.Errorf("makedev(189,76) = %d, want %d", got, 189<<8|76)
	}
	// Minor >= 256 spills into the high bits, not on top of the major.
	if got := makedev(189, 300); got != (189<<8)|(300&0xff)|((300&^0xff)<<12) {
		t.Errorf("makedev(189,300) = %d, want %d", got, (189<<8)|(300&0xff)|((300&^0xff)<<12))
	}
}
