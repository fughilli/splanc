// Package queue implements the reservation state machine for one HITL rig:
// a FIFO queue with a single active slot, heartbeat leases, and lifecycle
// callbacks into a runner.Runner to bring the test container up/down.
package queue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

var ErrNotFound = errors.New("reservation not found")

// Manager owns all reservation state. Methods are safe for concurrent use.
//
// Concurrency note: the mutex is held across runner Start/Stop (a few seconds of
// podman). Reservations are infrequent, so this simple serialization is fine;
// revisit with a control goroutine if it ever becomes a bottleneck.
type Manager struct {
	rig   string
	lease time.Duration
	run   runner.Runner
	wifi  *api.WiFiInfo // rig's provisioning AP creds, advertised in Status (or nil)
	ap    AP            // brings that AP up/down around the active reservation (or nil)

	mu    sync.Mutex
	items []*api.Reservation // index 0 is the active holder (once StateActive)
	keys  map[string]string  // reservation id -> SSH pubkey (not serialized out)
}

// AP is the rig's provisioning access point: brought up while a reservation holds
// the rig and down on release (see internal/ap). Both calls must be idempotent.
type AP interface {
	Up(context.Context) error
	Down(context.Context) error
}

// Option configures a Manager.
type Option func(*Manager)

// WithWiFi advertises the rig's provisioning-AP creds in Status so the harness can
// provision the DUT onto it with no out-of-band config.
func WithWiFi(w *api.WiFiInfo) Option { return func(m *Manager) { m.wifi = w } }

// WithAP wires an access point that the manager toggles around the active
// reservation (up on activation, down on release/reap).
func WithAP(ap AP) Option { return func(m *Manager) { m.ap = ap } }

// New creates a Manager. lease is the heartbeat window: an active reservation
// whose holder stops heartbeating for longer than lease is reaped.
func New(rig string, lease time.Duration, run runner.Runner, opts ...Option) *Manager {
	m := &Manager{rig: rig, lease: lease, run: run, keys: map[string]string{}}
	for _, o := range opts {
		o(m)
	}
	return m
}

// apUp/apDown are nil-safe and best-effort: AP trouble is logged but never fails a
// reservation (the test still runs; only WiFi provisioning would be affected).
func (m *Manager) apUp(ctx context.Context) {
	if m.ap == nil {
		return
	}
	if err := m.ap.Up(ctx); err != nil {
		log.Printf("ap: bring up: %v", err)
	}
}

func (m *Manager) apDown(ctx context.Context) {
	if m.ap == nil {
		return
	}
	if err := m.ap.Down(ctx); err != nil {
		log.Printf("ap: bring down: %v", err)
	}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Recover clears any stale containers from a previous run and starts fresh.
func (m *Manager) Recover(ctx context.Context) error {
	return m.run.Cleanup(ctx)
}

// Reserve enqueues a new reservation and reconciles (may activate it if idle).
func (m *Manager) Reserve(ctx context.Context, req api.ReserveRequest) *api.Reservation {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	exp := now.Add(m.lease)
	r := &api.Reservation{
		ID:        newID(),
		Owner:     req.Owner,
		State:     api.StateQueued,
		CreatedAt: now,
		// Queued waiters carry a lease too, refreshed by their heartbeats — so a
		// waiter whose client dies is reaped instead of blocking the queue forever.
		ExpiresAt: &exp,
	}
	// Stash the key on the reservation via a side table (not serialized to peers).
	m.keys[r.ID] = req.SSHPublicKey
	m.items = append(m.items, r)
	log.Printf("reserve: id=%s owner=%q queued (position %d)", r.ID, r.Owner, len(m.items)-1)
	m.reconcileLocked(ctx)
	return m.viewLocked(r.ID)
}

// Get returns a snapshot of one reservation.
func (m *Manager) Get(id string) (*api.Reservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v := m.viewLocked(id); v != nil {
		return v, nil
	}
	return nil, ErrNotFound
}

// Heartbeat extends a reservation's lease — for queued waiters as well as the
// active holder, so a client that dies (in either state) is eventually reaped.
func (m *Manager) Heartbeat(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.findLocked(id)
	if r == nil {
		return ErrNotFound
	}
	if r.State == api.StateActive || r.State == api.StateQueued {
		exp := time.Now().Add(m.lease)
		r.ExpiresAt = &exp
	}
	return nil
}

// Release ends a reservation. If it was active, the container is torn down and
// the next waiter is promoted.
func (m *Manager) Release(ctx context.Context, id, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	idx := m.indexLocked(id)
	if idx < 0 {
		return ErrNotFound
	}
	wasActive := m.items[idx].State == api.StateActive
	log.Printf("release: id=%s reason=%q wasActive=%v", id, reason, wasActive)
	if wasActive {
		if err := m.run.Stop(ctx, id); err != nil {
			log.Printf("release: stop container for %s: %v", id, err)
		}
		// Drop the AP with the holder. If a waiter is promoted below, reconcile
		// brings it back up for the new holder.
		m.apDown(ctx)
	}
	delete(m.keys, id)
	m.items = append(m.items[:idx], m.items[idx+1:]...)
	m.reconcileLocked(ctx)
	return nil
}

// Status returns the rig overview.
func (m *Manager) Status() api.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := api.Status{Rig: m.rig, LeaseSeconds: int(m.lease.Seconds()), WiFi: m.wifi}
	if len(m.items) > 0 && m.items[0].State == api.StateActive {
		s.Active = m.viewLocked(m.items[0].ID)
		s.QueueLength = len(m.items) - 1
	} else {
		s.QueueLength = len(m.items)
	}
	return s
}

