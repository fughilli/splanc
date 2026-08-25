package queue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

// fakeRunner is a no-op runner.Runner: it records Start/Stop and hands back an
// endpoint carrying the assigned DUT's port, so queue tests don't need a real
// container backend and can assert which DUT a reservation landed on.
type fakeRunner struct {
	started    []string
	stopped    []string
	capStarted []string
	capStopped []string
	onDev      map[string]string            // reservation id -> DUT name it started on
	onEnv      map[string]map[string]string // reservation id -> DUT env it started with
}

func (f *fakeRunner) Start(_ context.Context, id, _, _ string, dev runner.Device) (*api.SSHEndpoint, error) {
	f.started = append(f.started, id)
	if f.onDev == nil {
		f.onDev = map[string]string{}
		f.onEnv = map[string]map[string]string{}
	}
	f.onDev[id] = dev.Name
	f.onEnv[id] = dev.Env
	port := dev.SSHPort
	if port == 0 {
		port = 2222
	}
	return &api.SSHEndpoint{Host: "h", Port: port, User: "agent"}, nil
}

func (f *fakeRunner) Stop(_ context.Context, id string) error {
	f.stopped = append(f.stopped, id)
	return nil
}

func (f *fakeRunner) Cleanup(_ context.Context) error { return nil }

func (f *fakeRunner) StartCapture(_ context.Context, id string) (*api.CaptureStatus, error) {
	f.capStarted = append(f.capStarted, id)
	return &api.CaptureStatus{Running: true, ContainerPath: "/run/hitl/capture/hci.btsnoop"}, nil
}

func (f *fakeRunner) StopCapture(_ context.Context, id string) (*api.CaptureStatus, error) {
	f.capStopped = append(f.capStopped, id)
	return &api.CaptureStatus{Running: false, Reason: "stopped by request"}, nil
}

func (f *fakeRunner) CaptureStatus(_ string) (*api.CaptureStatus, error) {
	return &api.CaptureStatus{ContainerPath: "/run/hitl/capture/hci.btsnoop"}, nil
}

// fakeAP records the AP up/down toggles the manager makes around a reservation.
type fakeAP struct {
	ups   int
	downs int
}

func (a *fakeAP) Up(_ context.Context) error   { a.ups++; return nil }
func (a *fakeAP) Down(_ context.Context) error { a.downs++; return nil }

// expire forces a reservation's lease into the past — simulating a client that
// stopped heartbeating (its process died).
func (m *Manager) expire(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.findLocked(id); r != nil {
		past := time.Now().Add(-time.Minute)
		r.ExpiresAt = &past
	}
}

func present(m *Manager, id string) bool {
	_, err := m.Get(id)
	return err == nil
}

// A queued waiter whose client dies must be reaped by the whole-queue sweep —
// the bug this guards is ReapExpired only ever inspecting the active head, so a
// dead waiter stranded its slot forever.
func TestReapSweepsDeadQueuedWaiter(t *testing.T) {
	ctx := context.Background()
	m := New("rig", 30*time.Minute, &fakeRunner{})
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // head → active
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued
	c := m.Reserve(ctx, api.ReserveRequest{Owner: "c"}) // queued

	if a.State != api.StateActive {
		t.Fatalf("first reservation should be active, got %q", a.State)
	}
	if b.State != api.StateQueued || c.State != api.StateQueued {
		t.Fatalf("later reservations should be queued, got b=%q c=%q", b.State, c.State)
	}

	m.expire(b.ID) // b's client dies mid-queue
	m.ReapExpired(ctx)

	if present(m, b.ID) {
		t.Error("dead queued waiter b should have been reaped")
	}
	if !present(m, a.ID) {
		t.Error("active holder a should survive the sweep")
	}
	if !present(m, c.ID) {
		t.Error("live queued waiter c should survive the sweep")
	}
}

// A queued waiter that keeps heartbeating must NOT be reaped — the heartbeat has
// to refresh the lease for queued reservations, not just the active holder.
func TestHeartbeatKeepsQueuedWaiterAlive(t *testing.T) {
	ctx := context.Background()
	m := New("rig", 30*time.Minute, &fakeRunner{})
	m.Reserve(ctx, api.ReserveRequest{Owner: "a"})      // active
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued

	m.expire(b.ID)
	if err := m.Heartbeat(b.ID); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	m.ReapExpired(ctx)

	if !present(m, b.ID) {
		t.Error("a queued waiter that heartbeats must not be reaped")
	}
}

