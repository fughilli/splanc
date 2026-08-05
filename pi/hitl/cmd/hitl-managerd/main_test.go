package main

import (
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