// ReapExpired releases every reservation whose lease has passed — the active
// holder (tearing its container down) and any queued waiter (dequeuing it) alike.
// Call periodically. Sweeping the whole queue, not just the head, is what keeps a
// dead waiter from stranding its slot indefinitely.
func (m *Manager) ReapExpired(ctx context.Context) {
	m.mu.Lock()
	now := time.Now()
	var expired []string
	for _, r := range m.items {
		if r.ExpiresAt != nil && now.After(*r.ExpiresAt) {
			expired = append(expired, r.ID)
		}
	}
	m.mu.Unlock()
	for _, id := range expired {
		_ = m.Release(ctx, id, "lease expired (no heartbeat)")
	}
}

// --- locked helpers -------------------------------------------------------

func (m *Manager) findLocked(id string) *api.Reservation {
	i := m.indexLocked(id)
	if i < 0 {
		return nil
	}
	return m.items[i]
}

func (m *Manager) indexLocked(id string) int {
	for i, r := range m.items {
		if r.ID == id {
			return i
		}
	}
	return -1
}

// viewLocked returns a copy with an up-to-date Position.
func (m *Manager) viewLocked(id string) *api.Reservation {
	i := m.indexLocked(id)
	if i < 0 {
		return nil
	}
	cp := *m.items[i]
	cp.Position = i
	return &cp
}

// reconcileLocked activates the head of the queue if the rig is idle.
func (m *Manager) reconcileLocked(ctx context.Context) {
	if len(m.items) == 0 {
		return
	}
	head := m.items[0]
	if head.State == api.StateActive {
		return
	}
	// head is queued and the rig is idle → bring it up.
	ep, err := m.run.Start(ctx, head.ID, head.Owner, m.keys[head.ID])
	if err != nil {
		log.Printf("reconcile: start container for %s failed: %v", head.ID, err)
		head.Message = "failed to start container: " + err.Error()
		// Drop the failed head so the queue can make progress.
		m.items = m.items[1:]
		delete(m.keys, head.ID)
		m.reconcileLocked(ctx)
		return
	}
	now := time.Now()
	exp := now.Add(m.lease)
	head.State = api.StateActive
	head.StartedAt = &now
	head.ExpiresAt = &exp
	head.SSH = ep
	log.Printf("reconcile: id=%s active ssh=%s:%d", head.ID, ep.Host, ep.Port)
	// Stand up the provisioning AP for the new holder (best-effort).
	m.apUp(ctx)
}
