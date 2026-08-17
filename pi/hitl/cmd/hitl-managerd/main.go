// Command hitl-managerd is the Pi-side HITL reservation daemon. It exposes a
// small JSON API (over the tailnet) that agents use to queue for the rig; when
// a reservation reaches the head it starts a test container with an ESP32-C6 DUT
// attached and the holder's SSH key authorized, and returns the SSH endpoint.
//
// A rig may host several DUTs (each its own port + device nodes, run
// concurrently). There are three ways to configure them, in precedence order:
//
//   - explicit: one --dut '{"name":…,"ssh_port":…,"devices":[…]}' flag per DUT;
//   - auto-discovery (--discover): enumerate the ESP32-C6 boards attached to the
//     host by their stable /dev/serial/by-id/* symlinks and synthesize one DUT
//     per board (stable serial-derived name, tty pinned to /dev/ttyACM0, JTAG
//     serial filled in). Discovery is live: the daemon polls and syncs the DUT
//     set, so boards hot-plugged/removed after boot come and go without a restart;
//   - legacy fallback (neither flag): a single DUT built from --ssh-port/--device.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/analyzer"
	"github.com/fughilli/splanc/pi/hitl/internal/ap"
	"github.com/fughilli/splanc/pi/hitl/internal/api"
	"github.com/fughilli/splanc/pi/hitl/internal/queue"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func main() {
	hostname, _ := os.Hostname()

	addr := flag.String("addr", ":8087", "listen address (bind to the tailnet interface in prod)")
	rig := flag.String("rig", hostname, "rig name")
	host := flag.String("host", hostname, "host agents use to reach this machine (tailnet name)")
	image := flag.String("image", "hitl-test:latest", "OCI image for the test container")
	sshPort := flag.Int("ssh-port", 2222, "host port published to the container sshd")
	sshUser := flag.String("ssh-user", "agent", "login user inside the container")
	lease := flag.Duration("lease", 30*time.Minute, "heartbeat lease window")
	stateDir := flag.String("state-dir", "/var/lib/hitl", "writable scratch dir")
	podman := flag.String("podman", "podman", "podman binary")
	privileged := flag.Bool("privileged", true, "run the container privileged (raw USB/JTAG)")
	var devices stringList
	flag.Var(&devices, "device", "extra --device mapping for the single-DUT fallback (repeatable)")
	var duts stringList
	flag.Var(&duts, "dut", `a DUT as JSON: {"name":"c6-0","ssh_port":2222,"devices":["/dev/serial/by-id/…:/dev/ttyACM0"],"env":{"HITL_ADAPTER_SERIAL":"…"}} (repeatable; enables multi-DUT)`)
	// Auto-discovery: when no --dut flags are given, enumerate attached boards by
	// their stable by-id serial symlinks and build one DUT per board, assigning
	// ports sequentially from --ssh-port. Ignored if any --dut flag is present.
	discover := flag.Bool("discover", false, "auto-discover DUTs from --discover-glob (one DUT per attached board), live")
	discoverGlob := flag.String("discover-glob", "/dev/serial/by-id/*", "glob of DUT serial nodes to auto-discover")
	discoverMax := flag.Int("discover-max-duts", 8, "max concurrent DUTs (sshd port range from --ssh-port) for --discover")
	discoverInterval := flag.Duration("discover-interval", 3*time.Second, "how often --discover rescans for hot-plugged/removed DUTs")
	discoverRetention := flag.Duration("discover-retention", 30*time.Second, "how long a DUT must be continuously absent before --discover treats it as unplugged (tolerates resetting boards)")
	// The rig's self-hosted provisioning AP (NetworkManager connection toggled
	// per-reservation). With --ap-conn set, the daemon brings it up while a
	// reservation is active and advertises its creds in /status so the harness
	// provisions the DUT onto it with no external WiFi.
	apConn := flag.String("ap-conn", "", "NetworkManager connection id for the provisioning AP (enables AP mode)")
	apSSID := flag.String("ap-ssid", "", "SSID advertised in /status for the provisioning AP")
	apPSK := flag.String("ap-psk", "", "passphrase advertised in /status for the provisioning AP")
	apIface := flag.String("ap-iface", "", "AP virtual interface to create on demand (e.g. ap0); empty = don't manage a vif")
	apSta := flag.String("ap-sta", "wlan0", "STA interface whose radio hosts the AP vif")
	nmcli := flag.String("nmcli", "nmcli", "nmcli binary used to toggle the AP connection")
	iw := flag.String("iw", "iw", "iw binary used to create the AP vif")
	ipBin := flag.String("ip", "ip", "ip binary used to set the AP vif MAC")
	// Shared logic analyzer (a single FX2/fx2lafw whose channels tap each DUT's
	// LED data line). With --analyzer-driver set, the daemon owns the instrument
	// and serves captures over POST /capture, scoped per DUT via --analyzer-channel-map.
	// Empty driver = no analyzer on this rig (the /capture route reports 503).
	analyzerDriver := flag.String("analyzer-driver", "", "sigrok capture driver for the shared logic analyzer (e.g. fx2lafw); empty disables capture")
	analyzerSigrok := flag.String("analyzer-sigrok", "sigrok-cli", "sigrok-cli binary")
	analyzerRate := flag.String("analyzer-samplerate", "24m", "sigrok samplerate for captures")
	analyzerSamples := flag.Int("analyzer-samples", 5000000, "default capture length in samples (≈208ms @24MHz — must span the DUT's frame cadence, see analyzer.go)")
	analyzerMap := flag.String("analyzer-channel-map", "", `per-DUT analyzer channels as JSON: {"default":{"channels":["D0"],"protocol":"ws2812"},"c6-1a2b3c":{"channels":["D1"],"protocol":"ws2812"}}`)
	// URL a reservation container uses to reach this daemon's /capture. podman
	// injects host.containers.internal for the host gateway; keep the port in sync
	// with --addr. Passed to the container as $HITL_CAPTURE_SERVER for `hitl-capture`.
	containerCaptureURL := flag.String("container-capture-url", "http://host.containers.internal:8087", "daemon base URL reservation containers use for /capture ($HITL_CAPTURE_SERVER)")
	flag.Parse()

	run := runner.NewPodman(runner.PodmanConfig{
		Image:      *image,
		Host:       *host,
		SSHUser:    *sshUser,
		StateDir:   *stateDir,
		Podman:     *podman,
		Privileged: *privileged,
		CaptureURL: *containerCaptureURL,
	})

	channelMap, err := analyzer.ParseChannelMap(*analyzerMap)
	if err != nil {
		log.Fatalf("analyzer config: %v", err)
	}
	brk := analyzer.New(analyzer.Config{
		SigrokCLI:  *analyzerSigrok,
		Driver:     *analyzerDriver,
		SampleRate: *analyzerRate,
		Samples:    *analyzerSamples,
		Map:        channelMap,
		// Persist runtime map edits (map_la) next to the other daemon state so the
		// acquired DUT→channel mapping survives restarts/reboots without a redeploy.
		MapPath: filepath.Join(*stateDir, "analyzer-channel-map.json"),
	})
	if brk.Enabled() {
		log.Printf("logic analyzer: driver=%s samplerate=%s (shared, brokered over /capture)", *analyzerDriver, *analyzerRate)
	}

	var devs []runner.Device
	var mon *dutMonitor
	switch {
	case len(duts) > 0:
		devs, err = buildDevices(duts, *sshPort, devices)
	case *discover:
		mon = newDUTMonitor(*discoverGlob, *sshPort, *discoverMax, *discoverRetention)
		devs, err = mon.scan()
		if err == nil && len(devs) == 0 {
			log.Printf("discover: no DUTs matched %q yet; will attach them live as they appear", *discoverGlob)
		}
	default:
		devs, err = buildDevices(nil, *sshPort, devices)
	}
	if err != nil {
		log.Fatalf("dut config: %v", err)
	}
	for _, d := range devs {
		log.Printf("dut: name=%s ssh-port=%d devices=%v", d.Name, d.SSHPort, d.Devices)
	}

	var opts []queue.Option
	opts = append(opts, queue.WithDevices(devs))
	// Advertise the shared logic-analyzer capability in /status so clients can
	// select this rig by capability (e.g. `hitl reserve --require analyzer`).
	if brk.Enabled() {
		opts = append(opts, queue.WithAnalyzer(brk.Describe()))
	}
	var apCtl *ap.NMController
	// Advertise the provisioning-AP creds in /status (for `hitl wifi`) whenever an
	// SSID is configured — independent of whether the daemon toggles the AP.
	if *apSSID != "" {
		opts = append(opts, queue.WithWiFi(&api.WiFiInfo{SSID: *apSSID, PSK: *apPSK}))
		log.Printf("provisioning AP: ssid=%q", *apSSID)
	}
	// Per-reservation AP control (create the vif + toggle the NM connection) only
	// when --ap-conn is set. Unused for an always-on dedicated-radio AP; kept for
	// the future multi-DUT design.
	if *apConn != "" {
		apCtl = ap.New(*nmcli, *apConn, *apIface, *apSta, *iw, *ipBin)
		opts = append(opts, queue.WithAP(apCtl))
	}
	mgr := queue.New(*rig, *lease, run, opts...)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := mgr.Recover(ctx); err != nil {
		log.Printf("startup cleanup: %v", err)
	}
	// A crash mid-reservation could leave the AP up; ensure it's down at startup
	// (idempotent) so a fresh boot is STA-only until a reservation activates.
	if apCtl != nil {
		if err := apCtl.Down(ctx); err != nil {
			log.Printf("startup ap down: %v", err)
		}
	}

	// Live DUT discovery: poll for hot-plugged/removed boards and sync them in.
	if mon != nil {
		go mon.run(ctx, mgr, *discoverInterval)
	}

	// Reap expired leases periodically.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				mgr.ReapExpired(ctx)
			}
		}
	}()

	srv := &http.Server{Addr: *addr, Handler: routes(ctx, mgr, brk)}
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sc)
	}()

	log.Printf("hitl-managerd: rig=%q listening on %s (image=%s lease=%s)", *rig, *addr, *image, *lease)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

