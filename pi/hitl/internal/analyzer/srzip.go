package analyzer

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
)

// srzip logic chunks are named "logic-<unit>-<seq>"; sigrok concatenates them in
// numeric <seq> order. We only ever capture one unit ("logic-1-N").
var srLogicChunk = regexp.MustCompile(`^logic-1-(\d+)$`)
var srUnitsize = regexp.MustCompile(`(?m)^unitsize=(\d+)`)

// prependResetSR rewrites a captured sigrok .sr so its logic stream begins with a
// gap of `resetSamples` idle-low samples, and returns the new file's path (created
// under dir).
//
// Why: captures are armed on the data line's rising edge (captureToSR uses
// din=r), so the buffer starts at the first WS2812 bit with NO preceding reset
// (>50µs low). sigrok's rgb_led_ws281x decoder needs that reset to anchor bit-0;
// without it the whole frame decodes bit-slipped — channels rotate and values come
// back one bit low (e.g. red 255,0,0 -> 254,1,0), an intermittent red that no
// per-pixel offset can realign (FUG-140). Synthesizing a leading reset in front of
// the captured samples gives the decoder its anchor; verified against the real
// bug waveform (decode_test.go). Idle-low is all-zero bytes, which is also a
// no-op/idle for the SPI decoder (no clock edges), so this is protocol-agnostic.
func prependResetSR(dir, srcPath string, resetSamples int) (string, error) {
	zr, err := zip.OpenReader(srcPath)
	if err != nil {
		return "", fmt.Errorf("open .sr: %w", err)
	}
	defer zr.Close()

	// unitsize (bytes per sample) from metadata; default 1 (our single-channel case).
	unitsize := 1
	var metadata []byte
	chunks := map[int][]byte{}
	var version []byte
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return "", err
		}
		switch {
		case f.Name == "version":
			version = data
		case f.Name == "metadata":
			metadata = data
			if m := srUnitsize.FindSubmatch(data); m != nil {
				if u, err := strconv.Atoi(string(m[1])); err == nil && u > 0 {
					unitsize = u
				}
			}
		default:
			if m := srLogicChunk.FindStringSubmatch(f.Name); m != nil {
				seq, _ := strconv.Atoi(m[1])
				chunks[seq] = data
			}
		}
	}
	if len(chunks) == 0 {
		return "", fmt.Errorf("no logic chunks in %s", srcPath)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if version == nil {
		version = []byte("2")
	}
	if err := add("version", version); err != nil {
		return "", err
	}
	if err := add("metadata", metadata); err != nil {
		return "", err
	}
	// New first chunk: resetSamples idle-low samples (all channels 0).
	if err := add("logic-1-1", make([]byte, resetSamples*unitsize)); err != nil {
		return "", err
	}
	// Original chunks, in order, shifted up by one so the reset stays first.
	seqs := make([]int, 0, len(chunks))
	for s := range chunks {
		seqs = append(seqs, s)
	}
	sort.Ints(seqs)
	for i, s := range seqs {
		if err := add(fmt.Sprintf("logic-1-%d", i+2), chunks[s]); err != nil {
			return "", err
		}
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	outPath := srcPath + ".reset.sr"
	if dir != "" {
		outPath = dir + "/reset.sr"
	}
	if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
		return "", err
	}
	return outPath, nil
}
