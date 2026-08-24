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
	"fmt"
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
	rig      string
	lease    time.Duration
	run      runner.Runner
	devices  []runner.Device   // the DUTs this rig can hand out (>=1)
	wifi     *api.WiFiInfo     // rig's provisioning AP creds, advertised in Status (or nil)
	analyzer *api.AnalyzerInfo // rig's shared logic-analyzer capability, advertised in Status (or nil)
	ap       AP                // brings that AP up/down around active reservations (or nil)

	mu    sync.Mutex
	items []*api.Reservation // admission order; several may be Active (one per DUT)
	keys  map[string]string  // reservation id -> SSH pubkey (not serialized out)
	want  map[string]string  // reservation id -> pinned DUT name ("" = any free DUT)

	// Monotonic lifecycle counters, exported via Metrics() for /metrics. Guarded
	// by mu; only ever incremented, so a scraper sees rates (reservations/min,
	// lease-expiry rate, container-start failure rate).
	cReservations  uint64 // enqueued (every Reserve)
	cActivations   uint64 // queued -> active transitions
	cReleases      uint64 // reservations ended, any reason
	cLeaseExpiries uint64 // subset of releases triggered by a lapsed lease
	cStartFailures uint64 // container Start() errors during reconcile
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

// WithAnalyzer advertises the rig's shared logic-analyzer capability in Status so
// clients can select an analyzer-capable rig by capability (not by name/tag).
func WithAnalyzer(a *api.AnalyzerInfo) Option { return func(m *Manager) { m.analyzer = a } }

// SetAnalyzer refreshes the advertised analyzer capability — called after a
// runtime channel-map change (POST /analyzer/channel-map) so /status reflects the
// live channel set instead of the boot-time snapshot.
func (m *Manager) SetAnalyzer(a *api.AnalyzerInfo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.analyzer = a
}

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
		// The device is reported gone — but never tear down a live session over
		// that. A DUT stuck resetting (or any USB blip) drops out of scans
		// intermittently, and killing its holder would end the agent's reservation
		// mid-debug. Keep a busy DUT; it's pruned once the holder releases and it's
		// still gone (a dead lease is still reaped normally).
		if m.deviceBusyLocked(d.Name) {
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

// deviceBusyLocked reports whether the named DUT currently has an active holder.
func (m *Manager) deviceBusyLocked(name string) bool {
	for _, r := range m.items {
		if r.State == api.StateActive && r.Device == name {
			return true
		}
	}
	return false
}

// evictDeviceLocked drops what's tied to the named DUT once it's removed while
// idle: it dequeues any waiter pinned to that DUT (an unpinned waiter stays,
// since another DUT can still serve it). SyncDevices only calls this for an idle
// DUT — a busy one is retained until its holder releases — but the active-holder
// teardown is kept defensively.
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
	m.cReservations++
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
	m.cReleases++
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
	s := api.Status{Rig: m.rig, LeaseSeconds: int(m.lease.Seconds()), WiFi: m.wifi, Analyzer: m.analyzer}

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
		s.Devices = append(s.Devices, api.DeviceStatus{Name: d.Name, Kind: d.Kind, Active: h})
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

// DeviceMetric is one DUT's slice of a MetricsSnapshot: its name and whether it
// currently has an active holder.
type DeviceMetric struct {
	Name string
	Busy bool
}

// MetricsSnapshot is a point-in-time, lock-free-to-consume view of the manager
// for the /metrics endpoint. Gauges describe the current state; the *Total
// counters are monotonic since process start (a scraper differentiates them into
// rates).
type MetricsSnapshot struct {
	Rig          string
	LeaseSeconds float64

	DUTsTotal   int // configured DUTs
	DUTsBusy    int // DUTs with an active holder
	QueueDepth  int // reservations still queued (waiting for a DUT)
	ActiveTotal int // active reservations (one per busy DUT)

	Devices []DeviceMetric // per-DUT busy state (for a device-labelled gauge)

	Reservations  uint64 // enqueued
	Activations   uint64 // queued -> active
	Releases      uint64 // ended (any reason)
	LeaseExpiries uint64 // ended by a lapsed lease
	StartFailures uint64 // container start errors
}

// Metrics returns a MetricsSnapshot for /metrics. Unlike Status (which keeps the
// legacy "idle whenever any DUT is free" summary for old clients), this reports
// the true per-DUT occupancy and queue depth, so a busy-DUT-count and a
// queue-depth panel read correctly even on a multi-DUT rig with a free slot.
func (m *Manager) Metrics() MetricsSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	busy := map[string]bool{}
	active, queued := 0, 0
	for _, r := range m.items {
		switch r.State {
		case api.StateActive:
			busy[r.Device] = true
			active++
		case api.StateQueued:
			queued++
		}
	}
	snap := MetricsSnapshot{
		Rig:           m.rig,
		LeaseSeconds:  m.lease.Seconds(),
		DUTsTotal:     len(m.devices),
		QueueDepth:    queued,
		ActiveTotal:   active,
		Reservations:  m.cReservations,
		Activations:   m.cActivations,
		Releases:      m.cReleases,
		LeaseExpiries: m.cLeaseExpiries,
		StartFailures: m.cStartFailures,
	}
	for _, d := range m.devices {
		b := busy[d.Name]
		if b {
			snap.DUTsBusy++
		}
		snap.Devices = append(snap.Devices, DeviceMetric{Name: d.Name, Busy: b})
	}
	return snap
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
	m.cLeaseExpiries += uint64(len(expired))
	m.mu.Unlock()
	for _, id := range expired {
		_ = m.Release(ctx, id, "lease expired (no heartbeat)")
	}
}

