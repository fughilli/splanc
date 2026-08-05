// Package api defines the wire types shared by hitl-managerd (the Pi-side
// reservation daemon) and the hitl CLI (run by an agent in a claude-container).
//
// A HITL rig hosts one or more DUTs (ESP32-C6 dev boards). Each DUT has its own
// active reservation and container at a time; a shared FIFO admits waiters to
// whichever DUT frees first. Callers enqueue with their SSH public key; when
// they reach the head of the queue the daemon starts a test container with a DUT
// attached and their key authorized, and returns the SSH endpoint. The holder
// heartbeats to keep the lease; on release (or lease expiry) the daemon tears the
// container down and promotes the next waiter onto that DUT.
//
// Backward compatibility: the client flow is DUT-agnostic — callers read the
// SSH host:port out of the reservation response and never assume a fixed port —
// so a multi-DUT daemon serving distinct ports per DUT needs no client changes.
// The Device fields and Status.Devices below are additive; older clients that
// don't send/read them keep working (they get any free DUT).
package api

import "time"

// State is the lifecycle of a reservation.
type State string

const (
	// StateQueued: waiting behind others; not yet allocated the rig.
	StateQueued State = "queued"
	// StateActive: holds the rig; a container is up and SSH is available.
	StateActive State = "active"
	// StateReleased: released by the holder or expired; terminal.
	StateReleased State = "released"
)

// ReserveRequest enqueues a new reservation.
type ReserveRequest struct {
	// Owner is a free-form identifier for logs/status (e.g. agent/issue id).
	Owner string `json:"owner"`
	// SSHPublicKey is the OpenSSH public key authorized for the container while
	// this reservation is active (e.g. "ssh-ed25519 AAAA… agent").
	SSHPublicKey string `json:"ssh_public_key"`
	// Device optionally pins the reservation to a specific DUT by name (see
	// Status.Devices). Empty (the default, and what older clients send) means
	// "any free DUT" — the daemon assigns whichever frees first.
	Device string `json:"device,omitempty"`
}

// SSHEndpoint is where the holder connects once active.
type SSHEndpoint struct {
	Host string `json:"host"` // reach the daemon's host over the tailnet
	Port int    `json:"port"` // published container sshd port on that host
	User string `json:"user"` // login user inside the container (e.g. "agent")
}

// Reservation is the full server-side view of one reservation.
type Reservation struct {
	ID        string       `json:"id"`
	Owner     string       `json:"owner"`
	State     State        `json:"state"`
	Position  int          `json:"position"` // 0 == active/head, else waiters ahead
	CreatedAt time.Time    `json:"created_at"`
	StartedAt *time.Time   `json:"started_at,omitempty"`
	ExpiresAt *time.Time   `json:"expires_at,omitempty"` // lease deadline while active
	SSH       *SSHEndpoint `json:"ssh,omitempty"`        // set once active
	// Device is the name of the DUT this reservation landed on (set once active).
	// Informational; older clients ignore it.
	Device string `json:"device,omitempty"`
	// Message carries human-readable context (e.g. why released).
	Message string `json:"message,omitempty"`
}

// Status is the daemon's overall view.
//
// Active and QueueLength are the legacy single-DUT summary, kept so older clients
// (and the pool picker) keep working against a multi-DUT rig: whenever ANY DUT is
// free the rig reports Active=null and QueueLength=0 (it can take a reservation
// now); only when every DUT is busy does Active name one holder and QueueLength
// count the unassigned waiters. Devices carries the full per-DUT breakdown for
// newer clients.
type Status struct {
	Rig          string         `json:"rig"`               // rig name/hostname
	Active       *Reservation   `json:"active"`            // a busy DUT's holder, or null if any DUT is free
	QueueLength  int            `json:"queue_length"`      // waiters not yet assigned a DUT (0 while any DUT is free)
	Devices      []DeviceStatus `json:"devices,omitempty"` // per-DUT state (newer clients)
	LeaseSeconds int            `json:"lease_seconds"`     // heartbeat lease window
	WiFi         *WiFiInfo      `json:"wifi,omitempty"`    // the rig's own provisioning AP, if it runs one
}

// DeviceStatus is one DUT's slice of the rig's Status.
type DeviceStatus struct {
	Name   string       `json:"name"`   // DUT name (matches ReserveRequest.Device)
	Active *Reservation `json:"active"` // this DUT's current holder, or null if free
}

// WiFiInfo is the rig's self-hosted provisioning AP: the network a test flow
// provisions the DUT onto (over ImprovBLE) so the rig can reach it without any
// external WiFi. Set only when the rig is configured with an AP; the passphrase
// is returned so the harness needs no out-of-band creds (the tailnet is the trust
// boundary, same posture as the baked STA profiles).
type WiFiInfo struct {
	SSID string `json:"ssid"`
	PSK  string `json:"psk"`
}

// Error is the JSON error envelope for non-2xx responses.
type Error struct {
	Error string `json:"error"`
}
