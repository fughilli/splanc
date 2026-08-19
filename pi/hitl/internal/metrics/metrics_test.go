package metrics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriterExposition(t *testing.T) {
	var b strings.Builder
	w := NewWriter(&b)
	// Two samples of the same gauge family: HELP/TYPE must appear exactly once,
	// and labels are sorted for stable output.
	w.Gauge("hitl_dut_busy", "1 if busy.", 1, Label{Name: "rig", Value: "r1"}, Label{Name: "device", Value: "c6-a"})
	w.Gauge("hitl_dut_busy", "1 if busy.", 0, Label{Name: "rig", Value: "r1"}, Label{Name: "device", Value: "c6-b"})
	w.Counter("hitl_reservations_total", "Enqueued.", 7, Label{Name: "rig", Value: "r1"})
	got := b.String()

	want := strings.Join([]string{
		"# HELP hitl_dut_busy 1 if busy.",
		"# TYPE hitl_dut_busy gauge",
		`hitl_dut_busy{device="c6-a",rig="r1"} 1`,
		`hitl_dut_busy{device="c6-b",rig="r1"} 0`,
		"# HELP hitl_reservations_total Enqueued.",
		"# TYPE hitl_reservations_total counter",
		`hitl_reservations_total{rig="r1"} 7`,
		"",
	}, "\n")
	if got != want {
		t.Fatalf("exposition mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
	// The family header must not repeat for the second sample.
	if n := strings.Count(got, "# TYPE hitl_dut_busy"); n != 1 {
		t.Errorf("hitl_dut_busy TYPE emitted %d times, want 1", n)
	}
}

func TestValueFormatting(t *testing.T) {
	var b strings.Builder
	w := NewWriter(&b)
	// Integers render without a trailing .0; fractions render exactly.
	w.Gauge("g_int", "h", 1024*1024)
	w.Gauge("g_frac", "h", 46.7)
	got := b.String()
	if !strings.Contains(got, "g_int 1048576\n") {
		t.Errorf("integer gauge not rendered as bare int: %q", got)
	}
	if !strings.Contains(got, "g_frac 46.7\n") {
		t.Errorf("fractional gauge mangled: %q", got)
	}
}

func TestLabelEscaping(t *testing.T) {
	var b strings.Builder
	w := NewWriter(&b)
	w.Gauge("g", "h", 1, Label{Name: "n", Value: `a"b\c` + "\n"})
	got := b.String()
	if !strings.Contains(got, `g{n="a\"b\\c\n"} 1`) {
		t.Errorf("label value not escaped: %q", got)
	}
}

func TestReadHost(t *testing.T) {
	dir := t.TempDir()
	load := filepath.Join(dir, "loadavg")
	mem := filepath.Join(dir, "meminfo")
	temp := filepath.Join(dir, "temp")
	if err := os.WriteFile(load, []byte("0.42 0.30 0.25 1/234 5678\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mem, []byte("MemTotal:        8000 kB\nBuffers:  10 kB\nMemAvailable:    3000 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temp, []byte("46700\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if v, ok := readLoad1(load); !ok || v != 0.42 {
		t.Errorf("readLoad1 = %v, %v; want 0.42, true", v, ok)
	}
	total, avail, ok := readMem(mem)
	if !ok || total != 8000*1024 || avail != 3000*1024 {
		t.Errorf("readMem = %v, %v, %v; want %d, %d, true", total, avail, ok, 8000*1024, 3000*1024)
	}
	if v, ok := readTemp(temp); !ok || v != 46.7 {
		t.Errorf("readTemp = %v, %v; want 46.7, true", v, ok)
	}

	// Missing sources degrade to not-OK, never a bogus zero.
	if _, ok := readLoad1(filepath.Join(dir, "nope")); ok {
		t.Error("readLoad1 on missing file should be !ok")
	}
	if _, _, ok := readMem(filepath.Join(dir, "nope")); ok {
		t.Error("readMem on missing file should be !ok")
	}
	if _, ok := readTemp(filepath.Join(dir, "nope")); ok {
		t.Error("readTemp on missing file should be !ok")
	}
}