// The pre-existing behavior still holds: an expired active head is torn down and
// the next waiter is promoted.
func TestReapExpiredActiveHeadPromotesNext(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr)
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // active
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued

	m.expire(a.ID)
	m.ReapExpired(ctx)

	if present(m, a.ID) {
		t.Error("expired active head should be released")
	}
	got, err := m.Get(b.ID)
	if err != nil || got.State != api.StateActive {
		t.Errorf("next waiter b should be promoted to active, got %+v err=%v", got, err)
	}
	if len(fr.stopped) != 1 || fr.stopped[0] != a.ID {
		t.Errorf("reaped active head should have been Stop()ped once: %v", fr.stopped)
	}
}

// The provisioning AP is raised when a reservation activates and dropped on
// release; a promotion (release active → next waiter) drops it for the old holder
// and raises it for the new one.
func TestAPToggledAroundReservation(t *testing.T) {
	ctx := context.Background()
	fap := &fakeAP{}
	m := New("rig", 30*time.Minute, &fakeRunner{}, WithAP(fap))

	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // active → AP up
	if fap.ups != 1 || fap.downs != 0 {
		t.Fatalf("after activate: ups=%d downs=%d, want 1/0", fap.ups, fap.downs)
	}
	m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued → no AP change
	if fap.ups != 1 || fap.downs != 0 {
		t.Fatalf("queuing a waiter must not toggle the AP: ups=%d downs=%d", fap.ups, fap.downs)
	}
	if err := m.Release(ctx, a.ID, "done"); err != nil { // active released → AP down, then up for b
		t.Fatalf("release: %v", err)
	}
	if fap.downs != 1 || fap.ups != 2 {
		t.Errorf("after promotion: ups=%d downs=%d, want 2/1", fap.ups, fap.downs)
	}
}

// A nil AP (rig without one) is a no-op — the reservation lifecycle is unaffected.
func TestNoAPIsNoOp(t *testing.T) {
	ctx := context.Background()
	m := New("rig", 30*time.Minute, &fakeRunner{})
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	if a.State != api.StateActive {
		t.Fatalf("reservation should activate without an AP, got %q", a.State)
	}
	if err := m.Release(ctx, a.ID, "done"); err != nil {
		t.Fatalf("release: %v", err)
	}
}

// twoDUTs returns a Manager with two named DUTs on distinct ports.
func twoDUTs(fr runner.Runner) *Manager {
	return New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{
		{Name: "c6-0", SSHPort: 2222},
		{Name: "c6-1", SSHPort: 2223},
	}))
}

// Two reservations on a two-DUT rig both go active at once, on different DUTs and
// different SSH ports — the whole point of multi-DUT.
func TestTwoDUTsActivateConcurrently(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := twoDUTs(fr)
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"})

	if a.State != api.StateActive || b.State != api.StateActive {
		t.Fatalf("both reservations should be active: a=%q b=%q", a.State, b.State)
	}
	if a.Device == b.Device {
		t.Errorf("reservations should land on different DUTs, both on %q", a.Device)
	}
	if a.SSH.Port == b.SSH.Port {
		t.Errorf("reservations should get distinct ports, both %d", a.SSH.Port)
	}
	if len(fr.started) != 2 {
		t.Errorf("both containers should have started: %v", fr.started)
	}
}

// A third reservation on a two-DUT rig waits, then takes whichever DUT frees.
func TestThirdWaitsThenTakesFreedDUT(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := twoDUTs(fr)
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	m.Reserve(ctx, api.ReserveRequest{Owner: "b"})
	c := m.Reserve(ctx, api.ReserveRequest{Owner: "c"})

	if c.State != api.StateQueued {
		t.Fatalf("third reservation should queue behind two busy DUTs, got %q", c.State)
	}
	if err := m.Release(ctx, a.ID, "done"); err != nil {
		t.Fatalf("release: %v", err)
	}
	got, err := m.Get(c.ID)
	if err != nil || got.State != api.StateActive {
		t.Fatalf("c should be promoted onto the freed DUT, got %+v err=%v", got, err)
	}
	if got.Device != a.Device {
		t.Errorf("c should take the DUT a freed (%q), got %q", a.Device, got.Device)
	}
}

