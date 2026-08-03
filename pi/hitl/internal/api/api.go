// Package api defines the wire types shared by hitl-managerd (the Pi-side
// reservation daemon) and the hitl CLI (run by an agent in a claude-container).
//
// One HITL rig == one ESP32-C6 == one active reservation at a time. Callers
// enqueue with their SSH public key; when they reach the head of the queue the
// daemon starts a test container with the dev board attached and their key
// authorized, and returns the SSH endpoint. The holder heartbeats to keep the
// lease; on release (or lease expiry) the daemon tears the container down and
// promotes the next waiter.
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
	// Message carries human-readable context (e.g. why released).
	Message string `json:"message,omitempty"`
}

// Status is the daemon's overall view.
type Status struct {
	Rig          string       `json:"rig"`            // rig name/hostname
	Active       *Reservation `json:"active"`         // current holder, or null
	QueueLength  int          `json:"queue_length"`   // waiters (excludes active)
	LeaseSeconds int          `json:"lease_seconds"`  // heartbeat lease window
	WiFi         *WiFiInfo    `json:"wifi,omitempty"` // the rig's own provisioning AP, if it runs one
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
