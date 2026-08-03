package queue

import (
	"context"
	"testing"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// fakeRunner is a no-op runner.Runner: it records Start/Stop and hands back a
// canned endpoint, so queue tests don't need a real container backend.
type fakeRunner struct {
	started []string
	stopped []string
}

func (f *fakeRunner) Start(_ context.Context, id, _, _ string) (*api.SSHEndpoint, error) {
	f.started = append(f.started, id)
	return &api.SSHEndpoint{Host: "h", Port: 2222, User: "agent"}, nil
}

func (f *fakeRunner) Stop(_ context.Context, id string) error {
	f.stopped = append(f.stopped, id)
	return nil
}

func (f *fakeRunner) Cleanup(_ context.Context) error { return nil }

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