// dutSpec is the JSON shape of a --dut flag value.
type dutSpec struct {
	Name    string            `json:"name"`
	SSHPort int               `json:"ssh_port"`
	Devices []string          `json:"devices"`
	Env     map[string]string `json:"env"`
}

// buildDevices turns the --dut flags into runner.Devices. With no --dut flags it
// synthesizes a single DUT from the legacy --ssh-port/--device flags, preserving
// the original single-DUT behavior. It rejects duplicate names and ports so a
// misconfiguration can't collide two DUTs onto one container port.
func buildDevices(duts []string, sshPort int, devices []string) ([]runner.Device, error) {
	if len(duts) == 0 {
		return []runner.Device{{Name: "dut0", SSHPort: sshPort, Devices: devices}}, nil
	}
	var out []runner.Device
	names, ports := map[string]bool{}, map[int]bool{}
	for i, raw := range duts {
		var s dutSpec
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			return nil, fmt.Errorf("--dut #%d %q: %w", i+1, raw, err)
		}
		if s.Name == "" {
			return nil, fmt.Errorf("--dut #%d: name is required", i+1)
		}
		if s.SSHPort == 0 {
			return nil, fmt.Errorf("--dut %q: ssh_port is required", s.Name)
		}
		if names[s.Name] {
			return nil, fmt.Errorf("--dut %q: duplicate name", s.Name)
		}
		if ports[s.SSHPort] {
			return nil, fmt.Errorf("--dut %q: ssh_port %d already used by another DUT", s.Name, s.SSHPort)
		}
		names[s.Name], ports[s.SSHPort] = true, true
		out = append(out, runner.Device{Name: s.Name, SSHPort: s.SSHPort, Devices: s.Devices, Env: s.Env})
	}
	return out, nil
}

