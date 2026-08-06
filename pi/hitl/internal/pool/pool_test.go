package pool

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

func TestNormalize(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"hitl-rig", []string{"http://hitl-rig:8087"}},
		{"hitl-rig:9000", []string{"http://hitl-rig:9000"}},
		{"http://a:8087", []string{"http://a:8087"}},
		{"https://a.example", []string{"https://a.example:8087"}},
		{"a, b  c\nd", []string{"http://a:8087", "http://b:8087", "http://c:8087", "http://d:8087"}},
		// trailing slash normalized away; exact duplicates dropped, order kept.
		{"http://a:8087/, a, b", []string{"http://a:8087", "http://b:8087"}},
	}
	for _, c := range cases {
		if got := Normalize(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Normalize(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// mkStatus builds a status with an optional active holder and a queue length.
func mkStatus(active bool, queue int) *api.Status {
	s := &api.Status{QueueLength: queue}
	if active {
		s.Active = &api.Reservation{ID: "x", State: api.StateActive}
	}
	return s
}

func fakeGet(states map[string]*api.Status, errs map[string]error) StatusFn {
	return func(base string) (*api.Status, error) {
		if err, ok := errs[base]; ok {
			return nil, err
		}
		return states[base], nil
	}
}

func TestPickPrefersIdle(t *testing.T) {
	servers := []string{"http://a:8087", "http://b:8087", "http://c:8087"}
	states := map[string]*api.Status{
		"http://a:8087": mkStatus(true, 0),  // busy, no queue
		"http://b:8087": mkStatus(true, 2),  // busy, 2 waiting
		"http://c:8087": mkStatus(false, 0), // idle
	}
	got, err := Pick(Probes(servers, fakeGet(states, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://c:8087" {
		t.Errorf("Pick = %q, want the idle runner c", got)
	}
}

func TestPickShortestQueueWhenNoneIdle(t *testing.T) {
	servers := []string{"http://a:8087", "http://b:8087"}
	states := map[string]*api.Status{
		"http://a:8087": mkStatus(true, 3),
		"http://b:8087": mkStatus(true, 1),
	}
	got, err := Pick(Probes(servers, fakeGet(states, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://b:8087" {
		t.Errorf("Pick = %q, want shortest-queue runner b", got)
	}
}

func TestPickTieBreaksByOrder(t *testing.T) {
	servers := []string{"http://a:8087", "http://b:8087"}
	states := map[string]*api.Status{
		"http://a:8087": mkStatus(false, 0),
		"http://b:8087": mkStatus(false, 0),
	}
	got, err := Pick(Probes(servers, fakeGet(states, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://a:8087" {
		t.Errorf("Pick = %q, want first-listed runner a on a tie", got)
	}
}

func TestPickSkipsUnreachable(t *testing.T) {
	servers := []string{"http://down:8087", "http://up:8087"}
	states := map[string]*api.Status{"http://up:8087": mkStatus(true, 5)}
	errs := map[string]error{"http://down:8087": fmt.Errorf("connection refused")}
	got, err := Pick(Probes(servers, fakeGet(states, errs)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://up:8087" {
		t.Errorf("Pick = %q, want the reachable runner up", got)
	}
}

func TestPickAllDownIsError(t *testing.T) {
	servers := []string{"http://a:8087", "http://b:8087"}
	errs := map[string]error{
		"http://a:8087": fmt.Errorf("refused"),
		"http://b:8087": fmt.Errorf("timeout"),
	}
	if _, err := Pick(Probes(servers, fakeGet(nil, errs))); err == nil {
		t.Fatal("expected an error when every runner is down")
	}
}

func TestPickEmpty(t *testing.T) {
	if _, err := Pick(nil); err == nil {
		t.Fatal("expected an error for an empty pool")
	}
}

// mkMultiDUT builds a multi-DUT status: `free` idle DUTs and `busy` busy ones.
// A multi-DUT daemon reports Active=nil (idle) whenever any DUT is free.
func mkMultiDUT(free, busy int) *api.Status {
	s := &api.Status{}
	for i := 0; i < free; i++ {
		s.Devices = append(s.Devices, api.DeviceStatus{Name: fmt.Sprintf("d%d", i)})
	}
	for i := 0; i < busy; i++ {
		s.Devices = append(s.Devices, api.DeviceStatus{
			Name:   fmt.Sprintf("b%d", i),
			Active: &api.Reservation{ID: "x", State: api.StateActive},
		})
	}
	if free == 0 {
		s.Active = &api.Reservation{ID: "x", State: api.StateActive}
	}
	return s
}

// Among idle rigs, prefer the one with more free DUTs so load spreads and no
// single rig's spare capacity is exhausted first.
func TestPickPrefersMoreFreeDUTs(t *testing.T) {
	servers := []string{"http://a:8087", "http://b:8087"}
	states := map[string]*api.Status{
		"http://a:8087": mkMultiDUT(1, 3), // 1 of 4 free
		"http://b:8087": mkMultiDUT(3, 1), // 3 of 4 free
	}
	got, err := Pick(Probes(servers, fakeGet(states, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://b:8087" {
		t.Errorf("Pick = %q, want b (more free DUTs)", got)
	}
}

// A single-DUT (legacy) daemon sends no Devices; it must still be treated as one
// free slot and win over a fully-busy multi-DUT rig.
func TestPickLegacyIdleBeatsBusyMultiDUT(t *testing.T) {
	servers := []string{"http://busy:8087", "http://legacy:8087"}
	states := map[string]*api.Status{
		"http://busy:8087":   mkMultiDUT(0, 4), // all busy
		"http://legacy:8087": mkStatus(false, 0),
	}
	got, err := Pick(Probes(servers, fakeGet(states, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://legacy:8087" {
		t.Errorf("Pick = %q, want the idle legacy runner", got)
	}
}
