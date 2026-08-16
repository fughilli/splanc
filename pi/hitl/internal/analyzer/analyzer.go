// Package analyzer is the rig's shared logic-analyzer broker. A HITL logic-analyzer
// rig has ONE FX2/fx2lafw "Saleae clone" (8 channels, 24 MHz) whose channels are
// wired a few at a time to each DUT's LED data line — so a single, cheap instrument
// serves every DUT on the rig. The broker owns that instrument: it maps a DUT name
// to its channel subset + wire protocol, runs a triggered sigrok capture scoped to
// those channels, decodes it to pixels, and serializes access so concurrent
// per-DUT reservations can't collide on the single device.
//
// The FX2 stays on the host with the daemon (which already runs as root and owns
// USB); it is never passed into a reservation container. Container agents request
// captures over the daemon's HTTP API (see the /capture route + the `hitl-capture`
// toolbox client), naming their DUT — so nothing about raw-USB container isolation
// (internal/runner) changes.
package analyzer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// DUTMap is one DUT's slice of the shared analyzer: which channel(s) tap its data
// line(s) and how to decode them. Sharing one FX2 across DUTs means assigning each
// a disjoint channel subset (e.g. c6-a → D0, c6-b → D1 for WS2812; a SPI DUT takes
// two, clk+data).
type DUTMap struct {
	Channels []string // sigrok channel names, e.g. ["D0"] (ws2812 din) or ["D0","D1"] (spi clk,data)
	Protocol Protocol // ws2812 (default) or spi
}

// Config configures the broker. Driver=="" means no analyzer on this rig (the
// broker is dormant and Capture returns an error), so the same daemon binary runs
// on a plain rig and a logic-analyzer rig unchanged.
type Config struct {
	SigrokCLI  string            // sigrok-cli binary (looked up on PATH if bare)
	Driver     string            // sigrok capture driver, e.g. "fx2lafw"; "" disables the broker
	SampleRate string            // sigrok samplerate config, e.g. "24m"
	Samples    int               // default capture length in samples
	Map        map[string]DUTMap // keyed by DUT name; key "" is the default/fallback mapping
}

// Broker owns the single shared analyzer and serializes captures on it.
type Broker struct {
	cfg Config
	mu  sync.Mutex // exactly one capture at a time on the one instrument
}

// New builds a broker, filling defaults. A nil/disabled broker (empty Driver) is
// valid and reports Enabled()==false.
func New(cfg Config) *Broker {
	if cfg.SigrokCLI == "" {
		cfg.SigrokCLI = "sigrok-cli"
	}
	if cfg.SampleRate == "" {
		cfg.SampleRate = "24m"
	}
	if cfg.Samples == 0 {
		// ≈208 ms @24 MHz. fx2lafw has no hardware trigger, so sigrok software-
		// triggers within THIS acquisition window: if the tapped line's rising
		// edge doesn't occur within the window, nothing is captured. A DUT driving
		// a static/idle pattern only re-pushes the WS2812 frame at its render
		// cadence (the C6 counting probe repaints at 10 Hz / every 100 ms), so an
		// 8 ms window misses the burst ~92% of the time. Span >1 full cadence
		// period (here 2×100 ms) so a burst — and its rising edge — is reliably in
		// the window; the ~ms frame then lands in the post-trigger samples.
		cfg.Samples = 5000000
	}
	if cfg.Map == nil {
		cfg.Map = map[string]DUTMap{}
	}
	return &Broker{cfg: cfg}
}

// Enabled reports whether an analyzer is configured on this rig.
func (b *Broker) Enabled() bool { return b != nil && b.cfg.Driver != "" }

// Describe returns the rig's analyzer capability for /status, or nil when there
// is no analyzer — so clients can select a rig by capability. Protocols/channels
// are the distinct values across the DUT channel map (for display + matching).
func (b *Broker) Describe() *api.AnalyzerInfo {
	if !b.Enabled() {
		return nil
	}
	protoSeen, chSeen := map[string]bool{}, map[string]bool{}
	var protocols, channels []string
	add := func(m DUTMap) {
		p := string(m.Protocol)
		if p == "" {
			p = string(ProtocolWS2812)
		}
		if !protoSeen[p] {
			protoSeen[p] = true
			protocols = append(protocols, p)
		}
		for _, c := range m.Channels {
			if !chSeen[c] {
				chSeen[c] = true
				channels = append(channels, c)
			}
		}
	}
	for _, m := range b.cfg.Map {
		add(m)
	}
	if len(protocols) == 0 { // no explicit map: the broker's fallback tap
		add(DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812})
	}
	sort.Strings(protocols)
	sort.Strings(channels)
	return &api.AnalyzerInfo{Present: true, Driver: b.cfg.Driver, Protocols: protocols, Channels: channels}
}

// SampleRateHz parses the configured samplerate (e.g. "24m") to Hz, for latency
// math on sample offsets. Returns 0 if it can't be parsed.
func (b *Broker) SampleRateHz() int { return parseSampleRate(b.cfg.SampleRate) }

// mapping resolves a DUT name to its channel/protocol assignment, falling back to
// the default ("") entry, then to a single-channel D0/ws2812 tap so a
// minimally-configured rig still captures its sole DUT.
func (b *Broker) mapping(dut string) DUTMap {
	if m, ok := b.cfg.Map[dut]; ok {
		return m
	}
	if m, ok := b.cfg.Map[""]; ok {
		return m
	}
	return DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812}
}

