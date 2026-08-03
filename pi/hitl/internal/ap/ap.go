// Package ap toggles the rig's self-hosted provisioning access point around a
// reservation. The AP is a NetworkManager connection (declared in the rig's NixOS
// config with autoconnect=false) on a virtual interface that shares the onboard
// radio with the STA uplink; the daemon brings it up while a reservation holds the
// rig and down on release, so the rig boots STA-only and the AP exists only for a
// live test.
//
// The AP virtual interface is created HERE, on demand, right before the AP is
// raised — not by a boot-time service. On the Pi's brcmfmac, a __ap vif created
// before the STA associates gets reaped by the driver when the STA comes up; by
// creating it at raise time (STA already associated, channel settled) the vif is
// accepted co-channel and sticks. It's idempotent, so a vanished vif self-heals.
package ap

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// NMController brings a NetworkManager connection up/down via nmcli, ensuring the
// AP virtual interface exists first.
type NMController struct {
	Nmcli string // nmcli binary (path or name)
	Conn  string // NM connection id, e.g. "hitl-ap"
	Iface string // AP virtual interface, e.g. "ap0" (empty: don't manage a vif)
	Sta   string // STA interface whose radio hosts the AP vif, e.g. "wlan0"
	Iw    string // iw binary (creates the vif)
	Ip    string // ip binary (sets the vif MAC)
}

// New builds a controller. iface/sta/iw/ip may be empty to skip vif management
// (e.g. when a boot service or external setup already provides the interface).
func New(nmcli, conn, iface, sta, iw, ip string) *NMController {
	if nmcli == "" {
		nmcli = "nmcli"
	}
	if iw == "" {
		iw = "iw"
	}
	if ip == "" {
		ip = "ip"
	}
	return &NMController{Nmcli: nmcli, Conn: conn, Iface: iface, Sta: sta, Iw: iw, Ip: ip}
}

// Up ensures the AP vif exists, then activates the AP connection. NetworkManager
// needs a moment to register a freshly-created device, so the activation is
// retried briefly. Idempotent.
func (c *NMController) Up(ctx context.Context) error {
	if err := c.ensureVif(ctx); err != nil {
		return err
	}
	// Retry: nmcli can race NM noticing the just-added device ("No suitable
	// device found") for a second or two after the vif appears.
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = c.run(ctx, "up"); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1500 * time.Millisecond):
		}
	}
	return err
}

// Down deactivates the AP connection. nmcli returns non-zero if it's already
// down ("not an active connection"); that's benign, so it's folded into success.
// The vif is left in place — Up recreates it if the driver reaps it.
func (c *NMController) Down(ctx context.Context) error {
	err := c.run(ctx, "down")
	if err != nil && strings.Contains(err.Error(), "not an active connection") {
		return nil
	}
	return err
}

// ensureVif creates the AP virtual interface on the STA's PHY if it's missing,
// with a distinct locally-administered MAC (brcmfmac rejects a vif that shares the
// STA's address). No-op when vif management is disabled or the interface exists.
func (c *NMController) ensureVif(ctx context.Context) error {
	if c.Iface == "" {
		return nil
	}
	if exec.CommandContext(ctx, c.Iw, "dev", c.Iface, "info").Run() == nil {
		return nil // already exists
	}
	if c.Sta == "" {
		return fmt.Errorf("ap vif %q missing and no STA interface configured to derive its PHY", c.Iface)
	}
	phyLink, err := os.Readlink("/sys/class/net/" + c.Sta + "/phy80211")
	if err != nil {
		return fmt.Errorf("resolve PHY for %s: %w", c.Sta, err)
	}
	phy := filepath.Base(phyLink) // e.g. "phy1"
	if out, err := exec.CommandContext(ctx, c.Iw, "phy", phy, "interface", "add", c.Iface, "type", "__ap").CombinedOutput(); err != nil {
		return fmt.Errorf("create %s on %s: %w: %s", c.Iface, phy, err, strings.TrimSpace(string(out)))
	}
	// Derive a locally-administered MAC from the STA's (force the 02: prefix).
	if raw, err := os.ReadFile("/sys/class/net/" + c.Sta + "/address"); err == nil {
		if m := strings.TrimSpace(string(raw)); strings.Contains(m, ":") {
			apMAC := "02" + m[strings.Index(m, ":"):]
			_ = exec.CommandContext(ctx, c.Ip, "link", "set", "dev", c.Iface, "address", apMAC).Run()
		}
	}
	return nil
}

func (c *NMController) run(ctx context.Context, verb string) error {
	// Bound it: a wedged NetworkManager shouldn't hang the reservation state
	// machine (this runs under the manager lock).
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, c.Nmcli, "connection", verb, c.Conn).CombinedOutput()
	if err != nil {
		return fmt.Errorf("nmcli connection %s %s: %w: %s", verb, c.Conn, err, strings.TrimSpace(string(out)))
	}
	return nil
}