// A reservation pinned to a named DUT lands on it; a second pin to the same DUT
// waits even though the other DUT is free; an unpinned reservation fills the free
// DUT past the waiting pin (no false head-of-line block for compatible work).
func TestPinnedDeviceRouting(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := twoDUTs(fr)

	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a", Device: "c6-0"})
	if a.State != api.StateActive || a.Device != "c6-0" {
		t.Fatalf("pinned reservation should activate on c6-0, got state=%q dev=%q", a.State, a.Device)
	}
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b", Device: "c6-0"}) // c6-0 busy → must wait
	if b.State != api.StateQueued {
		t.Fatalf("second pin to c6-0 should queue, got %q", b.State)
	}
	c := m.Reserve(ctx, api.ReserveRequest{Owner: "c"}) // unpinned → free c6-1
	if c.State != api.StateActive || c.Device != "c6-1" {
		t.Fatalf("unpinned reservation should take the free c6-1, got state=%q dev=%q", c.State, c.Device)
	}
	if got, _ := m.Get(b.ID); got.State != api.StateQueued {
		t.Errorf("pinned waiter b should still be queued (its DUT is busy), got %q", got.State)
	}
	// Free c6-0 → b (the pin) claims it, not any later unpinned work.
	if err := m.Release(ctx, a.ID, "done"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if got, _ := m.Get(b.ID); got.State != api.StateActive || got.Device != "c6-0" {
		t.Errorf("b should activate on the freed c6-0, got %+v", got)
	}
}

// With several DUTs active, the shared provisioning AP stays up until the LAST
// one releases — releasing one concurrent holder must not drop it on the other.
func TestAPStaysUpWhileAnyDUTActive(t *testing.T) {
	ctx := context.Background()
	fap := &fakeAP{}
	m := New("rig", 30*time.Minute, &fakeRunner{}, WithDevices([]runner.Device{
		{Name: "c6-0", SSHPort: 2222},
		{Name: "c6-1", SSHPort: 2223},
	}), WithAP(fap))

	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // dut up → AP up
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // second dut up
	if fap.ups == 0 {
		t.Fatalf("AP should be up with DUTs active: ups=%d", fap.ups)
	}
	if err := m.Release(ctx, a.ID, "done"); err != nil {
		t.Fatalf("release a: %v", err)
	}
	if fap.downs != 0 {
		t.Errorf("AP must stay up while b is still active, got downs=%d", fap.downs)
	}
	if err := m.Release(ctx, b.ID, "done"); err != nil {
		t.Fatalf("release b: %v", err)
	}
	if fap.downs != 1 {
		t.Errorf("AP should drop once the last DUT releases, got downs=%d", fap.downs)
	}
}

// A waiter pinned to the SECOND DUT must activate on it even while the first DUT
// sits free with no compatible work — reconcile has to scan every free DUT, not
// just the first, or the pin strands forever.
func TestPinnedToSecondDUTActivatesWhileFirstFree(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := twoDUTs(fr)

	r := m.Reserve(ctx, api.ReserveRequest{Owner: "a", Device: "c6-1"})
	if r.State != api.StateActive || r.Device != "c6-1" {
		t.Fatalf("pin to the second DUT should activate on c6-1 (c6-0 free), got state=%q dev=%q", r.State, r.Device)
	}
}

// Status keeps the legacy summary usable by old clients: while a DUT is free the
// rig reports idle (Active=nil, queue 0); once every DUT is busy it names a holder
// and counts the still-unassigned waiters. The per-DUT breakdown is always present.
func TestStatusMultiDUTBackwardCompat(t *testing.T) {
	ctx := context.Background()
	m := twoDUTs(&fakeRunner{})

	// One DUT busy, one free → still "available".
	m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	s := m.Status()
	if s.Active != nil || s.QueueLength != 0 {
		t.Errorf("with a free DUT the rig must look idle: active=%v queue=%d", s.Active, s.QueueLength)
	}
	if len(s.Devices) != 2 {
		t.Fatalf("expected 2 DUTs in Status.Devices, got %d", len(s.Devices))
	}

	// Fill the second DUT and add two waiters → now busy with a queue.
	m.Reserve(ctx, api.ReserveRequest{Owner: "b"})
	m.Reserve(ctx, api.ReserveRequest{Owner: "c"})
	m.Reserve(ctx, api.ReserveRequest{Owner: "d"})
	s = m.Status()
	if s.Active == nil {
		t.Error("with every DUT busy the rig must surface a holder")
	}
	if s.QueueLength != 2 {
		t.Errorf("QueueLength should count the 2 unassigned waiters, got %d", s.QueueLength)
	}
	free := 0
	for _, d := range s.Devices {
		if d.Active == nil {
			free++
		}
	}
	if free != 0 {
		t.Errorf("both DUTs should report busy, got %d free", free)
	}
}

// HasDevice/Devices back the daemon's reserve-time validation of a pinned DUT.
func TestHasDevice(t *testing.T) {
	m := twoDUTs(&fakeRunner{})
	if !m.HasDevice("c6-1") {
		t.Error("c6-1 should be a known DUT")
	}
	if m.HasDevice("nope") {
		t.Error("unknown DUT must not validate")
	}
	if got := m.Devices(); len(got) != 2 || got[0] != "c6-0" || got[1] != "c6-1" {
		t.Errorf("Devices() = %v, want [c6-0 c6-1]", got)
	}
}

// The rig's AP creds are advertised in Status when configured, and absent otherwise.
func TestStatusAdvertisesWiFi(t *testing.T) {
	ctx := context.Background()
	m := New("rig", 30*time.Minute, &fakeRunner{}, WithWiFi(&api.WiFiInfo{SSID: "hitl-rig", PSK: "secretpw"}))
	m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	s := m.Status()
	if s.WiFi == nil || s.WiFi.SSID != "hitl-rig" || s.WiFi.PSK != "secretpw" {
		t.Errorf("Status.WiFi = %+v, want ssid=hitl-rig psk=secretpw", s.WiFi)
	}
	if bare := New("rig", 30*time.Minute, &fakeRunner{}).Status(); bare.WiFi != nil {
		t.Errorf("Status.WiFi without an AP should be nil, got %+v", bare.WiFi)
	}
}

// Hot-plug: SyncDevices adds a newly-attached DUT and reconciles a waiting
// reservation onto it — without a daemon restart.
func TestSyncDevicesAttachesAndPromotes(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{{Name: "c6-a", SSHPort: 2222}}))
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // active on the only DUT
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued: no free DUT
	if a.State != api.StateActive || b.State != api.StateQueued {
		t.Fatalf("setup: a=%q b=%q", a.State, b.State)
	}

	// A second board is plugged in live.
	added, removed := m.SyncDevices(ctx, []runner.Device{
		{Name: "c6-a", SSHPort: 2222}, {Name: "c6-b", SSHPort: 2223},
	})
	if len(added) != 1 || added[0] != "c6-b" || len(removed) != 0 {
		t.Fatalf("SyncDevices added=%v removed=%v, want added=[c6-b]", added, removed)
	}
	if got, _ := m.Get(b.ID); got.State != api.StateActive || got.Device != "c6-b" {
		t.Errorf("waiter b should be active on the new DUT c6-b, got state=%q dut=%q", got.State, got.Device)
	}
	if got, _ := m.Get(a.ID); got.Device != "c6-a" {
		t.Errorf("existing holder a must stay on c6-a, got %q", got.Device)
	}
}

