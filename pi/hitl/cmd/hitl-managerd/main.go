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
	"github.com/fughilli/splanc/pi/hitl/internal/metrics"
	"github.com/fughilli/splanc/pi/hitl/internal/queue"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
	"github.com/fughilli/splanc/pi/hitl/internal/skus"
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
	// BLE HCI capture (btmon). Runs host-side (the daemon is root; btmon needs an
	// HCI monitor socket the unprivileged container lacks) and bind-mounts its
	// btsnoop read-only into the reservation container. Bounded so it can't fill
	// the rig disk. --btmon="" (or an empty path) disables it.
	btmonBin := flag.String("btmon", "btmon", "btmon binary for per-reservation BLE HCI capture (empty disables capture)")
	btmonSize := flag.Int64("btmon-size-bytes", 64<<20, "hard size cap for a capture's btsnoop file, in bytes")
	btmonMax := flag.Duration("btmon-max", 30*time.Minute, "max wall-clock for a single BLE HCI capture")
	// BLE central adapter selection. Empty = the system default controller (onboard).
	// A literal like "hci1" pins that controller; the special value "usb" resolves
	// the USB Bluetooth controller (a dongle) by bus at runtime — used to route BLE
	// around a marginal onboard controller. Threads into btmon (-i) and the
	// container's bleak ($HITL_BLE_ADAPTER). See runner.PodmanConfig.BLEAdapter.
	bleAdapter := flag.String("ble-adapter", "", `BLE central adapter: "" = system default, "hciN" pins one, "usb" auto-resolves the USB controller`)
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
	// Seeded network DUTs (non-USB, e.g. a Raspberry Pi reached over the LAN and
	// provisioned over BLE): a JSON array of dutSpec with kind=="network", written
	// onto the running rig out of band (scripts/seed-network-dut.sh). Ingested live
	// by the same --discover monitor; their sshd ports come from a dedicated range
	// ABOVE the USB pool (so a hot-plugged board can never steal one).
	networkDutsFile := flag.String("network-duts-file", "", "seeded network-DUT JSON file (default <state-dir>/network-duts.json); ingested in --discover mode")
	networkMax := flag.Int("network-max-duts", 4, "max concurrent seeded network DUTs (sshd port range just above the --discover pool)")
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
		Image:           *image,
		Host:            *host,
		SSHUser:         *sshUser,
		StateDir:        *stateDir,
		Podman:          *podman,
		Privileged:      *privileged,
		CaptureURL:      *containerCaptureURL,
		Btmon:           *btmonBin,
		CaptureMaxBytes: *btmonSize,
		CaptureMaxDur:   *btmonMax,
		BLEAdapter:      *bleAdapter,
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
		devs, err = buildDevices(duts, *sshPort, devices, brk)
	case *discover:
		netFile := *networkDutsFile
		if netFile == "" {
			netFile = filepath.Join(*stateDir, "network-duts.json")
		}
		mon = newDUTMonitor(*discoverGlob, *sshPort, *discoverMax, *discoverRetention, netFile, *networkMax, brk)
		devs, err = mon.scan()
		if err == nil && len(devs) == 0 {
			log.Printf("discover: no DUTs matched %q yet; will attach them live as they appear", *discoverGlob)
		}
	default:
		devs, err = buildDevices(nil, *sshPort, devices, brk)
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

// dutSpec is the JSON shape of a --dut flag value (and of an entry in the seeded
// network-DUT file). Kind selects the wiring: "" (== "usb") maps the board's
// serial/JTAG nodes in; "network" is a LAN DUT with no board (see runner.Device).
type dutSpec struct {
	Name    string            `json:"name"`
	Kind    string            `json:"kind,omitempty"`
	SKU     string            `json:"sku,omitempty"`
	SSHPort int               `json:"ssh_port"`
	Devices []string          `json:"devices"`
	Env     map[string]string `json:"env"`
}

// defaultUSBSKU is the SKU assumed for a USB DUT that doesn't name one — the rigs
// only host ESP32-C6 player boards over USB, so an auto-discovered board is one.
const defaultUSBSKU = "esp32c6"

