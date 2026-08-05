// Package queue implements the reservation state machine for one HITL rig:
// a FIFO admission queue over one or more DUTs, each with a single active slot,
// heartbeat leases, and lifecycle callbacks into a runner.Runner to bring the
// per-DUT test containers up/down. With one DUT it degenerates to the original
// single-slot FIFO.
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
	rig     string
	lease   time.Duration
	run     runner.Runner
	devices []runner.Device // the DUTs this rig can hand out (>=1)
	wifi    *api.WiFiInfo   // rig's provisioning AP creds, advertised in Status (or nil)
	ap      AP              // brings that AP up/down around active reservations (or nil)

	mu    sync.Mutex
	items []*api.Reservation // admission order; several may be Active (one per DUT)
	keys  map[string]string  // reservation id -> SSH pubkey (not serialized out)
	want  map[string]string  // reservation id -> pinned DUT name ("" = any free DUT)
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

// WithAP wires an access point that the manager toggles around active
// reservations (up on activation, down on release/reap).
func WithAP(ap AP) Option { return func(m *Manager) { m.ap = ap } }

// WithDevices sets the DUTs this rig hands out. Order is the tie-break when
// several DUTs are free. If unset, the rig runs a single unnamed DUT (the
// original single-slot behavior).
func WithDevices(devs []runner.Device) Option {
	return func(m *Manager) { m.devices = append([]runner.Device(nil), devs...) }
}

// New creates a Manager. lease is the heartbeat window: an active reservation
// whose holder stops heartbeating for longer than lease is reaped.
func New(rig string, lease time.Duration, run runner.Runner, opts ...Option) *Manager {
	m := &Manager{rig: rig, lease: lease, run: run, keys: map[string]string{}, want: map[string]string{}}
	for _, o := range opts {
		o(m)
	}
	// Default to a single unnamed DUT so a rig configured the old way (no
	// WithDevices) behaves exactly as before.
	if len(m.devices) == 0 {
		m.devices = []runner.Device{{Name: "dut0"}}
	}
	return m
}

// Devices returns the configured DUT names (for request validation / display).
func (m *Manager) Devices() []string {
	out := make([]string, len(m.devices))
	for i, d := range m.devices {
		out[i] = d.Name
	}
	return out
}

// SyncDevices reconciles the live DUT set to devs — the hook live discovery uses
// for hot-plug. It adds newly-attached DUTs, drops detached ones (tearing down
// any reservation running on a removed DUT), and reconciles so a waiter lands on
// a freshly-attached board. DUTs present in both sets are matched by name and
// left untouched — their running container and port are preserved — so unplugging
// one board never disturbs another's live session. Returns the added/removed
// names for logging.
func (m *Manager) SyncDevices(ctx context.Context, devs []runner.Device) (added, removed []string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	next := map[string]bool{}
	for _, d := range devs {
		next[d.Name] = true
	}
	cur := map[string]bool{}
	for _, d := range m.devices {
		cur[d.Name] = true
	}

	// Keep existing DUTs exactly as they are (preserving any live container/port);
	// evict the ones that have gone away.
	var kept []runner.Device
	for _, d := range m.devices {
		if next[d.Name] {
			kept = append(kept, d)
			continue
		}
		removed = append(removed, d.Name)
		m.evictDeviceLocked(ctx, d.Name)
	}
	// Append the newly-attached DUTs.
	for _, d := range devs {
		if !cur[d.Name] {
			kept = append(kept, d)
			added = append(added, d.Name)
		}
	}
	m.devices = kept
	if len(added) > 0 || len(removed) > 0 {
		m.reconcileLocked(ctx)
	}
	return added, removed
}

// evictDeviceLocked tears down whatever is using the named DUT because its board
// was unplugged: it stops an active holder's container and drops the reservation,
// and dequeues any waiter pinned to that DUT (an unpinned waiter stays, since
// another DUT can still serve it).
func (m *Manager) evictDeviceLocked(ctx context.Context, name string) {
	var doomed []*api.Reservation
	for _, r := range m.items {
		if (r.State == api.StateActive && r.Device == name) ||
			(r.State == api.StateQueued && m.want[r.ID] == name) {
			doomed = append(doomed, r)
		}
	}
	for _, r := range doomed {
		if r.State == api.StateActive {
			if err := m.run.Stop(ctx, r.ID); err != nil {
				log.Printf("evict: stop container for %s: %v", r.ID, err)
			}
		}
		log.Printf("evict: reservation %s dropped (DUT %s removed)", r.ID, name)
		m.removeLocked(r.ID)
	}
	// If evicting the last active holder left the rig idle, drop the shared AP;
	// reconcile brings it back up if it promotes a waiter onto another DUT.
	if !m.anyOtherActiveLocked("") {
		m.apDown(ctx)
	}
}

