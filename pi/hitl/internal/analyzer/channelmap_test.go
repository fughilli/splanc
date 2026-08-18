package analyzer

import (
	"path/filepath"
	"reflect"
	"testing"
)

// The runtime channel map must round-trip: what SetMap persists, New must reload,
// and MarshalChannelMap/ParseChannelMap are inverses (including the ""↔"default"
// key aliasing). This guards the map_la write-to-board path.
func TestChannelMapRoundTrip(t *testing.T) {
	in := map[string]DUTMap{
		"":          {Channels: []string{"D0"}, Protocol: ProtocolWS2812},
		"c6-003f08": {Channels: []string{"D6"}, Protocol: ProtocolWS2812},
		"c6-fa0324": {Channels: []string{"D7"}, Protocol: ProtocolWS2812},
	}
	js, err := MarshalChannelMap(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := ParseChannelMap(string(js))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("round-trip mismatch:\n in=%#v\ngot=%#v", in, got)
	}
}

// SetMap must apply live AND persist; a fresh broker built on the same MapPath
// must reload the persisted mapping (overlaid on its deploy default).
func TestSetMapPersistsAndReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "channel-map.json")

	b := New(Config{Driver: "fx2lafw", MapPath: path})
	if err := b.SetMap(map[string]DUTMap{
		"c6-fa0324": {Channels: []string{"D7"}, Protocol: ProtocolWS2812},
	}); err != nil {
		t.Fatalf("SetMap: %v", err)
	}
	if got := b.mapping("c6-fa0324"); !reflect.DeepEqual(got.Channels, []string{"D7"}) {
		t.Fatalf("live mapping not applied: %#v", got)
	}

	// A new broker on the same path reloads it; the deploy-default entry it's
	// given for a different DUT survives (overlay, not replace).
	b2 := New(Config{
		Driver:  "fx2lafw",
		MapPath: path,
		Map:     map[string]DUTMap{"c6-003f08": {Channels: []string{"D6"}, Protocol: ProtocolWS2812}},
	})
	if got := b2.mapping("c6-fa0324"); !reflect.DeepEqual(got.Channels, []string{"D7"}) {
		t.Fatalf("persisted mapping not reloaded: %#v", got)
	}
	if got := b2.mapping("c6-003f08"); !reflect.DeepEqual(got.Channels, []string{"D6"}) {
		t.Fatalf("deploy-default mapping lost after overlay: %#v", got)
	}
}
