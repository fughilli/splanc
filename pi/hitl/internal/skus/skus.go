// Package skus resolves a DUT's baked-in capabilities from its SKU. The registry
// is embedded from skus.json, which is generated from //pi/hitl:skus.bzl (the
// source of truth) and kept in sync by //pi/hitl/internal/skus:skus_json_sync_test.
// A test declares the capabilities it needs; a DUT matches when its Capabilities
// (from its SKU) are a superset.
package skus

import (
	_ "embed"
	"encoding/json"
	"sort"
)

//go:embed skus.json
var registryJSON []byte

var registry = mustLoad()

func mustLoad() map[string][]string {
	m := map[string][]string{}
	if err := json.Unmarshal(registryJSON, &m); err != nil {
		panic("skus: invalid embedded skus.json: " + err.Error())
	}
	return m
}

// Capabilities returns the (sorted) capabilities baked into the SKU, or nil if the
// SKU is unknown. An unknown SKU isn't fatal — the DUT simply advertises no
// capabilities and so matches no capability requirement; the daemon logs a warning.
func Capabilities(sku string) []string {
	caps, ok := registry[sku]
	if !ok {
		return nil
	}
	out := append([]string(nil), caps...)
	sort.Strings(out)
	return out
}

// Known reports whether the SKU is present in the registry.
func Known(sku string) bool {
	_, ok := registry[sku]
	return ok
}