// A flapping/resetting board that momentarily drops out of discovery must NOT
// tear down its active holder — the reservation has to survive the DUT
// disappearing from a sync. (The idle case still evicts; see below.)
func TestSyncDevicesKeepsBusyDUTWhenReportedGone(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{
		{Name: "c6-a", SSHPort: 2222}, {Name: "c6-b", SSHPort: 2223},
	}))
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a", Device: "c6-a"})
	if a.State != api.StateActive {
		t.Fatalf("a should be active, got %q", a.State)
	}

	// Discovery briefly reports only c6-b (c6-a's board blinked out mid-reset).
	added, removed := m.SyncDevices(ctx, []runner.Device{{Name: "c6-b", SSHPort: 2223}})
	if len(added) != 0 || len(removed) != 0 {
		t.Fatalf("a busy DUT reported gone must be retained, got added=%v removed=%v", added, removed)
	}
	if got, _ := m.Get(a.ID); got == nil || got.State != api.StateActive {
		t.Error("holder of the flapping DUT must keep its live reservation")
	}
	for _, id := range fr.stopped {
		if id == a.ID {
			t.Fatal("busy DUT's container must not be stopped on a transient discovery miss")
		}
	}
}

// Hot-unplug: an idle removed DUT is dropped immediately; a busy one is retained
// until its holder releases and only then pruned — and the other DUT's live
// session is untouched throughout.
func TestSyncDevicesEvictsIdleButDefersBusyDUT(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	both := []runner.Device{{Name: "c6-a", SSHPort: 2222}, {Name: "c6-b", SSHPort: 2223}}
	m := New("rig", 30*time.Minute, fr, WithDevices(both))
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b", Device: "c6-b"}) // active; c6-a idle
	if b.State != api.StateActive {
		t.Fatalf("b should be active, got %q", b.State)
	}

	// Idle board c6-a is unplugged → dropped at once. c6-b's session is untouched.
	_, removed := m.SyncDevices(ctx, []runner.Device{{Name: "c6-b", SSHPort: 2223}})
	if len(removed) != 1 || removed[0] != "c6-a" {
		t.Fatalf("idle removed DUT should drop, got removed=%v", removed)
	}
	if got, _ := m.Get(b.ID); got == nil || got.State != api.StateActive {
		t.Error("holder of the surviving DUT c6-b must be untouched")
	}

	// Now c6-b's board goes away while it's busy: retained, container not stopped.
	if _, removed = m.SyncDevices(ctx, nil); len(removed) != 0 {
		t.Fatalf("busy DUT must be retained, got removed=%v", removed)
	}
	if got, _ := m.Get(b.ID); got == nil || got.State != api.StateActive {
		t.Error("busy DUT's reservation must survive its board vanishing")
	}

	// The holder releases; the board is still gone, so the next sync prunes it.
	if err := m.Release(ctx, b.ID, "done"); err != nil {
		t.Fatal(err)
	}
	if _, removed = m.SyncDevices(ctx, nil); len(removed) != 1 || removed[0] != "c6-b" {
		t.Fatalf("once released and still gone, c6-b should be pruned, got removed=%v", removed)
	}
}

