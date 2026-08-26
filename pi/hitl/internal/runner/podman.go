package runner

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// PodmanConfig configures how test containers are launched. Per-DUT settings
// (ssh port, device nodes, env) live on runner.Device, passed to Start.
type PodmanConfig struct {
	// Image is the OCI image reference for the test environment.
	Image string
	// Host is the address holders use to reach this machine (its tailnet name).
	Host string
	// SSHUser is the login user inside the container.
	SSHUser string
	// StateDir is a writable dir for per-reservation scratch (authorized_keys).
	StateDir string
	// Podman is the podman binary (defaults to "podman" on PATH).
	Podman string
	// CaptureURL, if set, is injected into each container as $HITL_CAPTURE_SERVER
	// so the `hitl-capture` toolbox client can reach the daemon's shared logic
	// analyzer (/capture) — typically http://host.containers.internal:<apiPort>.
	CaptureURL string
	// Privileged runs the container privileged. AVOID on a multi-DUT rig: a
	// privileged container bind-mounts the whole host /dev, so every DUT's
	// /dev/ttyACM* leaks into every container — an agent sees its neighbor's board.
	// With it off, the container is confined to the explicit per-DUT --device (its
	// own tty as /dev/ttyACM0) plus its own board's node in a private /dev/bus/usb
	// (see isolateUSB), which are enough for the C6's serial and USB-JTAG while
	// keeping raw USB isolated per DUT. Kept as an escape hatch.
	Privileged bool
	// Btmon is the host btmon binary used for per-reservation BLE HCI capture.
	// Empty disables capture (StartCapture then returns an error). btmon runs on
	// the HOST (as root, where the daemon runs) because it needs an AF_BLUETOOTH
	// HCI monitor socket + CAP_NET_RAW/ADMIN the unprivileged container lacks; its
	// btsnoop file is bind-mounted read-only into the reservation container.
	Btmon string
	// CaptureMaxBytes is the hard size cap for a capture's btsnoop file (0 = a
	// built-in default). A watchdog stops a capture at this size so it can't fill
	// the rig disk.
	CaptureMaxBytes int64
	// CaptureMaxDur is the max wall-clock for a single capture (0 = a built-in
	// default). A watchdog stops a capture after this so a forgotten one is bounded.
	CaptureMaxDur time.Duration
	// BLEAdapter selects the BLE central controller for this rig. Empty = the system
	// default (onboard). A literal "hciN" pins that controller. The special value
	// "usb" resolves the USB Bluetooth controller by bus at runtime (see
	// resolveBLEAdapter) — used to route BLE around a marginal onboard controller
	// (Pi 5 Cypress) and onto a USB dongle. When it resolves non-empty it is
	// injected into the container as $HITL_BLE_ADAPTER (bleak) and passed to btmon
	// as `-i <hci>` (see capture.go).
	BLEAdapter string
}

// PodmanRunner implements Runner by shelling out to podman.
type PodmanRunner struct {
	cfg PodmanConfig
	// usbSync holds the cancel func for each reservation's raw-USB refresher, which
	// keeps that container's private /dev/bus/usb node current across the board's
	// re-enumerations. Cancelled on Stop/Cleanup.
	mu      sync.Mutex
	usbSync map[string]func()
	// captures holds each reservation's live BLE HCI capture (btmon), keyed on
	// reservation id. Cancelled/reaped on StopCapture/Stop/Cleanup. See capture.go.
	captures map[string]*capture
}

func NewPodman(cfg PodmanConfig) *PodmanRunner {
	if cfg.Podman == "" {
		cfg.Podman = "podman"
	}
	if cfg.SSHUser == "" {
		cfg.SSHUser = "agent"
	}
	return &PodmanRunner{cfg: cfg, usbSync: map[string]func(){}, captures: map[string]*capture{}}
}

// containerName is deterministic per reservation so Stop/Cleanup can find it.
func containerName(id string) string { return "hitl-" + id }

// resolveBLEAdapter turns the configured BLEAdapter into a concrete "hciN" (or ""
// for the system default). "usb" is resolved fresh each call by bus, so it tracks
// the dongle's actual hci index regardless of enumeration order and tolerates the
// controller not being up yet at daemon start (it just resolves once it appears).
func (p *PodmanRunner) resolveBLEAdapter() string {
	switch p.cfg.BLEAdapter {
	case "":
		return ""
	case "usb":
		hci := resolveUSBHCI()
		if hci == "" {
			// Configured to use the dongle but none is up — fall back to the default
			// controller rather than breaking BLE, and say so (this is the flaky path).
			log.Printf("ble-adapter=usb: no USB Bluetooth controller found; using system default")
		}
		return hci
	default:
		return p.cfg.BLEAdapter
	}
}

