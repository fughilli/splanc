// Package pool turns a list of HITL runner endpoints (from $HITL_SERVERS) into a
// single chosen runner: it queries each runner's /status and picks a FREE one so
// an agent doesn't queue behind a busy rig when another sits idle.
//
// Selection order: prefer a runner with no active holder (idle); if none is
// idle, prefer the shortest queue (you'll wait the least); ties break by the
// order the runner appeared in $HITL_SERVERS (stable/deterministic). Runners
// that fail to answer /status are skipped, but reported so a fully-down pool is
// an error rather than a silent hang.
package pool

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
)

// DefaultPort is the daemon API port assumed for bare hostnames in $HITL_SERVERS.
const DefaultPort = "8087"

// Normalize splits a $HITL_SERVERS value (comma- and/or whitespace-separated)
// into canonical base URLs. Entries may be a bare host ("hitl-rig"), host:port,
// or a full URL; bare hosts get http:// and :8087. Order and duplicates from the
// input are preserved except exact-duplicate URLs, which are dropped.
func Normalize(list string) []string {
	fields := strings.FieldsFunc(list, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
	var out []string
	seen := map[string]bool{}
	for _, f := range fields {
		u := normalizeOne(f)
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}

func normalizeOne(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	if u.Port() == "" {
		u.Host = u.Hostname() + ":" + DefaultPort
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	return u.String()
}

// Probe is one runner's queried state (or the error that querying it produced).
type Probe struct {
	URL    string
	Status *api.Status
	Err    error
}

// idle reports whether this runner can take a reservation right now. A multi-DUT
// rig reports Active==nil whenever any DUT is free, so this holds for both the
// legacy single-DUT summary and the newer per-DUT breakdown.
func (p Probe) idle() bool {
	return p.Err == nil && p.Status != nil && p.Status.Active == nil
}

// freeSlots is how many DUTs are immediately available (0 if busy/unreachable).
// Used to prefer a rig with more spare capacity when several are idle. A legacy
// daemon sends no Devices, so fall back to 1 when idle, 0 otherwise — preserving
// the old idle-first ordering.
func (p Probe) freeSlots() int {
	if p.Err != nil || p.Status == nil {
		return 0
	}
	if len(p.Status.Devices) == 0 {
		if p.Status.Active == nil {
			return 1
		}
		return 0
	}
	free := 0
	for _, d := range p.Status.Devices {
		if d.Active == nil {
			free++
		}
	}
	return free
}

// queue reports the number of waiters (active excluded); MaxInt for unreachable
// runners so they sort last.
func (p Probe) queue() int {
	if p.Err != nil || p.Status == nil {
		return int(^uint(0) >> 1)
	}
	q := p.Status.QueueLength
	if p.Status.Active != nil {
		q++ // an active holder is one more thing ahead of a new reservation
	}
	return q
}

// StatusFn fetches one runner's /status. Injected so Pick is unit-testable
// without a live daemon.
type StatusFn func(base string) (*api.Status, error)

// Probes queries every runner in the pool (preserving order).
func Probes(servers []string, get StatusFn) []Probe {
	out := make([]Probe, 0, len(servers))
	for _, s := range servers {
		st, err := get(s)
		out = append(out, Probe{URL: s, Status: st, Err: err})
	}
	return out
}

// Require is an optional capability filter for Pick: only rigs whose /status
// advertises the required capability are considered.
type Require struct {
	Analyzer bool     // require a shared logic analyzer (rig-level, Status.Analyzer.Present)
	Caps     []string // require a FREE DUT whose Capabilities ⊇ Caps (per-DUT)
}

// hasAnalyzer reports whether a reachable probe advertises a logic analyzer.
func hasAnalyzer(p Probe) bool {
	return p.Err == nil && p.Status != nil && p.Status.Analyzer != nil && p.Status.Analyzer.Present
}

// hasFreeDUTWithCaps reports whether the rig has a currently-free DUT whose
// advertised capabilities are a superset of caps — so a capability-targeted
// reservation can actually land there right now.
func hasFreeDUTWithCaps(p Probe, caps []string) bool {
	if p.Err != nil || p.Status == nil {
		return false
	}
	for _, d := range p.Status.Devices {
		if d.Active != nil {
			continue // busy
		}
		if capsSubset(caps, d.Capabilities) {
			return true
		}
	}
	return false
}

// capsSubset reports whether every cap in need is present in have.
func capsSubset(need, have []string) bool {
	set := make(map[string]bool, len(have))
	for _, c := range have {
		set[c] = true
	}
	for _, c := range need {
		if !set[c] {
			return false
		}
	}
	return true
}

// Pick chooses the best runner from already-collected probes. It returns the
// chosen base URL, or an error if every runner was unreachable. An optional
// Require narrows the pool to capability-matching rigs first, so a test that
// needs to capture the wire gets an analyzer rig, not whichever frees first.
func Pick(probes []Probe, req ...Require) (string, error) {
	if len(probes) == 0 {
		return "", fmt.Errorf("no runners in pool")
	}
	var r Require
	if len(req) > 0 {
		r = req[0]
	}
	if r.Analyzer {
		var capable []Probe
		for _, p := range probes {
			if hasAnalyzer(p) {
				capable = append(capable, p)
			}
		}
		if len(capable) == 0 {
			return "", fmt.Errorf("no logic-analyzer rig in pool of %d: %s", len(probes), summarizeErrs(probes))
		}
		probes = capable
	}
	if len(r.Caps) > 0 {
		var capable []Probe
		for _, p := range probes {
			if hasFreeDUTWithCaps(p, r.Caps) {
				capable = append(capable, p)
			}
		}
		if len(capable) == 0 {
			return "", fmt.Errorf("no rig with a free DUT having caps %v in pool of %d: %s", r.Caps, len(probes), summarizeErrs(probes))
		}
		probes = capable
	}
	// Stable sort keeps input order as the tie-break; keys: reachable first,
	// then idle first, then shortest queue.
	ordered := make([]Probe, len(probes))
	copy(ordered, probes)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if (a.Err == nil) != (b.Err == nil) {
			return a.Err == nil // reachable before unreachable
		}
		if a.idle() != b.idle() {
			return a.idle() // idle before busy
		}
		// Among idle rigs, prefer the one with more free DUTs (spreads load and
		// keeps more capacity open on any single rig).
		if fa, fb := a.freeSlots(), b.freeSlots(); fa != fb {
			return fa > fb
		}
		return a.queue() < b.queue()
	})
	best := ordered[0]
	if best.Err != nil || best.Status == nil {
		return "", fmt.Errorf("no reachable runner in pool of %d: %v", len(probes), summarizeErrs(probes))
	}
	return best.URL, nil
}

func summarizeErrs(probes []Probe) string {
	var parts []string
	for _, p := range probes {
		if p.Err != nil {
			parts = append(parts, fmt.Sprintf("%s: %v", p.URL, p.Err))
		}
	}
	return strings.Join(parts, "; ")
}