// --- BLE HCI capture ------------------------------------------------------

// StartCapture begins a bounded BLE HCI (btmon) capture for the active
// reservation id and returns its status. The capture records the one shared
// host controller (all DUTs' BLE), bounded and torn down on release — see the
// runner's capture.go.
func (m *Manager) StartCapture(ctx context.Context, id string) (*api.CaptureStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.requireActiveLocked(id); err != nil {
		return nil, err
	}
	return m.run.StartCapture(ctx, id)
}

// StopCapture ends the active reservation's capture.
func (m *Manager) StopCapture(ctx context.Context, id string) (*api.CaptureStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.requireActiveLocked(id); err != nil {
		return nil, err
	}
	return m.run.StopCapture(ctx, id)
}

// CaptureStatus reports the active reservation's capture state.
func (m *Manager) CaptureStatus(id string) (*api.CaptureStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.requireActiveLocked(id); err != nil {
		return nil, err
	}
	return m.run.CaptureStatus(id)
}

// requireActiveLocked returns ErrNotFound for an unknown id, an error for a
// non-active one, and nil when id is an active reservation. Caller holds m.mu.
func (m *Manager) requireActiveLocked(id string) error {
	r := m.findLocked(id)
	if r == nil {
		return ErrNotFound
	}
	if r.State != api.StateActive {
		return fmt.Errorf("reservation %s is %s (not active)", id, r.State)
	}
	return nil
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
			m.cStartFailures++
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
		m.cActivations++
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
		if head := m.nextWaiterForLocked(&m.devices[i]); head != nil {
			return &m.devices[i], head
		}
	}
	return nil, nil
}

// nextWaiterForLocked returns the earliest queued reservation that can run on the
// given DUT, or nil if none. A normal (USB) DUT accepts an unpinned waiter or one
// pinned to it. A network DUT is PIN-ONLY: it accepts only a waiter that named it,
// so an ordinary "any DUT" reservation (e.g. a C6 test) never lands on the Pi.
func (m *Manager) nextWaiterForLocked(dev *runner.Device) *api.Reservation {
	pinOnly := dev.Kind == "network"
	for _, r := range m.items {
		if r.State != api.StateQueued {
			continue
		}
		switch want := m.want[r.ID]; {
		case want == dev.Name:
			return r
		case want == "" && !pinOnly:
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