// resolveUSBHCI returns the name (e.g. "hci1") of the first Bluetooth controller on
// the USB bus that is actually UP, or "" if none. It reads
// /sys/class/bluetooth/hci*/device: a USB controller's device path resolves under
// .../usbN/... while the onboard Pi controller sits on a serial/platform path — a
// stable discriminator that doesn't depend on the hciN numbering. It then requires
// the controller to be UP (see hciUp): a dongle can be enumerated (present in
// sysfs) but DOWN — e.g. its RTL firmware never loaded — in which case BlueZ does
// not expose it and bleak fails "adapter 'hciN' not found". Selecting such a dead
// adapter would be worse than the onboard fallback, so skip it. Entries are sorted
// for a deterministic pick.
func resolveUSBHCI() string { return resolveUSBHCIIn("/sys/class/bluetooth", hciUp) }

// resolveUSBHCIIn is resolveUSBHCI against an arbitrary bluetooth-class root, with
// an injectable up-check (for tests). A controller is "USB" if its device symlink
// resolves to a path with a "/usb" segment, and is only returned if isUp(devID).
func resolveUSBHCIIn(root string, isUp func(devID int) bool) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "hci") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		dev, err := filepath.EvalSymlinks(filepath.Join(root, n, "device"))
		if err != nil {
			continue
		}
		// USB device paths contain a "/usbN/" hub segment (e.g. .../usb3/3-1/3-1:1.0).
		if !strings.Contains(dev, "/usb") {
			continue
		}
		id, err := strconv.Atoi(strings.TrimPrefix(n, "hci"))
		if err != nil {
			continue
		}
		if isUp(id) {
			return n
		}
		log.Printf("ble-adapter=usb: %s is a USB controller but DOWN; skipping", n)
	}
	return ""
}

// hciUp reports whether Bluetooth controller hci<devID> is UP, via the kernel's
// HCIGETDEVINFO ioctl (the same HCI_UP flag `hciconfig` shows). sysfs exposes no
// up/down attribute for hci devices, so this is the authoritative check. Returns
// false on any error (no AF_BLUETOOTH support, no such device) — callers then fall
// back to the default controller. Linux-only; the daemon runs as root on the rig.
func hciUp(devID int) bool {
	const (
		afBluetooth  = 31         // AF_BLUETOOTH
		btprotoHCI   = 1          // BTPROTO_HCI
		hcigetDevInfo = 0x800448D3 // _IOR('H', 211, int)
		flagsOffset  = 16         // offset of __u32 flags in struct hci_dev_info
		hciUpBit     = 1 << 0     // HCI_UP
	)
	fd, err := syscall.Socket(afBluetooth, syscall.SOCK_RAW, btprotoHCI)
	if err != nil {
		return false
	}
	defer syscall.Close(fd)
	// struct hci_dev_info: {u16 dev_id; char name[8]; bdaddr[6]; u32 flags; ...}.
	// Set dev_id, ioctl fills the rest; read the flags word back.
	var buf [144]byte
	binary.LittleEndian.PutUint16(buf[0:2], uint16(devID))
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd),
		uintptr(hcigetDevInfo), uintptr(unsafe.Pointer(&buf[0]))); errno != 0 {
		return false
	}
	flags := binary.LittleEndian.Uint32(buf[flagsOffset : flagsOffset+4])
	return flags&hciUpBit != 0
}

