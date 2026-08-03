// Package tailnet discovers HITL runners on the tailnet by their Tailscale ACL
// tag (default tag:splanc-hitl), so `hitl` finds every rig automatically instead
// of relying on a hand-maintained $HITL_SERVERS list. It shells out to the local
// `tailscale status --json` (the CLI already runs in a claude-container joined to
// the tailnet) and returns the MagicDNS hostnames of the tagged, online nodes;
// internal/pool then probes those and picks the shortest queue.
package tailnet

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// DefaultTag is the ACL tag every splanc HITL rig carries.
const DefaultTag = "tag:splanc-hitl"

// node is the subset of a `tailscale status --json` entry we use. Both Self and
// each Peer share this shape.
type node struct {
	HostName string   `json:"HostName"`
	DNSName  string   `json:"DNSName"`
	Tags     []string `json:"Tags"`
	Online   bool     `json:"Online"`
}

// status is the top-level shape of `tailscale status --json`.
type status struct {
	Self *node            `json:"Self"`
	Peer map[string]*node `json:"Peer"`
}

// host is the name we hand to the pool for a node: its MagicDNS short hostname
// (which resolves in-container, matching the tool's existing `hitl-rig` default),
// falling back to the fully-qualified DNSName when HostName is empty.
func (n *node) host() string {
	if n.HostName != "" {
		return n.HostName
	}
	return strings.TrimSuffix(n.DNSName, ".")
}

func (n *node) hasTag(tag string) bool {
	for _, t := range n.Tags {
		if t == tag {
			return true
		}
	}
	return false
}

// HostsForTag parses `tailscale status --json` output and returns the hostnames
// of every online node (peers and self) carrying tag, sorted for a deterministic
// order. Offline tagged nodes are skipped so the pool doesn't stall probing a rig
// that's powered down; Self is always considered reachable.
func HostsForTag(statusJSON []byte, tag string) ([]string, error) {
	var st status
	if err := json.Unmarshal(statusJSON, &st); err != nil {
		return nil, fmt.Errorf("parse tailscale status: %w", err)
	}
	var hosts []string
	consider := func(n *node, self bool) {
		if n == nil || !n.hasTag(tag) {
			return
		}
		if !self && !n.Online {
			return
		}
		if h := n.host(); h != "" {
			hosts = append(hosts, h)
		}
	}
	consider(st.Self, true)
	for _, p := range st.Peer {
		consider(p, false)
	}
	sort.Strings(hosts)
	return hosts, nil
}

// Discover runs `tailscale status --json` locally and returns the hostnames of
// online nodes tagged tag. A missing/erroring tailscale CLI is surfaced so the
// caller can fall back to its static default rather than hang.
func Discover(tag string) ([]string, error) {
	// Bound it: a wedged tailscaled shouldn't hang server resolution.
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("run tailscale status: %w", err)
	}
	return HostsForTag(out, tag)
}