// withCaps fills a Device's Capabilities from its SKU (the registry), warning on an
// unknown SKU (which yields no capabilities — the DUT then matches no requirement).
// It also merges in rig-wiring capabilities that aren't SKU traits: a DUT tapped by
// this rig's shared logic analyzer advertises "logic-analyzer", so capability
// selection (and best-fit) treat the analyzer like any other capability. brk may be
// nil (no analyzer on this rig).
func withCaps(d runner.Device, brk *analyzer.Broker) runner.Device {
	if d.SKU != "" && !skus.Known(d.SKU) {
		log.Printf("dut %s: unknown SKU %q; advertising no capabilities", d.Name, d.SKU)
	}
	caps := skus.Capabilities(d.SKU)
	if brk.Taps(d.Name) {
		caps = append(caps, "logic-analyzer")
		sort.Strings(caps)
	}
	d.Capabilities = caps
	return d
}

// buildDevices turns the --dut flags into runner.Devices. With no --dut flags it
// synthesizes a single DUT from the legacy --ssh-port/--device flags, preserving
// the original single-DUT behavior. It rejects duplicate names and ports so a
// misconfiguration can't collide two DUTs onto one container port.
func buildDevices(duts []string, sshPort int, devices []string, brk *analyzer.Broker) ([]runner.Device, error) {
	if len(duts) == 0 {
		return []runner.Device{withCaps(runner.Device{Name: "dut0", SKU: defaultUSBSKU, SSHPort: sshPort, Devices: devices}, brk)}, nil
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
		sku := s.SKU
		if sku == "" && s.Kind != "network" {
			sku = defaultUSBSKU // an explicit USB DUT that omits its SKU is a C6
		}
		out = append(out, withCaps(runner.Device{Name: s.Name, Kind: s.Kind, SKU: sku, SSHPort: s.SSHPort, Devices: s.Devices, Env: s.Env}, brk))
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

	// Seeded network DUTs, read from networkFile each poll. Their sshd ports come
	// from a dedicated range [netBase, netBase+netMax) above the USB pool, so a
	// hot-plugged board can never collide with one. netLast keeps ports sticky by
	// name; lastGoodNetwork is the last cleanly-parsed set, reused if a later read
	// is malformed so a bad write never disturbs the USB DUTs.
	networkFile     string
	netBase, netMax int
	netLast         map[string]runner.Device
	lastGoodNetwork []runner.Device

	brk *analyzer.Broker // resolves the per-DUT "logic-analyzer" capability (may be nil)
}

func newDUTMonitor(glob string, basePort, maxDuts int, retention time.Duration, networkFile string, netMax int, brk *analyzer.Broker) *dutMonitor {
	return &dutMonitor{
		glob:        glob,
		basePort:    basePort,
		maxDuts:     maxDuts,
		retention:   retention,
		now:         time.Now,
		last:        map[string]runner.Device{},
		seen:        map[string]time.Time{},
		networkFile: networkFile,
		netBase:     basePort + maxDuts, // dedicated range, above the USB pool
		netMax:      netMax,
		netLast:     map[string]runner.Device{},
		brk:         brk,
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
		dm.last[b.name] = withCaps(runner.Device{Name: b.name, SKU: defaultUSBSKU, SSHPort: port, Devices: b.devices, Env: b.env}, dm.brk)
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

// networkDUTPrefixes bound a seeded DUT's name so it can never collide with a
// discovered board (c6-*). A network DUT must be pi-* or net-*.
var networkDUTPrefixes = []string{"pi-", "net-"}

func hasNetworkPrefix(name string) bool {
	for _, p := range networkDUTPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// readNetworkDUTs loads the seeded network-DUT file: a JSON array of dutSpec with
// kind=="network". It returns them as runner.Devices with sticky sshd ports from
// the dedicated [netBase, netBase+netMax) range. An absent file is not an error
// (returns nil, and forgets any previously-seeded DUTs so they're removed). A
// parse/validation error is returned WITHOUT mutating state, so the caller can
// keep the last good set and leave the USB DUTs untouched. Runs on the monitor's
// single goroutine, so netLast needs no lock.
func (dm *dutMonitor) readNetworkDUTs() ([]runner.Device, error) {
	if dm.networkFile == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(dm.networkFile)
	if err != nil {
		if os.IsNotExist(err) {
			dm.netLast = map[string]runner.Device{}
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", dm.networkFile, err)
	}
	var specs []dutSpec
	if err := json.Unmarshal(raw, &specs); err != nil {
		return nil, fmt.Errorf("parse %s: %w", dm.networkFile, err)
	}
	used := map[int]bool{}
	for _, d := range dm.netLast {
		used[d.SSHPort] = true
	}
	names := map[string]bool{}
	next := map[string]runner.Device{}
	out := make([]runner.Device, 0, len(specs))
	for i, s := range specs {
		switch {
		case s.Name == "":
			return nil, fmt.Errorf("network-dut #%d: name is required", i+1)
		case !hasNetworkPrefix(s.Name):
			return nil, fmt.Errorf("network-dut %q: name must start with pi- or net-", s.Name)
		case s.Kind != "network":
			return nil, fmt.Errorf("network-dut %q: kind must be %q", s.Name, "network")
		case len(s.Devices) != 0:
			return nil, fmt.Errorf("network-dut %q: devices must be empty (no board on this rig)", s.Name)
		case s.Env["HITL_DUT_ADDR"] == "":
			return nil, fmt.Errorf("network-dut %q: env.HITL_DUT_ADDR is required", s.Name)
		case s.SKU == "":
			return nil, fmt.Errorf("network-dut %q: sku is required (e.g. led-mapper-pi)", s.Name)
		case names[s.Name]:
			return nil, fmt.Errorf("network-dut %q: duplicate name", s.Name)
		}
		names[s.Name] = true
		// Sticky port: reuse the DUT's prior port if we've seen it, else allocate
		// the lowest free one from the dedicated network range.
		port := 0
		if prev, ok := dm.netLast[s.Name]; ok {
			port = prev.SSHPort
		} else if port = dm.allocNetPort(used); port == 0 {
			log.Printf("network-dut: %s seeded but all %d network ports are in use; ignoring", s.Name, dm.netMax)
			continue
		}
		used[port] = true
		dev := withCaps(runner.Device{Name: s.Name, Kind: "network", SKU: s.SKU, SSHPort: port, Env: s.Env}, dm.brk)
		next[s.Name] = dev
		out = append(out, dev)
	}
	dm.netLast = next
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// allocNetPort returns the lowest free port in the dedicated network range, or 0.
func (dm *dutMonitor) allocNetPort(used map[int]bool) int {
	for i := 0; i < dm.netMax; i++ {
		if p := dm.netBase + i; !used[p] {
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
			// Merge seeded network DUTs. A malformed/partly-written file must NOT
			// disturb the USB DUTs: on error, keep the last good network set.
			net, nerr := dm.readNetworkDUTs()
			if nerr != nil {
				log.Printf("network-dut: %v; keeping %d cached", nerr, len(dm.lastGoodNetwork))
				net = dm.lastGoodNetwork
			} else {
				dm.lastGoodNetwork = net
			}
			all := append(append(make([]runner.Device, 0, len(devs)+len(net)), devs...), net...)
			added, removed := mgr.SyncDevices(ctx, all)
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

	// Prometheus scrape endpoint. Grafana Alloy (or any Prometheus agent) running
	// on the rig scrapes this and remote_writes to Grafana Cloud — see
	// observability/README.md. Emits reservation-queue + per-DUT occupancy metrics
	// alongside host CPU/memory/temperature.
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		writeMetrics(w, mgr.Metrics(), metrics.ReadHost())
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

	// BLE HCI (btmon) capture for a reservation's own BLE session. start/stop
	// require an active reservation; the btsnoop is read back from the container's
	// read-only mount (see the `hitl btmon` CLI), not streamed through the API.
	mux.HandleFunc("POST /reservation/{id}/btmon/start", func(w http.ResponseWriter, r *http.Request) {
		st, err := mgr.StartCapture(ctx, r.PathValue("id"))
		if err != nil {
			writeCaptureErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})

	mux.HandleFunc("POST /reservation/{id}/btmon/stop", func(w http.ResponseWriter, r *http.Request) {
		st, err := mgr.StopCapture(ctx, r.PathValue("id"))
		if err != nil {
			writeCaptureErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})

	mux.HandleFunc("GET /reservation/{id}/btmon", func(w http.ResponseWriter, r *http.Request) {
		st, err := mgr.CaptureStatus(r.PathValue("id"))
		if err != nil {
			writeCaptureErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})

	return logging(mux)
}

// writeMetrics renders the daemon's Prometheus exposition: reservation-queue and
// per-DUT occupancy gauges + lifecycle counters from the manager, plus host
// CPU/memory/temperature. Every series carries a `rig` label so several rigs can
// remote_write into one Grafana Cloud tenant and stay distinguishable even if the
// collector adds no target labels. Kept separate from the HTTP handler so it can
// be unit-tested against a fixed snapshot.
func writeMetrics(w io.Writer, snap queue.MetricsSnapshot, host metrics.HostStats) {
	mw := metrics.NewWriter(w)
	rig := metrics.Label{Name: "rig", Value: snap.Rig}

	mw.Gauge("hitl_up", "1 if the reservation daemon is serving.", 1, rig)
	mw.Gauge("hitl_duts_total", "Configured DUTs on this rig.", float64(snap.DUTsTotal), rig)
	mw.Gauge("hitl_duts_busy", "DUTs with an active reservation.", float64(snap.DUTsBusy), rig)
	mw.Gauge("hitl_queue_depth", "Reservations queued waiting for a DUT.", float64(snap.QueueDepth), rig)
	mw.Gauge("hitl_active_reservations", "Reservations currently active (one per busy DUT).", float64(snap.ActiveTotal), rig)
	mw.Gauge("hitl_lease_seconds", "Heartbeat lease window.", snap.LeaseSeconds, rig)

	// Per-DUT occupancy, so a dashboard can show which specific board is busy.
	for _, d := range snap.Devices {
		v := 0.0
		if d.Busy {
			v = 1
		}
		mw.Gauge("hitl_dut_busy", "1 if this DUT has an active reservation.", v,
			rig, metrics.Label{Name: "device", Value: d.Name})
	}

	mw.Counter("hitl_reservations_total", "Reservations enqueued since start.", float64(snap.Reservations), rig)
	mw.Counter("hitl_activations_total", "Reservations that became active since start.", float64(snap.Activations), rig)
	mw.Counter("hitl_releases_total", "Reservations ended (any reason) since start.", float64(snap.Releases), rig)
	mw.Counter("hitl_lease_expirations_total", "Reservations reaped for a lapsed lease since start.", float64(snap.LeaseExpiries), rig)
	mw.Counter("hitl_start_failures_total", "Container start failures during reconcile since start.", float64(snap.StartFailures), rig)

	if host.Load1OK {
		mw.Gauge("hitl_host_load1", "Host 1-minute load average.", host.Load1, rig)
	}
	if host.MemOK {
		mw.Gauge("hitl_host_memory_total_bytes", "Host total memory.", host.MemTotalBytes, rig)
		mw.Gauge("hitl_host_memory_available_bytes", "Host available memory.", host.MemAvailableBytes, rig)
	}
	if host.TempOK {
		mw.Gauge("hitl_host_temperature_celsius", "Host SoC temperature.", host.TempCelsius, rig)
	}
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

// writeCaptureErr maps a capture control error to a status: an unknown
// reservation is 404; a known-but-not-active one (or a disabled/failed capture)
// is 409 Conflict.
func writeCaptureErr(w http.ResponseWriter, err error) {
	if errors.Is(err, queue.ErrNotFound) {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeErr(w, http.StatusConflict, err.Error())
}
