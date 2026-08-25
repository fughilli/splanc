package analyzer

import (
	"reflect"
	"testing"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

func TestParseRGBHex(t *testing.T) {
	// Exactly the shape sigrok-cli prints for `-A rgb_led_ws281x=rgb`
	// (one "#rrggbb" per LED, in wire order), with a stray header line mixed in
	// to prove non-pixel lines are ignored.
	in := "" +
		"rgb_led_ws281x-1: #ff0000\n" +
		"rgb_led_ws281x-1: #00ff00\n" +
		"noise line without a token\n" +
		"rgb_led_ws281x-1: #0000ff\n" +
		"rgb_led_ws281x-1: #123456\n"
	got, err := parseRGBHex(in)
	if err != nil {
		t.Fatalf("parseRGBHex: %v", err)
	}
	want := []api.Pixel{
		{R: 0xff, G: 0x00, B: 0x00},
		{R: 0x00, G: 0xff, B: 0x00},
		{R: 0x00, G: 0x00, B: 0xff},
		{R: 0x12, G: 0x34, B: 0x56},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRGBHex = %v, want %v", got, want)
	}
}

func TestDecoderArgs(t *testing.T) {
	ws, err := decoderArgs(ProtocolWS2812, []string{"D0"})
	if err != nil {
		t.Fatalf("ws2812: %v", err)
	}
	if got, want := join(ws), "-P rgb_led_ws281x:din=D0 -A rgb_led_ws281x=rgb"; got != want {
		t.Errorf("ws2812 args = %q, want %q", got, want)
	}
	sp, err := decoderArgs(ProtocolSPI, []string{"D0", "D1"})
	if err != nil {
		t.Fatalf("spi: %v", err)
	}
	if got, want := join(sp), "-P spi:clk=D0:mosi=D1:cpol=0:cpha=0 -P rgb_led_spi -A rgb_led_spi=rgb"; got != want {
		t.Errorf("spi args = %q, want %q", got, want)
	}
	if _, err := decoderArgs(ProtocolWS2812, nil); err == nil {
		t.Error("ws2812 with no channels: want error")
	}
	if _, err := decoderArgs(ProtocolSPI, []string{"D0"}); err == nil {
		t.Error("spi with one channel: want error")
	}
	if _, err := decoderArgs(Protocol("bogus"), []string{"D0"}); err == nil {
		t.Error("unknown protocol: want error")
	}
}

func TestParseSPIBytes(t *testing.T) {
	// The shape sigrok-cli prints for `-A spi=mosi-data`: one byte per line,
	// value as a 2-hex token after the "spi-1:" channel prefix.
	in := "" +
		"spi-1: 02\n" +
		"spi-1: 0A\n" +
		"noise without a byte token\n" +
		"spi-1: ff\n"
	got, err := parseSPIBytes(in)
	if err != nil {
		t.Fatalf("parseSPIBytes: %v", err)
	}
	if want := []byte{0x02, 0x0a, 0xff}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parseSPIBytes = %v, want %v", got, want)
	}
}

func TestDecoderArgsSPIRaw(t *testing.T) {
	// clk, mosi, cs -> spi decoder with cs framing + the mosi-data annotation.
	got, err := decoderArgs(ProtocolSPIRaw, []string{"D0", "D1", "D2"})
	if err != nil {
		t.Fatalf("spi-raw: %v", err)
	}
	if want := "-P spi:clk=D0:mosi=D1:cpol=0:cpha=0:cs=D2 -A spi=mosi-data"; join(got) != want {
		t.Errorf("spi-raw args = %q, want %q", join(got), want)
	}
	// clk, mosi (no cs) is allowed.
	if _, err := decoderArgs(ProtocolSPIRaw, []string{"D0", "D1"}); err != nil {
		t.Errorf("spi-raw 2ch: %v", err)
	}
	if _, err := decoderArgs(ProtocolSPIRaw, []string{"D0"}); err == nil {
		t.Error("spi-raw with one channel: want error")
	}
}

func TestParseSampleRate(t *testing.T) {
	cases := map[string]int{
		"24m": 24_000_000, "24M": 24_000_000, "24MHz": 24_000_000,
		"1k": 1_000, "24000000": 24_000_000, "": 0, "abc": 0,
	}
	for in, want := range cases {
		if got := parseSampleRate(in); got != want {
			t.Errorf("parseSampleRate(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestDescribe(t *testing.T) {
	// Disabled broker (no driver) advertises nothing.
	if got := New(Config{}).Describe(); got != nil {
		t.Errorf("Describe() on disabled broker = %+v, want nil", got)
	}
	// Enabled broker reports present + driver + distinct protocols/channels.
	b := New(Config{Driver: "fx2lafw", Map: map[string]DUTMap{
		"":       {Channels: []string{"D6"}, Protocol: ProtocolWS2812},
		"c6-abc": {Channels: []string{"D0", "D1"}, Protocol: ProtocolSPI},
	}})
	got := b.Describe()
	if got == nil || !got.Present || got.Driver != "fx2lafw" {
		t.Fatalf("Describe() = %+v, want present fx2lafw", got)
	}
	if join(got.Protocols) != "spi ws2812" { // sorted, deduped
		t.Errorf("protocols = %v, want [spi ws2812]", got.Protocols)
	}
	if join(got.Channels) != "D0 D1 D6" {
		t.Errorf("channels = %v, want [D0 D1 D6]", got.Channels)
	}
	// Enabled with an empty map -> the fallback tap (D0/ws2812).
	if d := New(Config{Driver: "fx2lafw"}).Describe(); d == nil || join(d.Channels) != "D0" || join(d.Protocols) != "ws2812" {
		t.Errorf("fallback Describe() = %+v", d)
	}
}

func TestParseChannelMap(t *testing.T) {
	m, err := ParseChannelMap(`{"default":{"channels":["D0"],"protocol":"ws2812"},"c6-abc":{"channels":["D1","D2"],"protocol":"spi"}}`)
	if err != nil {
		t.Fatalf("ParseChannelMap: %v", err)
	}
	if d, ok := m[""]; !ok || len(d.Channels) != 1 || d.Channels[0] != "D0" || d.Protocol != ProtocolWS2812 {
		t.Errorf("default mapping = %+v", d)
	}
	if d := m["c6-abc"]; d.Protocol != ProtocolSPI || len(d.Channels) != 2 {
		t.Errorf("c6-abc mapping = %+v", d)
	}
	if empty, err := ParseChannelMap(""); err != nil || len(empty) != 0 {
		t.Errorf("empty map: %v %v", empty, err)
	}
}

func join(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += " "
		}
		out += s
	}
	return out
}
