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
	"math"
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
// Require is a rig-selection filter: keep only rigs that can serve a reservation
// needing this hardware SKU and/or these per-DUT capabilities. The logic analyzer
// is just another capability ("logic-analyzer"), advertised per-DUT by the daemon —
// there is no separate rig-level analyzer knob.
type Require struct {
	SKU  string   // require a FREE DUT of this hardware SKU ("" = any)
	Caps []string // require a FREE DUT whose Capabilities ⊇ Caps
}

// dutServes reports whether a free DeviceStatus can host a reservation for the given
// SKU and caps under the pin rules the pool can see. An explicit SKU target may land
// on a pin-only network DUT; a caps-only/unconstrained request never does — matching
// the daemon's own placement, so the pool doesn't route work to a rig whose only fit
// is a DUT the daemon will refuse.
func dutServes(d api.DeviceStatus, sku string, caps []string) bool {
	if d.Active != nil {
		return false // busy
	}
	if sku != "" && d.SKU != sku {
		return false
	}
	if !capsSubset(caps, d.Capabilities) {
		return false
	}
	if sku == "" && d.Kind == "network" {
		return false // a caps-only/unconstrained request never targets a pin-only DUT
	}
	return true
}

// hasFreeServingDUT reports whether the rig has a currently-free DUT that can serve
// the reservation right now (SKU + caps + pin rules).
func hasFreeServingDUT(p Probe, sku string, caps []string) bool {
	if p.Err != nil || p.Status == nil {
		return false
	}
	for _, d := range p.Status.Devices {
		if dutServes(d, sku, caps) {
			return true
		}
	}
	return false
}

// fitScore is the fewest capabilities beyond `caps` among a rig's FREE DUTs that can
// serve the reservation — the tightest DUT the rig can offer right now. A rig with
// no free serving DUT scores math.MaxInt (ranked last on fit), so a rig that can
// serve now always beats one that can't. Lower is a better fit.
func fitScore(p Probe, sku string, caps []string) int {
	best := math.MaxInt
	if p.Err != nil || p.Status == nil {
		return best
	}
	for _, d := range p.Status.Devices {
		if !dutServes(d, sku, caps) {
			continue
		}
		if e := extraCaps(d.Capabilities, caps); e < best {
			best = e
		}
	}
	return best
}

// describeReq renders a Require for an error message ("sku led-mapper-pi",
// "caps [improv mic]", or both).
func describeReq(r Require) string {
	switch {
	case r.SKU != "" && len(r.Caps) > 0:
		return fmt.Sprintf("sku %s + caps %v", r.SKU, r.Caps)
	case r.SKU != "":
		return fmt.Sprintf("sku %s", r.SKU)
	default:
		return fmt.Sprintf("caps %v", r.Caps)
	}
}

// extraCaps counts the capabilities a DUT has beyond those required. Robust to
// duplicates in need.
func extraCaps(have, need []string) int {
	req := make(map[string]bool, len(need))
	for _, c := range need {
		req[c] = true
	}
	n := 0
	for _, c := range have {
		if !req[c] {
			n++
		}
	}
	return n
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
// Require narrows the pool to rigs with a free capability-matching DUT first, then
// best-fit ranking keeps scarce, over-provisioned rigs (e.g. one with a logic
// analyzer) free for the work that needs them.
func Pick(probes []Probe, req ...Require) (string, error) {
	if len(probes) == 0 {
		return "", fmt.Errorf("no runners in pool")
	}
	var r Require
	if len(req) > 0 {
		r = req[0]
	}
	if r.SKU != "" || len(r.Caps) > 0 {
		var capable []Probe
		for _, p := range probes {
			if hasFreeServingDUT(p, r.SKU, r.Caps) {
				capable = append(capable, p)
			}
		}
		if len(capable) == 0 {
			return "", fmt.Errorf("no rig with a free DUT matching %s in pool of %d: %s", describeReq(r), len(probes), summarizeErrs(probes))
		}
		probes = capable
	}
	// Best-fit is the primary selection criterion: prefer the rig whose tightest
	// free DUT has the fewest capabilities beyond what's required, so scarce,
	// over-provisioned rigs (e.g. one with a logic-analyzer DUT) aren't consumed by
	// work that doesn't need them. Precompute the fit once per rig (the comparator
	// runs O(n log n) times); ties fall through to the load heuristics.
	fit := make(map[string]int, len(probes))
	for _, p := range probes {
		fit[p.URL] = fitScore(p, r.SKU, r.Caps)
	}
	// Stable sort keeps input order as the final tie-break; keys: reachable first,
	// then tightest fit, then idle, then more free DUTs, then shortest queue.
	ordered := make([]Probe, len(probes))
	copy(ordered, probes)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if (a.Err == nil) != (b.Err == nil) {
			return a.Err == nil // reachable before unreachable
		}
		if fa, fb := fit[a.URL], fit[b.URL]; fa != fb {
			return fa < fb // tightest-fitting free DUT first
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