// board is one physical DUT discovered on the host, identified by a stable name
// derived from its USB serial — so it keeps that identity across re-enumeration
// and hot-plug, rather than a boot-order slot. Port assignment is the monitor's
// job (sticky per name), not the board's, so unplugging one board never renames
// or renumbers another.
type board struct {
	name    string
	devices []string          // --device mappings (tty pinned to /dev/ttyACM0)
	env     map[string]string // e.g. HITL_ADAPTER_SERIAL for JTAG
}

// boardsFromByID turns /dev/serial/by-id paths into boards. It keeps only each
// board's primary CDC-ACM interface (…-if00, or names with no -if token) so a
// composite device's secondary interfaces don't spawn phantom DUTs, dedupes by
// the resolved tty (and by derived name), pins each tty to /dev/ttyACM0 in the
// container (so the toolbox's defaults hold on every DUT), and — for ESP32-C6
// built-in USB-JTAG boards — lifts HITL_ADAPTER_SERIAL so JTAG selects the
// matching adapter among identical boards. Sorted by name for deterministic output.
func boardsFromByID(paths []string) []board {
	seenTTY, seenName := map[string]bool{}, map[string]bool{}
	var out []board
	for _, path := range paths {
		base := filepath.Base(path)
		// Skip secondary interfaces of composite USB devices (…-if01/-if02/…);
		// keep the primary data interface (…-if00) or names with no -if token.
		if i := strings.Index(base, "-if"); i >= 0 && !strings.HasPrefix(base[i:], "-if00") {
			continue
		}
		// Dedupe by the resolved device node. A dangling symlink (EvalSymlinks
		// error) falls back to the path itself, which is still unique per entry.
		target := path
		if r, err := filepath.EvalSymlinks(path); err == nil {
			target = r
		}
		if seenTTY[target] {
			continue
		}
		name := dutNameFromByID(base)
		if seenName[name] {
			continue // serial-tail collision (rare); keep the first, ignore the twin.
		}
		seenTTY[target], seenName[name] = true, true
		b := board{name: name, devices: []string{path + ":/dev/ttyACM0"}}
		if s := espSerialFromByID(base); s != "" {
			b.env = map[string]string{"HITL_ADAPTER_SERIAL": s}
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// dutNameFromByID derives a stable, shell-safe DUT name from a by-id name: the
// board's USB serial (a C6's is its MAC), trimmed to a short suffix. Because it's
// tied to the board, the name follows the physical device across re-enumeration
// and hot-plug — an agent that pins `--device c6-071234` keeps the same board.
func dutNameFromByID(base string) string {
	id := espSerialFromByID(base)
	if id == "" {
		// Non-Espressif adapter: fall back to the by-id tail (drop usb-/…-ifXX).
		id = strings.TrimPrefix(base, "usb-")
		if i := strings.Index(id, "-if"); i >= 0 {
			id = id[:i]
		}
	}
	var b strings.Builder
	for _, r := range id {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteByte(byte(r))
		}
	}
	s := strings.ToLower(b.String())
	if len(s) > 6 {
		s = s[len(s)-6:]
	}
	return "c6-" + s
}

// espSerialFromByID pulls the USB serial out of an ESP32-C6 built-in
// USB-JTAG/serial by-id name (usb-Espressif_USB_JTAG_serial_debug_unit_<serial>-if00);
// openocd matches that value via `adapter serial`. Empty for other adapters,
// whose by-id names don't carry a serial openocd can select on — leaving JTAG to
// auto-pick the sole board, which is correct for a single-board rig.
func espSerialFromByID(base string) string {
	const prefix = "usb-Espressif_USB_JTAG_serial_debug_unit_"
	if !strings.HasPrefix(base, prefix) {
		return ""
	}
	s := strings.TrimPrefix(base, prefix)
	if i := strings.Index(s, "-if"); i >= 0 {
		s = s[:i]
	}
	return s
}

// dutMonitor discovers DUTs from a by-id glob and remembers each board across
// scans: its sshd port is sticky (so a board keeps its port — and its live
// reservation — even when a different board is unplugged), and a board is only
// treated as gone once it has been absent continuously for `retention`.
//
// Retention is deliberately generous: an ESP32-C6 re-enumerates its USB on every
// reset, so a DUT that's resetting (even in a tight reboot loop) blinks out of
// individual scans but is seen again within seconds — far inside the window — so
// it's never dropped. Only a board truly gone (unplugged) for the whole window is
// removed. Driven from a single goroutine; not safe for concurrent use.
type dutMonitor struct {
	glob      string
	basePort  int
	maxDuts   int
	retention time.Duration
	now       func() time.Time         // injectable for tests
	last      map[string]runner.Device // stable name -> last-known DUT (sticky port/spec)
	seen      map[string]time.Time     // stable name -> last time the board was present
}

func newDUTMonitor(glob string, basePort, maxDuts int, retention time.Duration) *dutMonitor {
	return &dutMonitor{
		glob:      glob,
		basePort:  basePort,
		maxDuts:   maxDuts,
		retention: retention,
		now:       time.Now,
		last:      map[string]runner.Device{},
		seen:      map[string]time.Time{},
	}
}

// scan globs the host and returns the retained DUT set with sticky ports. A glob
// error is returned; an empty match is not one (no board plugged in yet).
func (dm *dutMonitor) scan() ([]runner.Device, error) {
	matches, err := filepath.Glob(dm.glob)
	if err != nil {
		return nil, fmt.Errorf("discover glob %q: %w", dm.glob, err)
	}
	boards := boardsFromByID(matches)
	now := dm.now()

	used := map[int]bool{}
	for _, d := range dm.last {
		used[d.SSHPort] = true
	}
	// Present boards: stamp last-seen and, for a newly-seen board, allocate a
	// sticky port. Existing boards keep their port and by-id spec (the by-id path
	// is serial-stable, and the runner re-resolves it to the live node at start).
	present := map[string]bool{}
	for _, b := range boards {
		present[b.name] = true
		dm.seen[b.name] = now
		if _, ok := dm.last[b.name]; ok {
			continue
		}
		port := dm.allocPort(used)
		if port == 0 {
			log.Printf("discover: %s attached but all %d DUT ports are in use; ignoring", b.name, dm.maxDuts)
			continue
		}
		used[port] = true
		dm.last[b.name] = runner.Device{Name: b.name, SSHPort: port, Devices: b.devices, Env: b.env}
	}
	// Absent boards: drop (and free the port of) only those gone for the whole
	// retention window; a briefly-missing board (resetting DUT) is kept.
	for name := range dm.last {
		if present[name] {
			continue
		}
		if now.Sub(dm.seen[name]) > dm.retention {
			delete(dm.last, name)
			delete(dm.seen, name)
		}
	}

	out := make([]runner.Device, 0, len(dm.last))
	for _, d := range dm.last {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// allocPort returns the lowest free port in [basePort, basePort+maxDuts), or 0
// if the range is exhausted.
func (dm *dutMonitor) allocPort(used map[int]bool) int {
	for i := 0; i < dm.maxDuts; i++ {
		if p := dm.basePort + i; !used[p] {
			return p
		}
	}
	return 0
}

// run polls the by-id glob every interval and syncs the manager's DUT set, so
// boards hot-plugged (or unplugged) after boot come and go without a restart.
func (dm *dutMonitor) run(ctx context.Context, mgr *queue.Manager, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			devs, err := dm.scan()
			if err != nil {
				log.Printf("discover: %v", err)
				continue
			}
			added, removed := mgr.SyncDevices(ctx, devs)
			for _, n := range added {
				log.Printf("discover: DUT %s attached", n)
			}
			for _, n := range removed {
				log.Printf("discover: DUT %s removed", n)
			}
		}
	}
}

func routes(ctx context.Context, mgr *queue.Manager, brk *analyzer.Broker) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Shared-analyzer capture: decode the tapped LED line for a DUT. The FX2 is a
	// rig-level instrument the daemon owns; the broker serializes access and maps
	// the DUT to its channel subset. Reachable by reservation containers
	// (host.containers.internal) and over the tailnet (the e2e harness).
	mux.HandleFunc("POST /capture", func(w http.ResponseWriter, r *http.Request) {
		if !brk.Enabled() {
			writeErr(w, http.StatusServiceUnavailable, "this rig has no logic analyzer configured")
			return
		}
		var req api.CaptureRequest
		// Body is optional (an empty POST captures the default DUT mapping).
		if r.Body != nil && r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
				return
			}
		}
		if req.Device != "" && !mgr.HasDevice(req.Device) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown device %q; rig has %v", req.Device, mgr.Devices()))
			return
		}
		res, err := brk.Capture(r.Context(), req)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	// Read/write the shared analyzer's DUT→channel map at runtime. `map_la` walks
	// the rig's DUTs (blinking each one's LED), asks the operator which analyzer
	// channel each is wired to, and POSTs the assembled map here — which the broker
	// applies live and persists, so the mapping "sticks to the board" across
	// reboots with no redeploy. GET returns the current map for display/verify.
	mux.HandleFunc("GET /analyzer/channel-map", func(w http.ResponseWriter, r *http.Request) {
		if !brk.Enabled() {
			writeErr(w, http.StatusServiceUnavailable, "this rig has no logic analyzer configured")
			return
		}
		js, err := analyzer.MarshalChannelMap(brk.Snapshot())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(js)
	})

	mux.HandleFunc("POST /analyzer/channel-map", func(w http.ResponseWriter, r *http.Request) {
		if !brk.Enabled() {
			writeErr(w, http.StatusServiceUnavailable, "this rig has no logic analyzer configured")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
		m, err := analyzer.ParseChannelMap(string(body))
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		// Every non-default key must name a real DUT on this rig, so a typo can't
		// silently write a mapping that never matches a capture.
		for name := range m {
			if name == "" {
				continue
			}
			if !mgr.HasDevice(name) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown device %q; rig has %v", name, mgr.Devices()))
				return
			}
		}
		if err := brk.SetMap(m); err != nil {
			writeErr(w, http.StatusInternalServerError, "persist channel map: "+err.Error())
			return
		}
		// Refresh the /status capability snapshot so its channel list tracks the
		// live map (Describe() recomputes distinct channels from the new map).
		mgr.SetAnalyzer(brk.Describe())
		js, _ := analyzer.MarshalChannelMap(brk.Snapshot())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(js)
	})

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, mgr.Status())
	})

	mux.HandleFunc("POST /reserve", func(w http.ResponseWriter, r *http.Request) {
		var req api.ReserveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		if strings.TrimSpace(req.SSHPublicKey) == "" {
			writeErr(w, http.StatusBadRequest, "ssh_public_key is required")
			return
		}
		if req.Device != "" && !mgr.HasDevice(req.Device) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown device %q; rig has %v", req.Device, mgr.Devices()))
			return
		}
		writeJSON(w, http.StatusAccepted, mgr.Reserve(ctx, req))
	})

	mux.HandleFunc("GET /reservation/{id}", func(w http.ResponseWriter, r *http.Request) {
		res, err := mgr.Get(r.PathValue("id"))
		if err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /reservation/{id}/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if err := mgr.Heartbeat(r.PathValue("id")); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		res, _ := mgr.Get(r.PathValue("id"))
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /reservation/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		if err := mgr.Release(ctx, r.PathValue("id"), "released by holder"); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	return logging(mux)
}

func logging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, api.Error{Error: msg})
}
