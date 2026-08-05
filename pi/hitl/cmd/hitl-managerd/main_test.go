package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

// With no --dut flags, buildDevices synthesizes one DUT from the legacy
// --ssh-port/--device flags — preserving the original single-DUT behavior.
func TestBuildDevicesLegacyFallback(t *testing.T) {
	got, err := buildDevices(nil, 2222, []string{"/dev/ttyACM0"})
	if err != nil {
		t.Fatal(err)
	}
	want := []runner.Device{{Name: "dut0", SSHPort: 2222, Devices: []string{"/dev/ttyACM0"}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildDevices legacy = %+v, want %+v", got, want)
	}
}

// Multiple --dut flags parse into distinct DUTs with their own ports/nodes/env.
func TestBuildDevicesMultiDUT(t *testing.T) {
	duts := []string{
		`{"name":"c6-0","ssh_port":2222,"devices":["/dev/serial/by-id/a:/dev/ttyACM0"]}`,
		`{"name":"c6-1","ssh_port":2223,"devices":["/dev/serial/by-id/b:/dev/ttyACM0"],"env":{"HITL_ADAPTER_SERIAL":"XYZ"}}`,
	}
	got, err := buildDevices(duts, 2222, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 DUTs, got %d", len(got))
	}
	if got[0].Name != "c6-0" || got[0].SSHPort != 2222 || got[0].Devices[0] != "/dev/serial/by-id/a:/dev/ttyACM0" {
		t.Errorf("DUT0 wrong: %+v", got[0])
	}
	if got[1].SSHPort != 2223 || got[1].Env["HITL_ADAPTER_SERIAL"] != "XYZ" {
		t.Errorf("DUT1 wrong: %+v", got[1])
	}
}

// Misconfigurations that would collide two DUTs onto one port/name, or omit
// required fields, are rejected rather than silently accepted.
func TestBuildDevicesRejectsBadConfig(t *testing.T) {
	cases := map[string][]string{
		"duplicate port": {`{"name":"a","ssh_port":2222}`, `{"name":"b","ssh_port":2222}`},
		"duplicate name": {`{"name":"a","ssh_port":2222}`, `{"name":"a","ssh_port":2223}`},
		"missing name":   {`{"ssh_port":2222}`},
		"missing port":   {`{"name":"a"}`},
		"bad json":       {`{not json}`},
	}
	for name, duts := range cases {
		if _, err := buildDevices(duts, 2222, nil); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}

// Auto-discovery builds one board per by-id path: a stable serial-derived name,
// tty pinned to /dev/ttyACM0 in-container, sorted by name, and the Espressif
// USB-JTAG serial lifted into HITL_ADAPTER_SERIAL for per-board JTAG.
func TestBoardsFromByID(t *testing.T) {
	// Out of order to prove the output is sorted by the stable name, not input order.
	paths := []string{
		"/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_BBBBBB-if00",
		"/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00",
	}
	got := boardsFromByID(paths)
	want := []board{
		{name: "c6-aaaaaa", devices: []string{"/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00:/dev/ttyACM0"}, env: map[string]string{"HITL_ADAPTER_SERIAL": "AAAAAA"}},
		{name: "c6-bbbbbb", devices: []string{"/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_BBBBBB-if00:/dev/ttyACM0"}, env: map[string]string{"HITL_ADAPTER_SERIAL": "BBBBBB"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("boardsFromByID = %+v, want %+v", got, want)
	}
}

// Secondary interfaces of a composite device (…-if02) are skipped so one board
// doesn't spawn extra phantom DUTs; a non-Espressif adapter gets no JTAG serial.
func TestBoardsFromByIDFiltersAndSkipsSerial(t *testing.T) {
	paths := []string{
		"/dev/serial/by-id/usb-1a86_USB_Single_Serial_1234-if00",
		"/dev/serial/by-id/usb-1a86_USB_Single_Serial_1234-if02",
	}
	got := boardsFromByID(paths)
	if len(got) != 1 {
		t.Fatalf("want 1 board (primary interface only), got %d: %+v", len(got), got)
	}
	if got[0].env != nil {
		t.Errorf("non-Espressif adapter should carry no HITL_ADAPTER_SERIAL, got %v", got[0].env)
	}
}

func TestDutNameFromByIDStable(t *testing.T) {
	cases := map[string]string{
		// A C6's serial is its MAC; the name is the alnum tail, so it's stable and
		// shell-safe and independent of boot/enumeration order.
		"usb-Espressif_USB_JTAG_serial_debug_unit_54:32:04:07:12:34-if00": "c6-071234",
		"usb-1a86_USB_Single_Serial_1234-if00":                            "c6-al1234",
	}
	for base, want := range cases {
		if got := dutNameFromByID(base); got != want {
			t.Errorf("dutNameFromByID(%q) = %q, want %q", base, got, want)
		}
	}
}

func TestEspSerialFromByID(t *testing.T) {
	cases := map[string]string{
		"usb-Espressif_USB_JTAG_serial_debug_unit_54:32:04:07:12:34-if00": "54:32:04:07:12:34",
		"usb-1a86_USB_Single_Serial_1234-if00":                            "", // not Espressif
	}
	for base, want := range cases {
		if got := espSerialFromByID(base); got != want {
			t.Errorf("espSerialFromByID(%q) = %q, want %q", base, got, want)
		}
	}
}

// The monitor keeps a board's sshd port sticky across scans: unplugging one board
// must not renumber another (which would tear down its live reservation).
func TestDutMonitorStickyPorts(t *testing.T) {
	dir := t.TempDir()
	mk := func(name, target string) {
		tp := filepath.Join(dir, target)
		if err := os.WriteFile(tp, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(tp, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	mk("usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00", "ttyA")
	mk("usb-Espressif_USB_JTAG_serial_debug_unit_BBBBBB-if00", "ttyB")

	dm := newDUTMonitor(filepath.Join(dir, "usb-*-if00"), 2222, 8)
	first, err := dm.scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Name != "c6-aaaaaa" || first[0].SSHPort != 2222 || first[1].SSHPort != 2223 {
		t.Fatalf("first scan = %+v", first)
	}

	// Unplug board A (its symlink disappears). B must keep its original port 2223.
	if err := os.Remove(filepath.Join(dir, "usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00")); err != nil {
		t.Fatal(err)
	}
	second, err := dm.scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].Name != "c6-bbbbbb" || second[0].SSHPort != 2223 {
		t.Fatalf("after unplugging A, second scan = %+v (B should keep port 2223)", second)
	}
}
