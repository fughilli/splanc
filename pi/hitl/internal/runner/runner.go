// Package runner starts/stops the per-reservation test container and returns
// its SSH endpoint. The Podman implementation shells out to `podman`.
package runner

import (
	"context"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// Device describes one DUT the rig can attach to a container: its stable name,
// the host port its container's sshd is published on, the /dev nodes to map in,
// and any extra env for the container (e.g. a JTAG adapter serial). Distinct
// ports + node mappings per Device are what let several DUTs run concurrently.
type Device struct {
	// Name is the stable DUT identifier (e.g. "c6-0"); matches ReserveRequest.Device.
	Name string
	// Kind selects how the DUT is wired into its container. "" (== "usb") is a
	// board attached over USB: its serial/JTAG nodes are mapped in and isolated.
	// "network" is a LAN DUT (e.g. a Raspberry Pi) with no board on this rig —
	// reached over the network and provisioned over BLE; it gets NO USB mounts (see
	// PodmanRunner.Start), so it can't see the USB DUTs' boards.
	Kind string
	// SSHPort is the host port published to this DUT's container sshd (:22). Each
	// DUT gets a distinct port so their containers coexist.
	SSHPort int
	// Devices are `--device` mappings for this DUT, each "host" or "host:container"
	// (e.g. "/dev/serial/by-id/…:/dev/ttyACM0" pins the DUT's tty to a stable
	// in-container path so the toolbox's /dev/ttyACM0 defaults hold on every DUT).
	Devices []string
	// Env are extra environment variables set in the container (e.g.
	// HITL_ADAPTER_SERIAL so openocd targets this DUT's board).
	Env map[string]string
}

// Runner brings a test environment up for a reservation and tears it down.
// Implementations must be safe to call Stop on a Start that never completed.
type Runner interface {
	// Start launches the environment for id on the given DUT, authorizing sshKey,
	// and returns the SSH endpoint to reach it. It must be idempotent-ish: a second
	// Start for the same id (after a crash) should recover or replace cleanly.
	Start(ctx context.Context, id, owner, sshKey string, dev Device) (*api.SSHEndpoint, error)
	// Stop tears the environment down. Safe to call for an unknown/already-gone id.
	Stop(ctx context.Context, id string) error
	// Cleanup removes any leftover environments (e.g. on daemon startup after a
	// crash) so a fresh queue starts from a clean slate.
	Cleanup(ctx context.Context) error

	// StartCapture begins a bounded BLE HCI (btmon) capture for the reservation
	// and returns its status. Idempotent: calling it again while a capture runs
	// is a no-op that returns the running capture's status.
	StartCapture(ctx context.Context, id string) (*api.CaptureStatus, error)
	// StopCapture ends the reservation's capture (a no-op error if none runs).
	StopCapture(ctx context.Context, id string) (*api.CaptureStatus, error)
	// CaptureStatus reports the reservation's capture state (running, size, path).
	CaptureStatus(id string) (*api.CaptureStatus, error)
}