// Metrics reflects true per-DUT occupancy and queue depth (not the legacy
// "idle whenever any DUT is free" summary), and its lifecycle counters advance
// as reservations are enqueued, activated, released, and lease-expired.
func TestMetricsSnapshot(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{
		{Name: "c6-a", SSHPort: 2222},
		{Name: "c6-b", SSHPort: 2223},
	}))

	// Three reservations: two fill both DUTs, the third queues behind them.
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a", SSHPublicKey: "k"})
	m.Reserve(ctx, api.ReserveRequest{Owner: "b", SSHPublicKey: "k"})
	m.Reserve(ctx, api.ReserveRequest{Owner: "c", SSHPublicKey: "k"})

	s := m.Metrics()
	if s.DUTsTotal != 2 || s.DUTsBusy != 2 || s.ActiveTotal != 2 {
		t.Errorf("occupancy = total %d busy %d active %d; want 2/2/2", s.DUTsTotal, s.DUTsBusy, s.ActiveTotal)
	}
	if s.QueueDepth != 1 {
		t.Errorf("QueueDepth = %d, want 1 (the third, unassigned waiter)", s.QueueDepth)
	}
	if s.Reservations != 3 || s.Activations != 2 {
		t.Errorf("counters: reservations %d activations %d; want 3/2", s.Reservations, s.Activations)
	}
	busy := map[string]bool{}
	for _, d := range s.Devices {
		busy[d.Name] = d.Busy
	}
	if !busy["c6-a"] || !busy["c6-b"] || len(s.Devices) != 2 {
		t.Errorf("per-DUT busy = %+v, want both busy", s.Devices)
	}

	// Release one holder: the queued waiter is promoted onto the freed DUT, so the
	// rig stays full but releases/activations advance.
	if err := m.Release(ctx, a.ID, "done"); err != nil {
		t.Fatal(err)
	}
	s = m.Metrics()
	if s.DUTsBusy != 2 || s.QueueDepth != 0 {
		t.Errorf("after release+promote: busy %d queue %d; want 2/0", s.DUTsBusy, s.QueueDepth)
	}
	if s.Releases != 1 || s.Activations != 3 {
		t.Errorf("after release: releases %d activations %d; want 1/3", s.Releases, s.Activations)
	}

	// A lapsed lease is counted as both a release and a lease expiry: expire every
	// active holder and reap.
	m.mu.Lock()
	for _, r := range m.items {
		past := time.Now().Add(-time.Minute)
		r.ExpiresAt = &past
	}
	m.mu.Unlock()
	m.ReapExpired(ctx)
	s = m.Metrics()
	if s.LeaseExpiries != 2 {
		t.Errorf("LeaseExpiries = %d, want 2", s.LeaseExpiries)
	}
	if s.DUTsBusy != 0 || s.ActiveTotal != 0 {
		t.Errorf("after reaping all: busy %d active %d; want 0/0", s.DUTsBusy, s.ActiveTotal)
	}
}

