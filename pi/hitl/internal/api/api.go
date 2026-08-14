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

// CaptureRequest asks the daemon to capture and decode a trace from the rig's
// shared logic analyzer (a single FX2/fx2lafw instrument owned by the daemon).
//
// The analyzer is a RIG-LEVEL resource, not per-container: its channels are
// partitioned across DUTs (one or two channels tap each DUT's LED data line), so
// a caller names the DUT it wants and the daemon maps that to the DUT's channel
// subset + wire protocol. Captures are serialized on the single instrument, so a
// request may briefly block while another DUT's capture finishes.
type CaptureRequest struct {
	// Device is the DUT whose tapped line to capture (matches ReserveRequest.Device
	// / DeviceStatus.Name). Empty uses the analyzer's default/only DUT mapping.
	Device string `json:"device,omitempty"`
	// Protocol overrides the DUT's configured decoder ("ws2812" or "spi"). Empty
	// uses the mapping's protocol (default ws2812 — the ESP32-C6 player_app DUT).
	Protocol string `json:"protocol,omitempty"`
	// Samples overrides the capture length in samples (0 = the daemon default).
	// One WS2812 frame of N LEDs is N*24*1.25µs; size to cover the frame + the
	// >50µs reset latch. At 24 MHz, 200000 samples ≈ 8.3 ms.
	Samples int `json:"samples,omitempty"`
	// SaveSR requests the raw sigrok .sr session (base64 in CaptureResult.SR) for
	// offline inspection in PulseView, in addition to the decoded pixels.
	SaveSR bool `json:"save_sr,omitempty"`
}

// Pixel is one decoded LED, 8-bit per channel in logical RGB order (the decoder
// output is normalized to RGB regardless of the wire order, e.g. WS2812's GRB).
type Pixel struct {
	R uint8 `json:"r"`
	G uint8 `json:"g"`
	B uint8 `json:"b"`
}

// CaptureResult is the decoded trace: the per-LED pixels the analyzer saw on the
// wire, plus optional timing and the raw session.
type CaptureResult struct {
	// Device is the DUT the capture came from.
	Device string `json:"device"`
	// Protocol is the decoder used ("ws2812" / "spi").
	Protocol string `json:"protocol"`
	// Pixels are the decoded LEDs in wire order (index 0 = first LED / DIN).
	Pixels []Pixel `json:"pixels"`
	// SampleRate is the capture sample rate in Hz (for latency math on Samples).
	SampleRate int `json:"sample_rate,omitempty"`
	// TriggerSample is the sample index of the trigger edge that armed the capture
	// (the first data edge), when a trigger was used — the anchor for end-to-end
	// latency (t_edge = TriggerSample / SampleRate after the capture start).
	TriggerSample int `json:"trigger_sample,omitempty"`
	// SR is the base64-encoded raw .sr session, present only when SaveSR was set.
	SR string `json:"sr,omitempty"`
}