func (p *PodmanRunner) podman(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, p.cfg.Podman, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("podman %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (p *PodmanRunner) Start(ctx context.Context, id, owner, sshKey string, dev Device) (*api.SSHEndpoint, error) {
	name := containerName(id)
	// Fresh start: remove any stale container with this name.
	_, _ = p.podman(ctx, "rm", "-f", name)

	// Write the holder's authorized_keys to a per-reservation file and mount it.
	keyDir := filepath.Join(p.cfg.StateDir, id)
	if err := os.MkdirAll(keyDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir state: %w", err)
	}
	authKeys := filepath.Join(keyDir, "authorized_keys")
	if err := os.WriteFile(authKeys, []byte(strings.TrimSpace(sshKey)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write authorized_keys: %w", err)
	}

	args := []string{
		"run", "-d", "--name", name,
		"--label", "hitl=1",
		"--label", "hitl.owner=" + owner,
		"--label", "hitl.device=" + dev.Name,
		// Publish the container sshd on this DUT's host port (distinct per DUT so
		// several containers coexist).
		"-p", fmt.Sprintf("%d:22", dev.SSHPort),
		// The holder's key, mounted read-only; the entrypoint installs it.
		"-v", authKeys + ":/run/hitl/authorized_keys:ro",
		"-e", "HITL_SSH_USER=" + p.cfg.SSHUser,
		// Tell the holder which DUT they got, visible in their SSH session (echo
		// $HITL_DUT). Their board's tty is also pinned to /dev/ttyACM0, so the
		// toolbox targets it by default without needing the name.
		"-e", "HITL_DUT=" + dev.Name,
	}
	// The shared logic analyzer is brokered by the daemon (not passed into the
	// container); tell hitl-capture where to reach it, and which DUT to capture.
	if p.cfg.CaptureURL != "" {
		args = append(args, "-e", "HITL_CAPTURE_SERVER="+p.cfg.CaptureURL)
	}
	// Per-DUT env (e.g. HITL_ADAPTER_SERIAL so openocd targets this DUT's board).
	for _, k := range sortedKeys(dev.Env) {
		args = append(args, "-e", k+"="+dev.Env[k])
	}
	// BLE central adapter: tell the container's bleak (hitl-ble, ImprovBLE
	// provisioning) which host controller to drive, so it uses the USB dongle rather
	// than the flaky onboard one. Only set when configured AND resolvable.
	if adp := p.resolveBLEAdapter(); adp != "" {
		args = append(args, "-e", "HITL_BLE_ADAPTER="+adp)
	}
	// BLE: mount the host's system D-Bus socket so bleak in the container can
	// drive the host bluetoothd (hci0). Present only if hardware.bluetooth is on.
	if _, err := os.Stat("/run/dbus/system_bus_socket"); err == nil {
		args = append(args, "-v", "/run/dbus/system_bus_socket:/run/dbus/system_bus_socket")
	}
	// BLE HCI capture: a per-reservation dir the host btmon writes its btsnoop into
	// (see capture.go), bind-mounted READ-ONLY so the agent can read the trace (and
	// `btmon -r` it) but can't tamper with it. Created empty now; StartCapture fills
	// it on demand. The container sees the host's writes live through the mount.
	captureDir := filepath.Join(keyDir, "capture")
	if err := os.MkdirAll(captureDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir capture: %w", err)
	}
	args = append(args, "-v", captureDir+":"+captureContainerDir+":ro")
	// USB wiring is for board DUTs only. A network DUT owns no board on this rig,
	// so skip it entirely: isolateUSB falls back to a WHOLE-BUS mount when a DUT
	// has no serial tty, which would expose every other DUT's board to this
	// container — the one thing per-DUT isolation must never allow. The device
	// loop is a no-op for a network DUT (empty Devices) but is guarded too for
	// clarity. The Pi is reached over the network + provisioned over BLE (dbus
	// mount + HITL_BLE_ADAPTER above), so it needs none of this.
	if dev.Kind != "network" {
		// JTAG: give the container raw USB (libusb, for openocd on the C6's built-in
		// USB-JTAG, and esptool's native-USB reset). Isolated to this DUT's board
		// where we can resolve it (see isolateUSB), else the whole bus as a fallback.
		args = append(args, p.isolateUSB(id, dev)...)
		for _, d := range dev.Devices {
			if d == "" {
				continue
			}
			arg, ok := deviceMapping(d)
			if !ok {
				// Skip devices that aren't present (e.g. the ESP32 isn't plugged in
				// yet), so a reservation can still come up for non-hardware testing.
				log.Printf("podman: device %q not present, skipping", d)
				continue
			}
			args = append(args, "--device", arg)
		}
	}
	if p.cfg.Privileged {
		args = append(args, "--privileged")
	}
	args = append(args, p.cfg.Image)

	if out, err := p.podman(ctx, args...); err != nil {
		return nil, fmt.Errorf("start: %w (%s)", err, out)
	}
	// Don't report ready until the container's sshd actually accepts connections
	// (host-key gen + exec sshd takes a couple seconds), so holders don't race it.
	if err := waitTCP(ctx, fmt.Sprintf("127.0.0.1:%d", dev.SSHPort), 60*time.Second); err != nil {
		log.Printf("podman: %s sshd not ready: %v (returning endpoint anyway)", name, err)
	}
	log.Printf("podman: started %s (owner=%q dut=%s) sshd on %s:%d", name, owner, dev.Name, p.cfg.Host, dev.SSHPort)
	return &api.SSHEndpoint{Host: p.cfg.Host, Port: dev.SSHPort, User: p.cfg.SSHUser}, nil
}

// isolateUSB returns the podman args exposing raw USB to this reservation, and —
// when it can — starts a background refresher so the container sees ONLY its own
// board over libusb, surviving the board's re-enumerations.
//
// Isolation works by giving the container a private /dev/bus/usb tree holding a
// single node (the reserved board's), instead of the host-wide bus. We can't pin
// the devnum — it moves on every reset — so we key on the board's stable physical
// USB port and re-sync the node whenever it re-enumerates (refreshUSBNodes). The
// device-cgroup rule still allows the whole USB major because the current minor
// also moves on reset; that's safe here because visibility is gated by which
// nodes exist in the private tree (only one), and an unprivileged container with
// CAP_MKNOD dropped can't create others to reach a neighbour.
//
// Falls back to the whole-bus mount when the board's port can't be resolved (e.g.
// no board attached, or a non-USB tty), so non-hardware reservations still start.
func (p *PodmanRunner) isolateUSB(id string, dev Device) []string {
	if _, err := os.Stat("/dev/bus/usb"); err != nil {
		return nil // no raw USB on this host at all
	}
	wholeBus := []string{"-v", "/dev/bus/usb:/dev/bus/usb", "--device-cgroup-rule", "c 189:* rwm"}

	tty := reservedTTYNode(dev)
	if tty == "" {
		return wholeBus
	}
	portDir, portID, err := resolveUSBPort(tty)
	if err != nil {
		log.Printf("podman: %s raw-USB isolation unavailable (%v); falling back to whole-bus mount", dev.Name, err)
		return wholeBus
	}
	node, err := readUSBNode(portDir)
	if err != nil {
		log.Printf("podman: %s raw-USB isolation unavailable (port %s: %v); whole-bus fallback", dev.Name, portID, err)
		return wholeBus
	}
	destDir := filepath.Join(p.cfg.StateDir, id, "usb", "bus", "usb")
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		log.Printf("podman: %s raw-USB isolation dir: %v; whole-bus fallback", dev.Name, err)
		return wholeBus
	}
	if err := syncUSBNodes(destDir, node); err != nil {
		log.Printf("podman: %s raw-USB node seed: %v; whole-bus fallback", dev.Name, err)
		return wholeBus
	}

	ctx, cancel := context.WithCancel(context.Background())
	p.mu.Lock()
	if prev := p.usbSync[id]; prev != nil {
		prev() // a stale refresher from a prior Start of this id
	}
	p.usbSync[id] = cancel
	p.mu.Unlock()
	go refreshUSBNodes(ctx, dev.Name, portDir, destDir)

	log.Printf("podman: %s raw USB isolated to port %s -> %s", dev.Name, portID, destDir)
	return []string{
		"-v", destDir + ":/dev/bus/usb",
		"--device-cgroup-rule", "c 189:* rwm",
		// Belt-and-suspenders: the container can't mknod a node for a neighbour's
		// board (unprivileged podman drops MKNOD already; make it explicit so the
		// isolation guarantee doesn't depend on host containers.conf).
		"--cap-drop", "mknod",
	}
}

// reservedTTYNode returns the host /dev node backing this DUT's serial tty (the
// device it pins to /dev/ttyACM0), resolved through any by-id symlink, or "" if
// the DUT has no tty mapping. That node is the anchor we resolve to a USB port.
func reservedTTYNode(dev Device) string {
	for _, d := range dev.Devices {
		host, container := d, ""
		if i := strings.LastIndex(d, ":/"); i >= 0 {
			host, container = d[:i], d[i+1:]
		}
		if container != "/dev/ttyACM0" && container != "" {
			continue // not the pinned serial tty
		}
		if r, err := filepath.EvalSymlinks(host); err == nil {
			return r
		}
		return host
	}
	return ""
}

// refreshUSBNodes keeps destDir's single node current for the container's
// lifetime. A C6 re-enumerates on every reset (devnum + node minor change), so we
// poll the board's stable port and re-sync. While the port is briefly absent
// (mid-reset), we hold the last node — a resetting board blinks out for well under
// a second, and clearing it would race a reboot loop. Only once the board has been
// gone past a grace window (genuinely unplugged) do we clear the tree, so a stale
// node can't later point at a minor the kernel reassigns to a different device.
func refreshUSBNodes(ctx context.Context, dutName, portDir, destDir string) {
	const interval = 1 * time.Second
	const grace = 5 * time.Second
	t := time.NewTicker(interval)
	defer t.Stop()
	var absentSince time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			node, err := readUSBNode(portDir)
			if err != nil {
				if absentSince.IsZero() {
					absentSince = now
				}
				if now.Sub(absentSince) >= grace {
					if err := clearUSBNodes(destDir); err != nil {
						log.Printf("podman: %s raw-USB clear: %v", dutName, err)
					}
				}
				continue
			}
			absentSince = time.Time{}
			if err := syncUSBNodes(destDir, node); err != nil {
				log.Printf("podman: %s raw-USB refresh: %v", dutName, err)
			}
		}
	}
}