// Capture control is gated on an active reservation and delegates to the runner:
// start/stop only work on an active id, and a queued or unknown id is rejected
// before the runner is touched.
func TestCaptureRequiresActiveReservation(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr)
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"}) // head → active
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"}) // queued behind a

	if _, err := m.StartCapture(ctx, a.ID); err != nil {
		t.Fatalf("StartCapture on active reservation: %v", err)
	}
	if _, err := m.StopCapture(ctx, a.ID); err != nil {
		t.Fatalf("StopCapture on active reservation: %v", err)
	}
	if len(fr.capStarted) != 1 || fr.capStarted[0] != a.ID {
		t.Errorf("runner should have started capture for %s, got %v", a.ID, fr.capStarted)
	}
	if len(fr.capStopped) != 1 || fr.capStopped[0] != a.ID {
		t.Errorf("runner should have stopped capture for %s, got %v", a.ID, fr.capStopped)
	}

	// A queued waiter has no container/adapter — capture must be refused without
	// reaching the runner.
	if _, err := m.StartCapture(ctx, b.ID); err == nil {
		t.Error("StartCapture on a queued reservation should error")
	}
	// An unknown id is ErrNotFound.
	if _, err := m.CaptureStatus("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("CaptureStatus unknown id: want ErrNotFound, got %v", err)
	}
	if len(fr.capStarted) != 1 {
		t.Errorf("runner capture must not be touched for a non-active id, got %v", fr.capStarted)
	}
}

// A network DUT is PIN-ONLY: an unpinned "any DUT" reservation never lands on it
// (so a C6 test can't accidentally run against a Pi), but a reservation that pins
// it by name activates on it.
func TestNetworkDUTPinOnly(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{
		{Name: "c6-0", SSHPort: 2222},
		{Name: "pi-1", SSHPort: 2230, Kind: "network"},
	}))

	// Unpinned reservation takes the C6, never the network DUT.
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a"})
	if a.State != api.StateActive || a.Device != "c6-0" {
		t.Fatalf("unpinned should land on c6-0, got state=%q dev=%q", a.State, a.Device)
	}

	// A second unpinned reservation must QUEUE: the C6 is busy and the only free
	// DUT (pi-1) is pin-only, so it must not silently take the Pi.
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b"})
	if b.State != api.StateQueued {
		t.Fatalf("second unpinned should queue (network DUT is pin-only), got state=%q dev=%q", b.State, b.Device)
	}

	// A reservation pinned to the network DUT activates on it.
	c := m.Reserve(ctx, api.ReserveRequest{Owner: "c", Device: "pi-1"})
	if c.State != api.StateActive || c.Device != "pi-1" {
		t.Fatalf("pin to pi-1 should activate on it, got state=%q dev=%q", c.State, c.Device)
	}

	// b is still queued (it wanted any DUT; only the pin-only Pi was free).
	if got, _ := m.Get(b.ID); got.State != api.StateQueued {
		t.Fatalf("b should remain queued, got %q", got.State)
	}
}

