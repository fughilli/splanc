package skus

import (
	"reflect"
	"testing"
)

func TestCapabilitiesResolveFromRegistry(t *testing.T) {
	// esp32c6 has the full board caps; the Pi carries improv + the FPGA output
	// path (led-strip + spi-fpga). Neither lists any logic-analyzer-* cap — that's
	// per-DUT instrumentation the daemon adds from the analyzer broker, not a SKU
	// trait.
	if got := Capabilities("esp32c6"); !contains(got, "improv") || !contains(got, "jtag") {
		t.Errorf("esp32c6 caps = %v, want improv+jtag present", got)
	}
	if got := Capabilities("led-mapper-pi"); !reflect.DeepEqual(got, []string{"improv", "led-strip", "spi-fpga", "wss-app"}) {
		t.Errorf("led-mapper-pi caps = %v, want [improv led-strip spi-fpga wss-app]", got)
	}
	for _, sku := range []string{"esp32c6", "led-mapper-pi"} {
		for _, c := range Capabilities(sku) {
			if len(c) >= 15 && c[:15] == "logic-analyzer-" {
				t.Errorf("%s must not carry instrumentation cap %q from the SKU registry", sku, c)
			}
		}
	}
	// Sorted + copy-safe (mutating the result must not corrupt the registry).
	got := Capabilities("esp32c6")
	if !sortedStrings(got) {
		t.Errorf("caps not sorted: %v", got)
	}
	got[0] = "MUTATED"
	if contains(Capabilities("esp32c6"), "MUTATED") {
		t.Error("Capabilities returned a slice aliasing the registry")
	}
}

func TestUnknownSKUIsEmptyNotFatal(t *testing.T) {
	if got := Capabilities("no-such-sku"); got != nil {
		t.Errorf("unknown SKU caps = %v, want nil", got)
	}
	if Known("no-such-sku") {
		t.Error("Known(unknown) = true")
	}
	if !Known("esp32c6") {
		t.Error("Known(esp32c6) = false")
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func sortedStrings(s []string) bool {
	for i := 1; i < len(s); i++ {
		if s[i-1] > s[i] {
			return false
		}
	}
	return true
}