// Capture runs one triggered capture for the named DUT and returns the decoded
// pixels. It blocks on the broker mutex while another capture is in flight (the
// single instrument can only do one at a time), then shells sigrok-cli twice: once
// to capture the DUT's channels to a temp .sr, once to decode that .sr. Splitting
// capture from decode keeps the exact decode path testable from a synthesized .sr
// (see golden_test.go) with no hardware.
func (b *Broker) Capture(ctx context.Context, req api.CaptureRequest) (*api.CaptureResult, error) {
	if !b.Enabled() {
		return nil, errors.New("this rig has no logic analyzer configured")
	}
	m := b.mapping(req.Device)
	if p := Protocol(req.Protocol); p != "" {
		m.Protocol = p
	}
	if m.Protocol == "" {
		m.Protocol = ProtocolWS2812
	}
	samples := req.Samples
	if samples <= 0 {
		samples = b.cfg.Samples
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	dir, err := os.MkdirTemp("", "hitl-capture-")
	if err != nil {
		return nil, fmt.Errorf("scratch dir: %w", err)
	}
	defer os.RemoveAll(dir)
	srPath := filepath.Join(dir, "capture.sr")

	if err := b.captureToSR(ctx, srPath, m, samples); err != nil {
		return nil, err
	}
	// sigrok-cli exits 0 but writes NO .sr when the trigger never fires (the
	// tapped line is idle, or the DUT drives a different channel than mapped).
	// Catch that here and report it plainly, instead of letting decodeSR fail on
	// a missing file with a cryptic "No such file" from sigrok.
	if fi, err := os.Stat(srPath); err != nil || fi.Size() == 0 {
		return nil, fmt.Errorf("no data captured on %s (trigger %s=r never fired — is the DUT driving this line? wrong channel?)",
			strings.Join(m.Channels, ","), m.Channels[0])
	}
	pixels, err := b.decodeSR(ctx, srPath, m)
	if err != nil {
		return nil, err
	}

	res := &api.CaptureResult{
		Device:     req.Device,
		Protocol:   string(m.Protocol),
		Pixels:     pixels,
		SampleRate: b.SampleRateHz(),
	}
	if req.SaveSR {
		raw, err := os.ReadFile(srPath)
		if err != nil {
			return nil, fmt.Errorf("read .sr: %w", err)
		}
		res.SR = base64.StdEncoding.EncodeToString(raw)
	}
	return res, nil
}

// captureToSR arms a rising-edge trigger on the DUT's primary channel and captures
// `samples` samples of its channel subset to srPath. Triggering on the data line's
// own first edge removes the daemon's scheduling jitter from the capture window.
func (b *Broker) captureToSR(ctx context.Context, srPath string, m DUTMap, samples int) error {
	if len(m.Channels) == 0 {
		return errors.New("no analyzer channels mapped for this DUT")
	}
	args := []string{
		"--driver", b.cfg.Driver,
		"--config", "samplerate=" + b.cfg.SampleRate,
		"--channels", strings.Join(m.Channels, ","),
		"--triggers", m.Channels[0] + "=r",
		"--samples", strconv.Itoa(samples),
		"-o", srPath,
	}
	if out, err := run(ctx, b.cfg.SigrokCLI, args...); err != nil {
		return fmt.Errorf("sigrok capture: %w: %s", err, out)
	}
	return nil
}

// decodeSR runs the protocol decoder over a captured .sr and parses the pixels.
// Exported-in-spirit for the golden test, which feeds it a synthesized .sr.
func (b *Broker) decodeSR(ctx context.Context, srPath string, m DUTMap) ([]api.Pixel, error) {
	dargs, err := decoderArgs(m.Protocol, m.Channels)
	if err != nil {
		return nil, err
	}
	args := append([]string{"-i", srPath}, dargs...)
	out, err := run(ctx, b.cfg.SigrokCLI, args...)
	if err != nil {
		return nil, fmt.Errorf("sigrok decode: %w: %s", err, out)
	}
	return parseRGBHex(out)
}

// run executes sigrok-cli and returns combined output.
func run(ctx context.Context, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// parseSampleRate turns a sigrok samplerate string ("24m", "1M", "24000000",
// "24MHz") into Hz. Returns 0 on failure.
func parseSampleRate(s string) int {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.TrimSuffix(s, "hz")
	mult := 1
	switch {
	case strings.HasSuffix(s, "k"):
		mult, s = 1_000, strings.TrimSuffix(s, "k")
	case strings.HasSuffix(s, "m"):
		mult, s = 1_000_000, strings.TrimSuffix(s, "m")
	case strings.HasSuffix(s, "g"):
		mult, s = 1_000_000_000, strings.TrimSuffix(s, "g")
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return int(f * float64(mult))
}

// ParseChannelMap parses the daemon's --analyzer-channel-map JSON into the broker
// Map. The JSON is keyed by DUT name (use "" or "default" for the fallback), each
// value {"channels":["D0"],"protocol":"ws2812"}:
//
//	{"default":{"channels":["D0"],"protocol":"ws2812"},
//	 "c6-1a2b3c":{"channels":["D1"],"protocol":"ws2812"}}
//
// An empty string yields an empty map (broker falls back to D0/ws2812).
func ParseChannelMap(js string) (map[string]DUTMap, error) {
	out := map[string]DUTMap{}
	js = strings.TrimSpace(js)
	if js == "" {
		return out, nil
	}
	var raw map[string]struct {
		Channels []string `json:"channels"`
		Protocol string   `json:"protocol"`
	}
	if err := json.Unmarshal([]byte(js), &raw); err != nil {
		return nil, fmt.Errorf("parse --analyzer-channel-map: %w", err)
	}
	for name, v := range raw {
		key := name
		if key == "default" {
			key = ""
		}
		out[key] = DUTMap{Channels: v.Channels, Protocol: Protocol(v.Protocol)}
	}
	return out, nil
}