// stopUSBSync cancels and forgets a reservation's raw-USB refresher, if any.
func (p *PodmanRunner) stopUSBSync(id string) {
	p.mu.Lock()
	if cancel := p.usbSync[id]; cancel != nil {
		cancel()
		delete(p.usbSync, id)
	}
	p.mu.Unlock()
}

// deviceMapping resolves one "host[:container]" --device spec into a concrete
// podman --device value, or ok=false if the host device isn't present (so a
// reservation can still come up with no board attached).
//
// Two wrinkles it handles that a naive split can't:
//   - The host may be a /dev/serial/by-id symlink whose NAME contains colons —
//     an ESP32-C6's USB serial is its MAC (…_60:55:F9:11:7D:10-if00). Splitting on
//     the first ':' would truncate the path mid-MAC. We split on the last ":/"
//     instead (the container path is always absolute), so the colons stay in the
//     host path.
//   - podman --device needs a real device node, and would itself mis-parse the
//     colons, so we resolve the symlink to its target (/dev/ttyACMx) and pass
//     that. Resolving at start time also tracks a board that re-enumerated to a
//     different ttyACMx since discovery, while the by-id name stayed stable.
func deviceMapping(d string) (arg string, ok bool) {
	host, container := d, ""
	if i := strings.LastIndex(d, ":/"); i >= 0 {
		host, container = d[:i], d[i+1:]
	}
	real := host
	if r, err := filepath.EvalSymlinks(host); err == nil {
		real = r
	}
	if _, err := os.Stat(real); err != nil {
		return "", false
	}
	if container != "" {
		return real + ":" + container, true
	}
	return real, true
}

