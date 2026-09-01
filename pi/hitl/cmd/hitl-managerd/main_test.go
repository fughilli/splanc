package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/analyzer"
	"github.com/fughilli/splanc/pi/hitl/internal/metrics"
	"github.com/fughilli/splanc/pi/hitl/internal/queue"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

// capListHas reports whether a capability list contains s.
func capListHas(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// withCaps merges the rig-wiring logic-analyzer capability onto a DUT that the
// shared analyzer taps (an explicit channel-map entry), and only that DUT — so a
// mixed rig distinguishes its analyzer DUT from plain ones. The capability is
// GRANULAR by the tapped signal: a ws2812 tap on the strip yields
// logic-analyzer-led-strip, an spi tap yields logic-analyzer-spi. A nil broker (no
// analyzer on the rig) never adds it.
func TestWithCapsMergesLogicAnalyzer(t *testing.T) {
	brk := analyzer.New(analyzer.Config{
		Driver: "fx2lafw",
		Map: map[string]analyzer.DUTMap{
			"c6-la":  {Channels: []string{"D1"}, Protocol: analyzer.ProtocolWS2812},
			"pi-spi": {Channels: []string{"D0", "D1"}, Protocol: analyzer.ProtocolSPI},
		},
	})
	if la := withCaps(runner.Device{Name: "c6-la", SKU: "esp32c6"}, brk); !capListHas(la.Capabilities, "logic-analyzer-led-strip") {
		t.Errorf("ws2812-tapped DUT should advertise logic-analyzer-led-strip, got %v", la.Capabilities)
	}
	if spi := withCaps(runner.Device{Name: "pi-spi", SKU: "led-mapper-pi"}, brk); !capListHas(spi.Capabilities, "logic-analyzer-spi") {
		t.Errorf("spi-tapped DUT should advertise logic-analyzer-spi, got %v", spi.Capabilities)
	}
	// The granular cap is exclusive: a strip tap is not an spi tap.
	if la := withCaps(runner.Device{Name: "c6-la", SKU: "esp32c6"}, brk); capListHas(la.Capabilities, "logic-analyzer-spi") {
		t.Errorf("ws2812-tapped DUT must not advertise logic-analyzer-spi, got %v", la.Capabilities)
	}
	if plain := withCaps(runner.Device{Name: "c6-plain", SKU: "esp32c6"}, brk); capListHas(plain.Capabilities, "logic-analyzer-led-strip") {
		t.Errorf("un-tapped DUT must not advertise a logic-analyzer cap, got %v", plain.Capabilities)
	}
	if none := withCaps(runner.Device{Name: "c6-la", SKU: "esp32c6"}, nil); capListHas(none.Capabilities, "logic-analyzer-led-strip") {
		t.Errorf("nil broker must not add a logic-analyzer cap, got %v", none.Capabilities)
	}
}

// writeMetrics emits every configured metric family with the rig label, a
// per-DUT busy series, and omits any host metric whose source was unreadable.
func TestWriteMetrics(t *testing.T) {
	snap := queue.MetricsSnapshot{
		Rig: "rig-1", LeaseSeconds: 1800,
		DUTsTotal: 2, DUTsBusy: 1, QueueDepth: 3, ActiveTotal: 1,
		Devices: []queue.DeviceMetric{{Name: "c6-a", Busy: true}, {Name: "c6-b", Busy: false}},
		Reservations: 10, Activations: 8, Releases: 7, LeaseExpiries: 2, StartFailures: 1,
	}
	host := metrics.HostStats{Load1: 0.5, Load1OK: true, TempCelsius: 46.7, TempOK: true} // MemOK false

	var b strings.Builder
	writeMetrics(&b, snap, host)
	out := b.String()

	for _, want := range []string{
		`hitl_up{rig="rig-1"} 1`,
		`hitl_duts_total{rig="rig-1"} 2`,
		`hitl_queue_depth{rig="rig-1"} 3`,
		`hitl_dut_busy{device="c6-a",rig="rig-1"} 1`,
		`hitl_dut_busy{device="c6-b",rig="rig-1"} 0`,
		`hitl_reservations_total{rig="rig-1"} 10`,
		`hitl_lease_expirations_total{rig="rig-1"} 2`,
		`hitl_host_load1{rig="rig-1"} 0.5`,
		`hitl_host_temperature_celsius{rig="rig-1"} 46.7`,
		"# TYPE hitl_reservations_total counter",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics output missing %q\n---\n%s", want, out)
		}
	}
	// Memory source was unreadable (MemOK false), so those series are omitted, not
	// reported as a misleading zero.
	if strings.Contains(out, "hitl_host_memory_total_bytes") {
		t.Errorf("memory metric should be omitted when MemOK is false:\n%s", out)
	}
}

