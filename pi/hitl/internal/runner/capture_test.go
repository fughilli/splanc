package runner

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// With no btmon configured the feature is off: StartCapture refuses rather than
// silently doing nothing.
func TestStartCaptureDisabled(t *testing.T) {
	p := NewPodman(PodmanConfig{}) // Btmon == "" → disabled
	if _, err := p.StartCapture(context.Background(), "res1"); err == nil {
		t.Fatal("StartCapture with no btmon configured should error")
	}
}

// Status for an id with no capture is well-formed: not running, but still carries
// the in-container path so the CLI can tell the agent where to read it.
func TestCaptureStatusUnknownID(t *testing.T) {
	p := NewPodman(PodmanConfig{})
	st, err := p.CaptureStatus("nope")
	if err != nil {
		t.Fatalf("CaptureStatus on unknown id: %v", err)
	}
	if st.Running {
		t.Error("no capture → Running should be false")
	}
	if st.ContainerPath == "" {
		t.Error("status should always carry the in-container path")
	}
}

// Start → (idempotent) start → stop, driving a stand-in btmon so no real HCI
// socket is needed. Exercises the map bookkeeping and status transitions.
func TestCaptureStartStopLifecycle(t *testing.T) {
	dir := t.TempDir()
	// Stand-in btmon: ignore its flags and just stay alive so the capture is "live"
	// until we stop it (finish() cancels its context, which kills it).
	fake := filepath.Join(dir, "fakebtmon")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	p := NewPodman(PodmanConfig{StateDir: dir, Btmon: fake})

	st, err := p.StartCapture(context.Background(), "res1")
	if err != nil {
		t.Fatalf("StartCapture: %v", err)
	}
	if !st.Running {
		t.Error("capture should be running after start")
	}
	if st.ContainerPath != captureContainerPath {
		t.Errorf("ContainerPath = %q, want %q", st.ContainerPath, captureContainerPath)
	}
	// A second start while running is a no-op that still reports running.
	if again, err := p.StartCapture(context.Background(), "res1"); err != nil || !again.Running {
		t.Fatalf("idempotent StartCapture: st=%+v err=%v", again, err)
	}

	st2, err := p.StopCapture(context.Background(), "res1")
	if err != nil {
		t.Fatalf("StopCapture: %v", err)
	}
	if st2.Running {
		t.Error("capture should be stopped after StopCapture")
	}
}

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{0: "0B", 512: "512B", 1024: "1KiB", 64 << 20: "64MiB"}
	for n, want := range cases {
		if got := humanBytes(n); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", n, got, want)
		}
	}
}