// HasDevice reports whether name is one of the rig's DUTs.
func (m *Manager) HasDevice(name string) bool {
	for _, d := range m.devices {
		if d.Name == name {
			return true
		}
	}
	return false
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
	// Stash the key and any pinned-DUT request on side tables (not serialized).
	m.keys[r.ID] = req.SSHPublicKey
	if req.Device != "" {
		m.want[r.ID] = req.Device
	}
	m.items = append(m.items, r)
	log.Printf("reserve: id=%s owner=%q device=%q queued (position %d)", r.ID, r.Owner, req.Device, len(m.items)-1)
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
		// Drop the shared AP only when no other DUT stays active — otherwise a
		// concurrent holder would lose it. If a waiter is promoted below, reconcile
		// brings it back up. (Single-DUT: releasing the sole holder always drops it.)
		if !m.anyOtherActiveLocked(id) {
			m.apDown(ctx)
		}
	}
	delete(m.keys, id)
	delete(m.want, id)
	m.items = append(m.items[:idx], m.items[idx+1:]...)
	m.reconcileLocked(ctx)
	return nil
}

// Status returns the rig overview: a per-DUT breakdown plus a legacy single-DUT
// summary (see api.Status) so older clients and the pool picker keep working.
func (m *Manager) Status() api.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := api.Status{Rig: m.rig, LeaseSeconds: int(m.lease.Seconds()), WiFi: m.wifi}

	// active DUT name -> holder view.
	holders := map[string]*api.Reservation{}
	for _, r := range m.items {
		if r.State == api.StateActive {
			holders[r.Device] = m.viewLocked(r.ID)
		}
	}
	anyFree := false
	var firstBusy *api.Reservation
	for _, d := range m.devices {
		h := holders[d.Name]
		s.Devices = append(s.Devices, api.DeviceStatus{Name: d.Name, Active: h})
		if h == nil {
			anyFree = true
		} else if firstBusy == nil {
			firstBusy = h
		}
	}

	// Legacy summary. While any DUT is free the rig can take a reservation right
	// now, so report idle (Active=nil, queue 0). Only when every DUT is busy do we
	// surface a holder and the count of still-unassigned waiters.
	if anyFree {
		s.Active = nil
		s.QueueLength = 0
	} else {
		s.Active = firstBusy
		for _, r := range m.items {
			if r.State == api.StateQueued {
				s.QueueLength++
			}
		}
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

// reconcileLocked brings up a container on every free DUT, each fed the earliest
// queued waiter compatible with it (unpinned, or pinned to that DUT). It loops
// until no free DUT has a waiter, so a batch of reservations fills all DUTs and a
// failed start doesn't strand the rest.
func (m *Manager) reconcileLocked(ctx context.Context) {
	for {
		dev, head := m.nextAssignmentLocked()
		if dev == nil {
			return // no free DUT has a compatible waiter
		}
		ep, err := m.run.Start(ctx, head.ID, head.Owner, m.keys[head.ID], *dev)
		if err != nil {
			log.Printf("reconcile: start container for %s on %s failed: %v", head.ID, dev.Name, err)
			head.Message = "failed to start container: " + err.Error()
			// Drop the failed reservation so the queue can make progress, then retry
			// the same DUT with the next waiter.
			m.removeLocked(head.ID)
			continue
		}
		now := time.Now()
		exp := now.Add(m.lease)
		head.State = api.StateActive
		head.StartedAt = &now
		head.ExpiresAt = &exp
		head.SSH = ep
		head.Device = dev.Name
		log.Printf("reconcile: id=%s active dut=%s ssh=%s:%d", head.ID, dev.Name, ep.Host, ep.Port)
		// Stand up the provisioning AP for the new holder (best-effort, idempotent).
		m.apUp(ctx)
	}
}

// anyOtherActiveLocked reports whether any reservation other than exceptID is
// currently active (i.e. another DUT is still held).
func (m *Manager) anyOtherActiveLocked(exceptID string) bool {
	for _, r := range m.items {
		if r.ID != exceptID && r.State == api.StateActive {
			return true
		}
	}
	return false
}

// nextAssignmentLocked finds a free DUT paired with the earliest queued waiter
// that can run on it, or (nil, nil) if no such pair exists. It scans every free
// DUT — not just the first — so a waiter pinned to a later DUT still activates
// while an earlier DUT sits free with no compatible work.
func (m *Manager) nextAssignmentLocked() (*runner.Device, *api.Reservation) {
	busy := map[string]bool{}
	for _, r := range m.items {
		if r.State == api.StateActive {
			busy[r.Device] = true
		}
	}
	for i := range m.devices {
		if busy[m.devices[i].Name] {
			continue
		}
		if head := m.nextWaiterForLocked(m.devices[i].Name); head != nil {
			return &m.devices[i], head
		}
	}
	return nil, nil
}

// nextWaiterForLocked returns the earliest queued reservation that can run on the
// named DUT (unpinned, or pinned to it), or nil if none.
func (m *Manager) nextWaiterForLocked(dev string) *api.Reservation {
	for _, r := range m.items {
		if r.State != api.StateQueued {
			continue
		}
		if want := m.want[r.ID]; want == "" || want == dev {
			return r
		}
	}
	return nil
}

// removeLocked drops a reservation and its side-table entries.
func (m *Manager) removeLocked(id string) {
	i := m.indexLocked(id)
	if i < 0 {
		return
	}
	m.items = append(m.items[:i], m.items[i+1:]...)
	delete(m.keys, id)
	delete(m.want, id)
}