// With no --dut flags, buildDevices synthesizes one DUT from the legacy
// --ssh-port/--device flags — preserving the original single-DUT behavior.
func TestBuildDevicesLegacyFallback(t *testing.T) {
	got, err := buildDevices(nil, 2222, []string{"/dev/ttyACM0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The legacy USB DUT is an ESP32-C6; it gets that SKU and the registry's caps.
	want := []runner.Device{{
		Name:         "dut0",
		SKU:          "esp32c6",
		Capabilities: []string{"flash", "improv", "jtag", "led-strip", "wss-app"},
		SSHPort:      2222,
		Devices:      []string{"/dev/ttyACM0"},
	}}
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
	got, err := buildDevices(duts, 2222, nil, nil)
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
		if _, err := buildDevices(duts, 2222, nil, nil); err == nil {
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

// The monitor keeps a board's sshd port sticky across scans and retains a board
// that blinks out (a resetting DUT re-enumerates) until it's been absent for the
// whole retention window — only then dropping it, while never renumbering the
// board that stayed.
func TestDutMonitorStickyPortsAndRetention(t *testing.T) {
	dir := t.TempDir()
	linkOf := func(name string) string { return filepath.Join(dir, name) }
	mk := func(name, target string) {
		tp := filepath.Join(dir, target)
		if err := os.WriteFile(tp, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(tp, linkOf(name)); err != nil {
			t.Fatal(err)
		}
	}
	nameA := "usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00"
	mk(nameA, "ttyA")
	mk("usb-Espressif_USB_JTAG_serial_debug_unit_BBBBBB-if00", "ttyB")

	dm := newDUTMonitor(filepath.Join(dir, "usb-*-if00"), 2222, 8, 30*time.Second, "", 0, nil)
	clock := time.Unix(0, 0)
	dm.now = func() time.Time { return clock }

	first, err := dm.scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Name != "c6-aaaaaa" || first[0].SSHPort != 2222 || first[1].SSHPort != 2223 {
		t.Fatalf("first scan = %+v", first)
	}

	// Board A models a reboot loop: gone for a few short scans well inside the
	// retention window. It must stay present (its reservation must not drop).
	if err := os.Remove(linkOf(nameA)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		clock = clock.Add(3 * time.Second) // 15s total, < 30s retention
		if blip, _ := dm.scan(); len(blip) != 2 {
			t.Fatalf("resetting board dropped too early at %s: %+v", clock.Sub(time.Unix(0, 0)), blip)
		}
	}
	// It re-enumerates (as it does after each reset) and keeps its port.
	mk(nameA, "ttyA2")
	if back, _ := dm.scan(); len(back) != 2 || back[0].SSHPort != 2222 {
		t.Fatalf("recovered board should keep its port, got %+v", back)
	}

	// Now truly unplugged: absent past the retention window → dropped, while B
	// keeps its original port 2223.
	if err := os.Remove(linkOf(nameA)); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(31 * time.Second)
	last, _ := dm.scan()
	if len(last) != 1 || last[0].Name != "c6-bbbbbb" || last[0].SSHPort != 2223 {
		t.Fatalf("after sustained absence, scan = %+v (B should remain on 2223)", last)
	}
}

// A channel-map change AFTER a USB board is first discovered must be reflected in
// that board's capabilities on the next scan — a newly-tapped DUT gains its
// logic-analyzer-* cap and an un-tapped one loses it — WITHOUT a daemon restart.
// Regression: the monitor used to cache a board's caps at first sight and skip
// recompute for known boards, so a runtime SetMap (or the map settling after
// discovery) never propagated, and led_capture reservations found no tapped DUT.
func TestDutMonitorRecomputesCapsOnMapChange(t *testing.T) {
	dir := t.TempDir()
	tp := filepath.Join(dir, "ttyA")
	if err := os.WriteFile(tp, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(tp, filepath.Join(dir, "usb-Espressif_USB_JTAG_serial_debug_unit_AAAAAA-if00")); err != nil {
		t.Fatal(err)
	}
	const board = "c6-aaaaaa"

	// Broker is enabled (present defaults true in tests) but starts with an empty
	// map, so the board is un-tapped at first discovery.
	brk := analyzer.New(analyzer.Config{Driver: "fx2lafw"})
	dm := newDUTMonitor(filepath.Join(dir, "usb-*-if00"), 2222, 8, 30*time.Second, "", 0, brk)

	first, err := dm.scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[0].Name != board {
		t.Fatalf("first scan = %+v", first)
	}
	if capListHas(first[0].Capabilities, "logic-analyzer-led-strip") {
		t.Fatalf("un-tapped board should advertise no analyzer cap, got %v", first[0].Capabilities)
	}

	// Tap it at runtime. The next scan (board already known) must re-derive caps.
	if err := brk.SetMap(map[string]analyzer.DUTMap{
		board: {Channels: []string{"D6"}, Protocol: analyzer.ProtocolWS2812},
	}); err != nil {
		t.Fatal(err)
	}
	tapped, _ := dm.scan()
	if len(tapped) != 1 || !capListHas(tapped[0].Capabilities, "logic-analyzer-led-strip") {
		t.Fatalf("after tapping via SetMap, known board should gain logic-analyzer-led-strip, got %+v", tapped)
	}

	// Un-tap it again; the cap must drop on the next scan (not stay stale-high).
	if err := brk.SetMap(map[string]analyzer.DUTMap{}); err != nil {
		t.Fatal(err)
	}
	untapped, _ := dm.scan()
	if len(untapped) != 1 || capListHas(untapped[0].Capabilities, "logic-analyzer-led-strip") {
		t.Fatalf("after un-tapping via SetMap, board should lose the analyzer cap, got %+v", untapped)
	}
}

func TestReadNetworkDUTs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "network-duts.json")
	// USB pool [2222,2230); network range starts at 2222+8 = 2230.
	dm := newDUTMonitor("/nonexistent/*", 2222, 8, 30*time.Second, path, 4, nil)

	// Absent file: no DUTs, no error (and it forgets any prior set).
	if got, err := dm.readNetworkDUTs(); err != nil || got != nil {
		t.Fatalf("absent file: got %+v err %v", got, err)
	}

	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// One valid network DUT → port from the dedicated range, kind + env carried,
	// and its SKU's capabilities resolved from the registry.
	write(`[{"name":"pi-1","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"pi.local"}}]`)
	got, err := dm.readNetworkDUTs()
	if err != nil {
		t.Fatalf("valid: %v", err)
	}
	if len(got) != 1 || got[0].Name != "pi-1" || got[0].Kind != "network" || got[0].SSHPort != 2230 {
		t.Fatalf("valid single = %+v", got)
	}
	if got[0].Env["HITL_DUT_ADDR"] != "pi.local" {
		t.Fatalf("env not carried: %+v", got[0].Env)
	}
	if got[0].SKU != "led-mapper-pi" || !reflect.DeepEqual(got[0].Capabilities, []string{"improv", "led-strip", "spi-fpga", "wss-app"}) {
		t.Fatalf("SKU/caps not resolved from registry: sku=%q caps=%v", got[0].SKU, got[0].Capabilities)
	}

	// Sticky port: add a second DUT; pi-1 keeps 2230, pi-2 gets a distinct port.
	write(`[{"name":"pi-2","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"b"}},
	        {"name":"pi-1","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"a"}}]`)
	got, _ = dm.readNetworkDUTs()
	ports := map[string]int{}
	for _, d := range got {
		ports[d.Name] = d.SSHPort
	}
	if ports["pi-1"] != 2230 {
		t.Fatalf("pi-1 should keep its sticky port 2230, got %d", ports["pi-1"])
	}
	if ports["pi-2"] < 2230 || ports["pi-2"] == 2230 {
		t.Fatalf("pi-2 should get a distinct network port, got %d", ports["pi-2"])
	}

	// Every invalid file returns an error (caller keeps the last good set).
	for _, bad := range []string{
		// bad name prefix
		`[{"name":"c6-x","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"a"}}]`,
		// wrong kind
		`[{"name":"pi-x","kind":"usb","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"a"}}]`,
		// has devices
		`[{"name":"pi-x","kind":"network","sku":"led-mapper-pi","devices":["/dev/x"],"env":{"HITL_DUT_ADDR":"a"}}]`,
		// missing addr
		`[{"name":"pi-x","kind":"network","sku":"led-mapper-pi","devices":[],"env":{}}]`,
		// missing sku
		`[{"name":"pi-x","kind":"network","devices":[],"env":{"HITL_DUT_ADDR":"a"}}]`,
		// dup name
		`[{"name":"pi-x","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"a"}},{"name":"pi-x","kind":"network","sku":"led-mapper-pi","devices":[],"env":{"HITL_DUT_ADDR":"b"}}]`,
		// malformed
		`{not json`,
	} {
		write(bad)
		if _, err := dm.readNetworkDUTs(); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}
