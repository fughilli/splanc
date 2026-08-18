package analyzer

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// TestDecodeWS2812Golden exercises the FULL shipping decode path end-to-end with
// no hardware: it synthesizes a real WS2812 waveform into a sigrok .sr, then runs
// the broker's decodeSR (which shells the real sigrok-cli + rgb_led_ws281x decoder)
// and asserts the pixels round-trip. This is the CI proof that a bit pattern on
// the wire decodes back to the pixels we expect. Skipped when sigrok-cli isn't on
// PATH (e.g. a dev box without the tool); the rig image always has it.
func TestDecodeWS2812Golden(t *testing.T) {
	if _, err := exec.LookPath("sigrok-cli"); err != nil {
		t.Skip("sigrok-cli not installed; skipping hardware-free decode golden")
	}
	want := []api.Pixel{
		{R: 255, G: 0, B: 0},        // red
		{R: 0, G: 255, B: 0},        // green
		{R: 0, G: 0, B: 255},        // blue
		{R: 255, G: 255, B: 255},    // white
		{R: 0x12, G: 0x34, B: 0x56}, // arbitrary, catches byte-order bugs
	}

	dir := t.TempDir()
	srPath := filepath.Join(dir, "ws.sr")
	if err := writeWS2812SR(srPath, want, 24_000_000); err != nil {
		t.Fatalf("synthesize .sr: %v", err)
	}

	b := New(Config{Driver: "fx2lafw", SampleRate: "24m"})
	got, err := b.decodeSR(context.Background(), srPath, DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812})
	if err != nil {
		t.Fatalf("decodeSR: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded pixels = %v, want %v", got, want)
	}
}

// WS2812 bit timing in samples at the capture rate. A "0" bit holds high ~0.4µs,
// a "1" ~0.8µs, period 1.25µs (≈10/19/30 samples at 24 MHz); >50µs low is a reset.
const (
	ws2812T0H    = 10
	ws2812T1H    = 19
	ws2812Period = 30
	ws2812Reset  = 1600 // ~66µs at 24 MHz, comfortably past the 50µs latch
)

// writeWS2812SR synthesizes a single-channel (D0) sigrok .sr session carrying the
// given pixels as a WS2812 waveform (GRB on the wire, MSB first), framed by reset
// gaps. The .sr container is a zip of {version, metadata, logic-1-1}; for one
// channel unitsize is 1 and each sample byte's bit0 is D0.
func writeWS2812SR(path string, pixels []api.Pixel, sampleRate int) error {
	var samples []byte
	emit := func(level byte, n int) {
		for i := 0; i < n; i++ {
			samples = append(samples, level)
		}
	}
	bit := func(one bool) {
		if one {
			emit(1, ws2812T1H)
			emit(0, ws2812Period-ws2812T1H)
		} else {
			emit(1, ws2812T0H)
			emit(0, ws2812Period-ws2812T0H)
		}
	}
	emit(0, ws2812Reset)
	for _, p := range pixels {
		for _, by := range []byte{p.G, p.R, p.B} { // GRB wire order
			for i := 7; i >= 0; i-- {
				bit((by>>uint(i))&1 == 1)
			}
		}
	}
	emit(0, ws2812Reset)

	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		w, err := z.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if err := add("version", []byte("2")); err != nil {
		return err
	}
	meta := fmt.Sprintf("[global]\nsigrok version=0.5.2\n\n[device 1]\n"+
		"capturefile=logic-1\ntotal probes=1\nsamplerate=%d Hz\n"+
		"total analog=0\nprobe1=D0\nunitsize=1\n", sampleRate)
	if err := add("metadata", []byte(meta)); err != nil {
		return err
	}
	if err := add("logic-1-1", samples); err != nil {
		return err
	}
	if err := z.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}
