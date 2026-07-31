// Package runner starts/stops the per-reservation test container and returns
// its SSH endpoint. The Podman implementation shells out to `podman`.
package runner

import (
	"context"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// Runner brings a test environment up for a reservation and tears it down.
// Implementations must be safe to call Stop on a Start that never completed.
type Runner interface {
	// Start launches the environment for id, authorizing sshKey, and returns the
	// SSH endpoint to reach it. It must be idempotent-ish: a second Start for the
	// same id (after a crash) should recover or replace cleanly.
	Start(ctx context.Context, id, owner, sshKey string) (*api.SSHEndpoint, error)
	// Stop tears the environment down. Safe to call for an unknown/already-gone id.
	Stop(ctx context.Context, id string) error
	// Cleanup removes any leftover environments (e.g. on daemon startup after a
	// crash) so a fresh queue starts from a clean slate.
	Cleanup(ctx context.Context) error
}
