package runner

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

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
	// Privileged runs the container privileged. AVOID on a multi-DUT rig: a
	// privileged container bind-mounts the whole host /dev, so every DUT's
	// /dev/ttyACM* leaks into every container — an agent sees its neighbor's board.
	// With it off, the container is confined to the explicit per-DUT --device (its
	// own tty as /dev/ttyACM0) plus the USB bus mount + device-cgroup rule below,
	// which are enough for the C6's serial and USB-JTAG. Kept as an escape hatch.
	Privileged bool
}

// PodmanRunner implements Runner by shelling out to podman.
type PodmanRunner struct{ cfg PodmanConfig }

func NewPodman(cfg PodmanConfig) *PodmanRunner {
	if cfg.Podman == "" {
		cfg.Podman = "podman"
	}
	if cfg.SSHUser == "" {
		cfg.SSHUser = "agent"
	}
	return &PodmanRunner{cfg: cfg}
}

// containerName is deterministic per reservation so Stop/Cleanup can find it.
func containerName(id string) string { return "hitl-" + id }

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
	// Per-DUT env (e.g. HITL_ADAPTER_SERIAL so openocd targets this DUT's board).
	for _, k := range sortedKeys(dev.Env) {
		args = append(args, "-e", k+"="+dev.Env[k])
	}
	// BLE: mount the host's system D-Bus socket so bleak in the container can
	// drive the host bluetoothd (hci0). Present only if hardware.bluetooth is on.
	if _, err := os.Stat("/run/dbus/system_bus_socket"); err == nil {
		args = append(args, "-v", "/run/dbus/system_bus_socket:/run/dbus/system_bus_socket")
	}
	// JTAG: give the container raw USB (libusb, for openocd on the C6's built-in
	// USB-JTAG). Mount the whole bus (survives device re-enumeration) + allow the
	// USB major (189) through the device cgroup.
	if _, err := os.Stat("/dev/bus/usb"); err == nil {
		args = append(args,
			"-v", "/dev/bus/usb:/dev/bus/usb",
			"--device-cgroup-rule", "c 189:* rwm",
		)
	}
	if p.cfg.Privileged {
		args = append(args, "--privileged")
	}
	for _, d := range dev.Devices {
		if d == "" {
			continue
		}
		arg, ok := deviceMapping(d)
		if !ok {
			// Skip devices that aren't present (e.g. the ESP32 isn't plugged in yet),
			// so a reservation can still come up for non-hardware testing.
			log.Printf("podman: device %q not present, skipping", d)
			continue
		}
		args = append(args, "--device", arg)
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