// A re-seeded network DUT's changed env is adopted in place while the DUT is
// IDLE (no remove/re-add needed), but a DUT with a live reservation keeps its
// spec until the holder releases — the container is never restarted under it.
func TestSyncDevicesUpdatesIdleDUTSpec(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr) // starts with no DUTs
	mk := func(v string) runner.Device {
		return runner.Device{Name: "pi-1", Kind: "network", SSHPort: 2230, Env: map[string]string{"K": v}}
	}

	m.SyncDevices(ctx, []runner.Device{mk("A")}) // attach
	m.SyncDevices(ctx, []runner.Device{mk("B")}) // idle → adopt changed env in place

	// Reserving it brings the container up with the UPDATED env.
	r := m.Reserve(ctx, api.ReserveRequest{Owner: "o", Device: "pi-1"})
	if r.State != api.StateActive {
		t.Fatalf("pinned reserve should activate, got %q", r.State)
	}
	if got := fr.onEnv[r.ID]["K"]; got != "B" {
		t.Fatalf("idle re-seed should update env in place: container got K=%q, want B", got)
	}

	// Now busy: a further re-seed must NOT restart or mutate the live container.
	startsBefore := len(fr.started)
	m.SyncDevices(ctx, []runner.Device{mk("C")})
	if len(fr.started) != startsBefore {
		t.Fatalf("busy DUT re-seed should not restart the container (starts %d -> %d)", startsBefore, len(fr.started))
	}

	// After release, the pending change is applied on the next scan.
	if err := m.Release(ctx, r.ID, "done"); err != nil {
		t.Fatalf("release: %v", err)
	}
	m.SyncDevices(ctx, []runner.Device{mk("C")})
	r2 := m.Reserve(ctx, api.ReserveRequest{Owner: "o2", Device: "pi-1"})
	if got := fr.onEnv[r2.ID]["K"]; got != "C" {
		t.Fatalf("re-seed after release should apply: container got K=%q, want C", got)
	}
}

// A reservation can require DUT capabilities: it lands only on a DUT whose
// advertised capabilities are a superset, it may land on a (pin-only) network DUT
// when the caps match — an explicit opt-in — and it queues if nothing satisfies it.
func TestReserveByCapabilities(t *testing.T) {
	ctx := context.Background()
	fr := &fakeRunner{}
	m := New("rig", 30*time.Minute, fr, WithDevices([]runner.Device{
		{Name: "c6-0", SSHPort: 2222, Capabilities: []string{"flash", "improv", "wss-app"}},
		{Name: "pi-1", SSHPort: 2230, Kind: "network", Capabilities: []string{"improv"}},
	}))

	// require improv → first matching free DUT (c6-0).
	a := m.Reserve(ctx, api.ReserveRequest{Owner: "a", RequireCaps: []string{"improv"}})
	if a.State != api.StateActive || a.Device != "c6-0" {
		t.Fatalf("improv reserve should take c6-0, got state=%q dev=%q", a.State, a.Device)
	}
	// require improv again → c6-0 busy; pi-1 has improv, so caps opt PAST the
	// network pin-only guard and it lands there.
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b", RequireCaps: []string{"improv"}})
	if b.State != api.StateActive || b.Device != "pi-1" {
		t.Fatalf("second improv reserve should fall to pi-1 via caps opt-in, got state=%q dev=%q", b.State, b.Device)
	}
}

// A capability only one DUT has, while that DUT is busy, makes the reservation
// wait — it never lands on a DUT missing the capability.
func TestReserveByCapabilityRespectsMissingCaps(t *testing.T) {
	ctx := context.Background()
	m := New("rig", 30*time.Minute, &fakeRunner{}, WithDevices([]runner.Device{
		{Name: "c6-0", SSHPort: 2222, Capabilities: []string{"improv", "wss-app"}},
		{Name: "pi-1", SSHPort: 2230, Kind: "network", Capabilities: []string{"improv"}},
	}))
	// Occupy the only wss-app DUT (c6-0) with an improv holder.
	m.Reserve(ctx, api.ReserveRequest{Owner: "a", Device: "c6-0"})
	// A wss-app reservation must queue — pi-1 lacks wss-app, c6-0 is busy.
	b := m.Reserve(ctx, api.ReserveRequest{Owner: "b", RequireCaps: []string{"wss-app"}})
	if b.State != api.StateQueued {
		t.Fatalf("wss-app reserve should queue (only c6-0 has it, busy), got %q on %q", b.State, b.Device)
	}
	// An unrelated absent capability never matches, even with a free DUT.
	c := m.Reserve(ctx, api.ReserveRequest{Owner: "c", RequireCaps: []string{"mic"}})
	if c.State != api.StateQueued {
		t.Fatalf("mic reserve should queue (no DUT has mic), got %q on %q", c.State, c.Device)
	}
}
