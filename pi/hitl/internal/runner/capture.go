package runner

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// BLE HCI capture: a per-reservation `btmon -w` on the HOST, whose btsnoop file
// lives in the reservation's state dir and is bind-mounted read-only into the
// container (see Start). btmon runs host-side because it needs an AF_BLUETOOTH
// HCI monitor socket + CAP_NET_RAW/ADMIN the unprivileged reservation container
// deliberately lacks — the daemon already runs as root, so no capability change
// is needed anywhere.
//
// IMPORTANT: the rig has one Bluetooth controller shared by every DUT, so a
// capture records ALL of that controller's HCI traffic for the window it runs,
// including other concurrent reservations' BLE. Callers annotate by the DUT's
// BLE MAC (see `hitl btmon fetch --mac`); this does not isolate the trace.
// Concurrent per-reservation captures are fine: the kernel's HCI monitor channel
// is a broadcast channel, so several btmon readers coexist.

const (
	// captureContainerDir is where the read-only btsnoop dir is mounted inside the
	// reservation container; captureFile is the btsnoop within it.
	captureContainerDir = "/run/hitl/capture"
	captureFile         = "hci.btsnoop"

	// Defaults when PodmanConfig leaves the caps at zero.
	defaultCaptureMaxBytes = int64(64) << 20 // 64 MiB
	defaultCaptureMaxDur   = 30 * time.Minute
)

// captureContainerPath is the in-container path of a reservation's btsnoop file.
var captureContainerPath = filepath.Join(captureContainerDir, captureFile)

// capture is one reservation's live btmon process and its watchdog state.
type capture struct {
	path      string
	startedAt time.Time
	cmd       *exec.Cmd
	cancel    context.CancelFunc

	mu     sync.Mutex
	done   bool
	reason string
}

// finish records the first stop reason and cancels the process context, so the
// watchdog kills btmon and reaps it. Idempotent — later reasons are ignored.
func (c *capture) finish(reason string) {
	c.mu.Lock()
	if !c.done {
		c.done = true
		c.reason = reason
	}
	c.mu.Unlock()
	c.cancel()
}

func (c *capture) state() (done bool, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done, c.reason
}

// StartCapture begins (or, if already running, returns) the reservation's BLE
// HCI capture. The btsnoop file is truncated fresh on each start.
func (p *PodmanRunner) StartCapture(ctx context.Context, id string) (*api.CaptureStatus, error) {
	if p.cfg.Btmon == "" {
		return nil, fmt.Errorf("BLE HCI capture is disabled on this rig")
	}
	dir := filepath.Join(p.cfg.StateDir, id, "capture")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("capture dir: %w", err)
	}
	path := filepath.Join(dir, captureFile)

	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.captures[id]; c != nil {
		if done, _ := c.state(); !done {
			return p.captureStatusLocked(id), nil // idempotent: already running
		}
	}
	// Fresh file each start so a capture covers only this run's window.
	_ = os.Remove(path)
	cctx, cancel := context.WithCancel(context.Background())
	// `btmon -w` writes a btsnoop file of all HCI monitor traffic; it opens in
	// `btmon -r` and Wireshark. One controller on the rig, so no -i filter.
	cmd := exec.CommandContext(cctx, p.cfg.Btmon, "-w", path)
	// On stop, SIGTERM btmon so it flushes and closes the btsnoop cleanly (a
	// SIGKILL could truncate the final record); force-kill only if it lingers.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start btmon: %w", err)
	}
	c := &capture{path: path, startedAt: time.Now(), cmd: cmd, cancel: cancel}
	p.captures[id] = c
	go p.watchCapture(cctx, id, c)
	log.Printf("btmon: capture started for %s -> %s (caps: %s / %s)",
		id, path, humanBytes(p.captureMaxBytes()), p.captureMaxDur())
	return p.captureStatusLocked(id), nil
}

