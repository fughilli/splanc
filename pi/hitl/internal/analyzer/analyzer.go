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
	"log"
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
	// MapPath, if set, is a JSON file the DUT→channel map is persisted to (the
	// same schema as ParseChannelMap). It's loaded at New (overlaid on Map, so a
	// map_la-written mapping survives daemon restarts and outranks the deploy
	// default) and rewritten by SetMap. "" disables persistence.
	MapPath string
}

// Broker owns the single shared analyzer and serializes captures on it.
type Broker struct {
	cfg     Config
	mu      sync.Mutex   // exactly one capture at a time on the one instrument
	mapMu   sync.RWMutex // guards cfg.Map (read by captures/status, rewritten by SetMap)
	mapPath string
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
	// Overlay any persisted map (runtime edits via map_la / SetMap) onto the
	// deploy-provided default: persisted entries win, un-persisted DUTs keep the
	// default. A missing/empty file is not an error (first boot).
	if cfg.MapPath != "" {
		if persisted, err := loadMapFile(cfg.MapPath); err != nil {
			// Don't fail the daemon over a corrupt cache; log-and-ignore is the
			// caller's job (New has no logger) — surface via a sentinel the caller
			// can check. Here we just skip it.
			_ = err
		} else {
			for k, v := range persisted {
				cfg.Map[k] = v
			}
		}
	}
	return &Broker{cfg: cfg, mapPath: cfg.MapPath}
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
	b.mapMu.RLock()
	defer b.mapMu.RUnlock()
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

// Taps reports whether this rig's shared analyzer is wired to the named DUT's data
// line — i.e. the DUT should advertise a logic-analyzer-* capability (see TapCaps
// for the granular, signal-specific name). The
// analyzer is rig wiring, not a SKU trait: two identical DUTs can differ, so this
// is the source of truth for that capability. True when the broker is enabled AND
// either the DUT has an explicit channel-map entry, or a default ("") entry exists
// and no DUT has an explicit tap (a uniform or single-DUT rig, where every DUT is
// captured on the default channels). On a mixed rig, give the tapped DUTs explicit
// entries so un-tapped DUTs don't falsely advertise the analyzer.
func (b *Broker) Taps(dut string) bool {
	if !b.Enabled() {
		return false
	}
	b.mapMu.RLock()
	defer b.mapMu.RUnlock()
	if _, ok := b.cfg.Map[dut]; ok {
		return true
	}
	if _, hasDefault := b.cfg.Map[""]; hasDefault {
		for k := range b.cfg.Map {
			if k != "" {
				return false // explicit taps exist; this un-mapped DUT isn't one
			}
		}
		return true
	}
	return false
}

// TapCaps returns the granular logic-analyzer capabilities a DUT advertises from
// this rig's wiring, or nil if it isn't tapped. The capability names the SIGNAL the
// FX2 is on so tests can map precisely: a ws2812 tap on the strip DIN advertises
// "logic-analyzer-led-strip"; a spi/spi-raw tap on the SPI wire advertises
// "logic-analyzer-spi". (One channel-map entry per DUT = one protocol today, so a
// DUT tapped on BOTH signals advertises the one its map entry names; multi-tap per
// DUT would return both.) This is rig instrumentation, not a SKU trait — hence it
// lives here, keyed off the broker's channel map, not in the SKU registry.
func (b *Broker) TapCaps(dut string) []string {
	if !b.Taps(dut) {
		return nil
	}
	switch b.mapping(dut).Protocol {
	case ProtocolSPI, ProtocolSPIRaw:
		return []string{"logic-analyzer-spi"}
	default: // ProtocolWS2812 (and the D0/ws2812 fallback)
		return []string{"logic-analyzer-led-strip"}
	}
}

// mapping resolves a DUT name to its channel/protocol assignment, falling back to
// the default ("") entry, then to a single-channel D0/ws2812 tap so a
// minimally-configured rig still captures its sole DUT.
func (b *Broker) mapping(dut string) DUTMap {
	b.mapMu.RLock()
	defer b.mapMu.RUnlock()
	if m, ok := b.cfg.Map[dut]; ok {
		return m
	}
	if m, ok := b.cfg.Map[""]; ok {
		return m
	}
	return DUTMap{Channels: []string{"D0"}, Protocol: ProtocolWS2812}
}

// Snapshot returns a copy of the current DUT→channel map for display/read-back
// (the GET side of the runtime channel-map endpoint).
func (b *Broker) Snapshot() map[string]DUTMap {
	b.mapMu.RLock()
	defer b.mapMu.RUnlock()
	out := make(map[string]DUTMap, len(b.cfg.Map))
	for k, v := range b.cfg.Map {
		ch := append([]string(nil), v.Channels...)
		out[k] = DUTMap{Channels: ch, Protocol: v.Protocol}
	}
	return out
}

// SetMap replaces the DUT→channel map wholesale and persists it (if a MapPath was
// configured) so it survives daemon restarts. This is how `map_la` writes the
// mapping it acquires interactively back "to the board" without a redeploy.
// Persisting is best-effort surfaced as an error; the in-memory map is updated
// regardless so the running daemon reflects the new mapping immediately.
func (b *Broker) SetMap(m map[string]DUTMap) error {
	b.mapMu.Lock()
	next := make(map[string]DUTMap, len(m))
	for k, v := range m {
		ch := append([]string(nil), v.Channels...)
		next[k] = DUTMap{Channels: ch, Protocol: v.Protocol}
	}
	b.cfg.Map = next
	path := b.mapPath
	b.mapMu.Unlock()
	if path == "" {
		return nil
	}
	return saveMapFile(path, next)
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
	res := &api.CaptureResult{
		Device:     req.Device,
		Protocol:   string(m.Protocol),
		SampleRate: b.SampleRateHz(),
	}
	if m.Protocol == ProtocolSPIRaw {
		data, err := b.decodeSRBytes(ctx, srPath, m)
		if err != nil {
			return nil, err
		}
		res.Bytes = data
	} else {
		pixels, err := b.decodeSR(ctx, srPath, m)
		if err != nil {
			return nil, err
		}
		res.Pixels = pixels
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
	// Captures are armed on the data line's first rising edge, so the buffer has no
	// leading WS2812 reset (>50µs low) for the decoder to anchor bit-0 on — the
	// frame then decodes bit-slipped (FUG-140). Synthesize a leading reset in front
	// of the samples so sigrok frames correctly. WS2812 only; SPI is clocked and
	// doesn't have this failure mode.
	if m.Protocol == ProtocolWS2812 {
		rate := b.SampleRateHz()
		if rate <= 0 {
			rate = 24_000_000
		}
		resetSamples := int(80e-6 * float64(rate)) // 80µs, comfortably past the 50µs latch
		if resetSamples < 1600 {
			resetSamples = 1600
		}
		if fixed, ferr := prependResetSR(filepath.Dir(srPath), srPath, resetSamples); ferr != nil {
			log.Printf("analyzer: prepend reset failed (%v); decoding raw capture", ferr)
		} else {
			srPath = fixed
		}
	}
	args := append([]string{"-i", srPath}, dargs...)
	out, err := run(ctx, b.cfg.SigrokCLI, args...)
	if err != nil {
		return nil, fmt.Errorf("sigrok decode: %w: %s", err, out)
	}
	return parseRGBHex(out)
}

// decodeSRBytes runs the spi decoder over a captured .sr and returns the raw MOSI
// byte stream (for spi-raw / FPGA wire validation). No WS2812 reset prepend: SPI
// is clocked, so there's no bit-0 anchoring problem.
func (b *Broker) decodeSRBytes(ctx context.Context, srPath string, m DUTMap) ([]byte, error) {
	dargs, err := decoderArgs(m.Protocol, m.Channels)
	if err != nil {
		return nil, err
	}
	args := append([]string{"-i", srPath}, dargs...)
	out, err := run(ctx, b.cfg.SigrokCLI, args...)
	if err != nil {
		return nil, fmt.Errorf("sigrok decode: %w: %s", err, out)
	}
	return parseSPIBytes(out)
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

// wireMap is the on-disk / on-the-wire JSON shape of the channel map, matching
// what ParseChannelMap reads: keyed by DUT name ("default" for the "" fallback).
type wireEntry struct {
	Channels []string `json:"channels"`
	Protocol string   `json:"protocol"`
}

// MarshalChannelMap renders a broker map as the ParseChannelMap JSON schema, so a
// map read out of the broker round-trips back in (and to the persisted file).
func MarshalChannelMap(m map[string]DUTMap) ([]byte, error) {
	raw := make(map[string]wireEntry, len(m))
	for k, v := range m {
		name := k
		if name == "" {
			name = "default"
		}
		ch := v.Channels
		if ch == nil {
			ch = []string{}
		}
		raw[name] = wireEntry{Channels: ch, Protocol: string(v.Protocol)}
	}
	return json.MarshalIndent(raw, "", "  ")
}

// loadMapFile reads a persisted channel map; a missing file yields an empty map
// with no error (first boot, nothing persisted yet).
func loadMapFile(path string) (map[string]DUTMap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]DUTMap{}, nil
		}
		return nil, err
	}
	return ParseChannelMap(string(data))
}

// saveMapFile persists the map atomically (write-temp-then-rename) so a crash
// mid-write can't corrupt the file the daemon reloads at boot.
func saveMapFile(path string, m map[string]DUTMap) error {
	data, err := MarshalChannelMap(m)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
