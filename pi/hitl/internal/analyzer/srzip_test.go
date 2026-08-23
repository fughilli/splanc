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

// synthWS2812Raw builds a WS2812 single-channel (D0) sample buffer for `pixels`
// repeated `frames` times. With leadReset=false there is NO reset gap before the
// first frame — exactly what a din=r-triggered capture produces (the buffer starts
// on the first data edge). Inter-frame reset gaps are always present (real WS2812
// latches between frames).
func synthWS2812Raw(pixels []api.Pixel, leadReset bool, frames int) []byte {
	var s []byte
	emit := func(level byte, n int) {
		for i := 0; i < n; i++ {
			s = append(s, level)
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
	for f := 0; f < frames; f++ {
		if leadReset || f > 0 {
			emit(0, ws2812Reset)
		}
		for _, p := range pixels {
			for _, by := range []byte{p.G, p.R, p.B} { // GRB wire order
				for i := 7; i >= 0; i-- {
					bit((by>>uint(i))&1 == 1)
				}
			}
		}
	}
	emit(0, ws2812Reset)
	return s
}

func writeLogicSR(t *testing.T, path string, samples []byte, rate int) {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name string, data []byte) {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	add("version", []byte("2"))
	add("metadata", []byte(fmt.Sprintf("[global]\nsigrok version=0.5.2\n\n[device 1]\n"+
		"capturefile=logic-1\ntotal probes=1\nsamplerate=%d Hz\ntotal analog=0\nprobe1=D0\nunitsize=1\n", rate)))
	add("logic-1-1", samples)
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDecodeWS2812NoLeadingReset is the FUG-140 regression: a capture with NO
// leading reset (what din=r triggering yields) used to decode bit-slipped —
// channels rotated and values one bit low (red 255,0,0 -> 254,1,0), an
// intermittent red no per-pixel offset could realign. decodeSR now prepends a
// synthesized reset so sigrok anchors bit-0; assert the single un-anchored frame
// decodes exactly.
func TestDecodeWS2812NoLeadingReset(t *testing.T) {
	if _, err := exec.LookPath("sigrok-cli"); err != nil {
		t.Skip("sigrok-cli not installed")
	}
	want := []api.Pixel{
		{R: 255}, {R: 255}, {G: 255}, {G: 255}, {B: 255}, {B: 255}, {B: 255}, {B: 255},
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "noreset.sr")
	writeLogicSR(t, p, synthWS2812Raw(want, false /*no leading reset*/, 1), 24_000_000)

	b := New(Config{Driver: "fx2lafw", SampleRate: "24m"})
	got, err := b.decodeSR(context.Background(), p, DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812})
	if err != nil {
		t.Fatalf("decodeSR: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("no-leading-reset decode = %v, want %v (bit-slip not corrected)", got, want)
	}
}

// TestPrependResetSRPreservesMultipleChunks makes sure the .sr rewrite keeps a
// multi-chunk capture intact (reset first, original chunks in order after) so a
// real (large, chunked) capture still decodes.
func TestPrependResetSRPreservesMultipleChunks(t *testing.T) {
	if _, err := exec.LookPath("sigrok-cli"); err != nil {
		t.Skip("sigrok-cli not installed")
	}
	want := []api.Pixel{{R: 255}, {G: 255}, {B: 255}}
	// Build a valid single-buffer .sr, then re-split it into two logic chunks to
	// mimic sigrok's chunking, and confirm decode (via decodeSR's prepend) is clean.
	full := synthWS2812Raw(want, false, 2) // 2 frames, no leading reset
	dir := t.TempDir()
	p := filepath.Join(dir, "chunked.sr")
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	mk := func(n string, d []byte) {
		w, _ := z.Create(n)
		w.Write(d)
	}
	mk("version", []byte("2"))
	mk("metadata", []byte("[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\n"+
		"total probes=1\nsamplerate=24000000 Hz\ntotal analog=0\nprobe1=D0\nunitsize=1\n"))
	half := len(full) / 2
	mk("logic-1-1", full[:half])
	mk("logic-1-2", full[half:])
	z.Close()
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	b := New(Config{Driver: "fx2lafw", SampleRate: "24m"})
	got, err := b.decodeSR(context.Background(), p, DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812})
	if err != nil {
		t.Fatalf("decodeSR: %v", err)
	}
	// Two frames, both should decode to `want`; assert `want` appears contiguously.
	if !containsSeq(got, want) {
		t.Fatalf("chunked decode = %v, want a clean %v somewhere", got, want)
	}
}

func containsSeq(hay, needle []api.Pixel) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if reflect.DeepEqual(hay[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}