// sortedKeys returns m's keys in sorted order, for deterministic arg ordering.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// waitTCP blocks until addr accepts a connection or timeout.
func waitTCP(ctx context.Context, addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		d := net.Dialer{Timeout: 2 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no listener on %s after %s: %w", addr, timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (p *PodmanRunner) Stop(ctx context.Context, id string) error {
	p.stopUSBSync(id)
	p.killCapture(id, "reservation released")
	name := containerName(id)
	_, err := p.podman(ctx, "rm", "-f", "-t", "5", name)
	// Best-effort scratch cleanup.
	_ = os.RemoveAll(filepath.Join(p.cfg.StateDir, id))
	if err != nil && !strings.Contains(err.Error(), "no such container") {
		return err
	}
	return nil
}

// Cleanup removes every container we labeled, e.g. after a daemon crash.
func (p *PodmanRunner) Cleanup(ctx context.Context) error {
	// Stop any raw-USB refreshers this process still owns (Start without a Stop).
	p.mu.Lock()
	for id, cancel := range p.usbSync {
		cancel()
		delete(p.usbSync, id)
	}
	caps := p.captures
	p.captures = map[string]*capture{}
	p.mu.Unlock()
	// Reap any BLE captures still running (e.g. from a Start with no Stop).
	for _, c := range caps {
		c.finish("daemon cleanup")
	}

	out, err := p.podman(ctx, "ps", "-aq", "--filter", "label=hitl=1")
	if err != nil {
		return err
	}
	for _, cid := range strings.Fields(out) {
		if _, err := p.podman(ctx, "rm", "-f", cid); err != nil {
			log.Printf("cleanup: %v", err)
		}
	}
	return nil
}
