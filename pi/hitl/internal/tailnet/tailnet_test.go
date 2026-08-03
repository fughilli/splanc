package tailnet

import (
	"reflect"
	"testing"
)

// sampleStatus mirrors the fields of real `tailscale status --json`: a Self node,
// several tagged/untagged peers, and one offline tagged peer.
const sampleStatus = `{
  "Self":  {"HostName": "agent-box", "DNSName": "agent-box.tail6b8ad3.ts.net.", "Tags": ["tag:agent"], "Online": true},
  "Peer": {
    "nA": {"HostName": "hitl-rig",   "DNSName": "hitl-rig.tail6b8ad3.ts.net.",   "Tags": ["tag:splanc-hitl"], "Online": true},
    "nB": {"HostName": "hitl-rig-2", "DNSName": "hitl-rig-2.tail6b8ad3.ts.net.", "Tags": ["tag:splanc-hitl"], "Online": true},
    "nC": {"HostName": "gamebox",    "DNSName": "gamebox.tail6b8ad3.ts.net.",    "Tags": ["tag:nlk-party"],   "Online": true},
    "nD": {"HostName": "hitl-rig-3", "DNSName": "hitl-rig-3.tail6b8ad3.ts.net.", "Tags": ["tag:splanc-hitl"], "Online": false}
  }
}`

func TestHostsForTag(t *testing.T) {
	got, err := HostsForTag([]byte(sampleStatus), "tag:splanc-hitl")
	if err != nil {
		t.Fatalf("HostsForTag: %v", err)
	}
	// Sorted; only online tagged peers; untagged and offline excluded.
	want := []string{"hitl-rig", "hitl-rig-2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("HostsForTag = %v, want %v", got, want)
	}
}

func TestHostsForTagIncludesTaggedSelf(t *testing.T) {
	got, err := HostsForTag([]byte(sampleStatus), "tag:agent")
	if err != nil {
		t.Fatalf("HostsForTag: %v", err)
	}
	if want := []string{"agent-box"}; !reflect.DeepEqual(got, want) {
		t.Errorf("HostsForTag(self tag) = %v, want %v", got, want)
	}
}

func TestHostsForTagFallsBackToDNSName(t *testing.T) {
	// A node with no HostName should use its (dot-trimmed) DNSName.
	js := `{"Peer": {"n": {"DNSName": "bare.tail6b8ad3.ts.net.", "Tags": ["tag:splanc-hitl"], "Online": true}}}`
	got, err := HostsForTag([]byte(js), "tag:splanc-hitl")
	if err != nil {
		t.Fatalf("HostsForTag: %v", err)
	}
	if want := []string{"bare.tail6b8ad3.ts.net"}; !reflect.DeepEqual(got, want) {
		t.Errorf("HostsForTag = %v, want %v", got, want)
	}
}

func TestHostsForTagNoMatch(t *testing.T) {
	got, err := HostsForTag([]byte(sampleStatus), "tag:nonexistent")
	if err != nil {
		t.Fatalf("HostsForTag: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("HostsForTag(no match) = %v, want empty", got)
	}
}

func TestHostsForTagBadJSON(t *testing.T) {
	if _, err := HostsForTag([]byte("not json"), "tag:splanc-hitl"); err == nil {
		t.Error("HostsForTag(bad json) = nil error, want error")
	}
}