// StopCapture ends the reservation's capture.
func (p *PodmanRunner) StopCapture(_ context.Context, id string) (*api.CaptureStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.captures[id]
	if c == nil {
		return nil, fmt.Errorf("no BLE HCI capture is running for this reservation")
	}
	c.finish("stopped by request")
	return p.captureStatusLocked(id), nil
}

// CaptureStatus reports the reservation's capture state.
func (p *PodmanRunner) CaptureStatus(id string) (*api.CaptureStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.captureStatusLocked(id), nil
}

// killCapture reaps and forgets a reservation's capture, if any (called on
// Stop). Safe for an id with no capture.
func (p *PodmanRunner) killCapture(id, reason string) {
	p.mu.Lock()
	c := p.captures[id]
	delete(p.captures, id)
	p.mu.Unlock()
	if c != nil {
		c.finish(reason)
	}
}

// captureStatusLocked builds the wire status for id; caller holds p.mu.
func (p *PodmanRunner) captureStatusLocked(id string) *api.CaptureStatus {
	st := &api.CaptureStatus{ContainerPath: captureContainerPath}
	c := p.captures[id]
	if c == nil {
		return st
	}
	done, reason := c.state()
	st.Running = !done
	st.Reason = reason
	started := c.startedAt
	st.StartedAt = &started
	if fi, err := os.Stat(c.path); err == nil {
		st.SizeBytes = fi.Size()
	}
	return st
}

func (p *PodmanRunner) captureMaxBytes() int64 {
	if p.cfg.CaptureMaxBytes > 0 {
		return p.cfg.CaptureMaxBytes
	}
	return defaultCaptureMaxBytes
}

func (p *PodmanRunner) captureMaxDur() time.Duration {
	if p.cfg.CaptureMaxDur > 0 {
		return p.cfg.CaptureMaxDur
	}
	return defaultCaptureMaxDur
}

// watchCapture bounds one capture: it stops btmon at the size cap or the max
// duration (so a capture can never fill the rig disk, and a forgotten one is
// time-bounded), keeps the btsnoop world-readable so the container's uid-1000
// agent can read it through the read-only mount, and reaps the process when it
// exits for any reason.
func (p *PodmanRunner) watchCapture(ctx context.Context, id string, c *capture) {
	maxBytes := p.captureMaxBytes()
	deadline := time.NewTimer(p.captureMaxDur())
	defer deadline.Stop()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()

	waitErr := make(chan error, 1)
	go func() { waitErr <- c.cmd.Wait() }()

	for {
		select {
		case <-ctx.Done():
			// finish() was called (StopCapture/killCapture, or a cap branch below):
			// os/exec's Cancel already SIGTERM'd btmon — just wait for it to exit.
			<-waitErr
			p.forgetCapture(id, c)
			return
		case <-waitErr:
			// btmon exited on its own (if a cap branch already ran, finish set the
			// reason and this is a no-op).
			c.finish("btmon exited")
			p.forgetCapture(id, c)
			return
		case <-deadline.C:
			log.Printf("btmon: capture for %s hit max duration %s; stopping", id, p.captureMaxDur())
			c.finish("max duration reached") // cancels ctx → SIGTERM
		case <-tick.C:
			fi, err := os.Stat(c.path)
			if err != nil {
				continue
			}
			// btmon writes as root; open it up so the container agent (uid 1000) can
			// read it via the read-only mount.
			_ = os.Chmod(c.path, 0o644)
			if fi.Size() >= maxBytes {
				log.Printf("btmon: capture for %s hit size cap %s; stopping", id, humanBytes(maxBytes))
				c.finish("size cap reached") // cancels ctx → SIGTERM
			}
		}
	}
}

// forgetCapture drops c from the live map if it's still the current entry for id
// (a later StartCapture may have replaced it).
func (p *PodmanRunner) forgetCapture(id string, c *capture) {
	p.mu.Lock()
	if p.captures[id] == c {
		delete(p.captures, id)
	}
	p.mu.Unlock()
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.0f%ciB", float64(n)/float64(div), "KMGT"[exp])
}
