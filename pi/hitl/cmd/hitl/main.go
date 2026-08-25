// Command hitl is the agent-facing CLI for the HITL rig. Run inside a
// claude-container session; it reaches the rig's hitl-managerd over the tailnet.
//
//	hitl reserve            # queue, then drop into an SSH shell on the rig
//	hitl status             # show the queue / active holder
//	hitl release <id>       # release a reservation
//	hitl ssh <id>           # SSH into an already-active reservation
//
// The rig URL comes from --server or $HITL_SERVER (e.g. http://hitl-rig-1:8087).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
	"github.com/fughilli/splanc/pi/hitl/internal/pool"
	"github.com/fughilli/splanc/pi/hitl/internal/tailnet"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "reserve":
		err = cmdReserve(args)
	case "status":
		err = cmdStatus(args)
	case "wifi":
		err = cmdWifi(args)
	case "release":
		err = cmdRelease(args)
	case "ssh":
		err = cmdSSH(args)
	case "flash":
		err = cmdFlash(args)
	case "monitor":
		err = cmdMonitor(args)
	case "ble":
		err = cmdBle(args)
	case "jtag":
		err = cmdJtag(args)
	case "gdb":
		err = cmdGdb(args)
	case "pool":
		err = cmdPool(args)
	case "run":
		err = cmdRun(args)
	case "cp":
		err = cmdCp(args)
	case "forward":
		err = cmdForward(args)
	case "btmon":
		err = cmdBtmon(args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `hitl — reserve and use the HITL rig

  hitl reserve [--owner ID] [--server URL] [--key PUBKEY] [--device NAME] [--keep]
  hitl status  [--server URL]                                  # per-DUT queue / active holders
  hitl wifi    [--server URL]                                  # the rig's provisioning-AP ssid/psk
  hitl release <id> [--server URL]
  hitl ssh     <id> [--server URL]
  hitl flash   [--port DEV] [--id RES] [--keep] [--monitor] [--server URL] <bundle.tar>
  hitl monitor [--port DEV] [--id RES] [--keep] [--reset] [--seconds N] [--server URL]
  hitl ble     scan [--name S] [--seconds N] | gatt <address>   [--id RES] [--keep]
  hitl jtag    [--id RES] [--keep] [-- openocd args]            # C6 built-in USB-JTAG
  hitl gdb     [--elf FILE] [--id RES] [--keep] [-- gdb args]   # attach gdb via openocd
  hitl run     [--id RES] [--keep] [--tty] [--server URL] -- <command...>  # run in the reservation
  hitl cp      [--id RES] [--keep] [--server URL] <local...> <remote-dir>  # copy files in
  hitl forward [--id RES] [--keep] [--local-port N] [--server URL] <host> <port>  # ssh -L via the rig
  hitl btmon   start|stop|status --id RES                       # per-reservation BLE HCI (btmon) capture
  hitl btmon   fetch  --id RES [--mac AA:..] <out.btsnoop>      # pull the trace out of the reservation
  hitl btmon   capture [--id RES] [--keep] [--mac AA:..] [--out F] -- <cmd>  # start→run→stop→fetch
  hitl pool    [--server-list LIST] [--tag TAG]                # status of every runner in the pool

Server URL: --server, else $HITL_SERVER, else the shortest-queue runner in the
pool. The pool is an explicit $HITL_SERVERS list (comma/space hosts) if set,
otherwise the tailnet nodes tagged $HITL_TAG (default tag:splanc-hitl). Errors
with a hint if nothing is discoverable (discovery needs the tailscale CLI on
PATH, so use 'bazel run', not the sandboxed 'bazel test').
Flash bundle: build one with e.g.
  bazel build //firmware/player_app:esp32c6_flashbundle
`)
}

// --- reserve --------------------------------------------------------------

func cmdReserve(args []string) error {
	fs := newFlags("reserve")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id (for logs/status)")
	keyPath := fs.String("key", "", "public key to authorize (default: a dedicated ~/.config/hitl key)")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation after the SSH session exits (default: release)")
	noShell := fs.Bool("no-shell", false, "just wait until active and print the endpoint; don't open a shell")
	require := requireFlag(fs)
	_ = fs.Parse(args)
	req, err := parseRequire(*require)
	if err != nil {
		return err
	}
	if err := resolve(server, req); err != nil {
		return err
	}

	pub, priv, err := resolveKeypair(*keyPath)
	if err != nil {
		return err
	}
	pubBytes, err := os.ReadFile(pub)
	if err != nil {
		return fmt.Errorf("read pubkey: %w", err)
	}

	c := client{base: *server}
	var res api.Reservation
	if err := c.post("/reserve", api.ReserveRequest{Owner: *owner, SSHPublicKey: string(pubBytes), Device: *device}, &res); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "reserved: id=%s\n", res.ID)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Wait for it to reach the head of the queue.
	active, err := c.waitActive(ctx, res.ID)
	if err != nil {
		return err
	}
	ep := active.SSH
	// The container's sshd is published on the same host as the daemon, so reach
	// it the same way we reached the API (mDNS name, tailnet name, IP — whatever
	// the caller used) rather than trusting the daemon's advertised hostname.
	if h := hostFromServer(*server); h != "" {
		ep.Host = h
	}
	fmt.Fprintf(os.Stderr, "active: dut=%s ssh %s@%s -p %d\n", active.Device, ep.User, ep.Host, ep.Port)

	// The daemon marks active once the container starts; its sshd takes a moment
	// to bind. Wait for the port before connecting so we don't race it.
	if err := waitPort(ctx, ep.Host, ep.Port, 45*time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
	}

	if !*keep {
		defer func() {
			_ = c.postRaw(fmt.Sprintf("/reservation/%s/release", res.ID), nil)
			fmt.Fprintln(os.Stderr, "released")
		}()
	}

	// Heartbeat in the background so the lease doesn't expire mid-session.
	hbCtx, hbStop := context.WithCancel(ctx)
	defer hbStop()
	go c.heartbeatLoop(hbCtx, res.ID)

	if *noShell {
		// Machine-readable so a script (e.g. the e2e harness) can hold the
		// reservation via this process and drive it with further `hitl` commands
		// keyed on --id/--server. Printed once active; the process then blocks,
		// heartbeating, until signalled — at which point it releases (unless --keep).
		fmt.Printf("id=%s\n", res.ID)
		fmt.Printf("server=%s\n", *server)
		fmt.Printf("endpoint=%s@%s:%d\n", ep.User, ep.Host, ep.Port)
		<-ctx.Done()
		return nil
	}
	return openSSH(ctx, priv, ep)
}

// --- status / release / ssh ----------------------------------------------

func cmdStatus(args []string) error {
	fs := newFlags("status")
	server := serverFlag(fs)
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}
	var s api.Status
	if err := (client{base: *server}).get("/status", &s); err != nil {
		return err
	}
	fmt.Printf("rig: %s   lease: %ds\n", s.Rig, s.LeaseSeconds)
	// Multi-DUT rig: one line per DUT. Older single-DUT daemons send no Devices,
	// so fall back to the legacy active/queue summary.
	if len(s.Devices) > 0 {
		for _, d := range s.Devices {
			kind := ""
			if d.Kind != "" {
				kind = " [" + d.Kind + "]"
			}
			if d.Active != nil {
				fmt.Printf("dut %-8s%s busy: id=%s owner=%q since=%s\n", d.Name, kind, d.Active.ID, d.Active.Owner, fmtTime(d.Active.StartedAt))
			} else {
				fmt.Printf("dut %-8s%s (idle)\n", d.Name, kind)
			}
		}
	} else if s.Active != nil {
		fmt.Printf("active: id=%s owner=%q since=%s\n", s.Active.ID, s.Active.Owner, fmtTime(s.Active.StartedAt))
	} else {
		fmt.Println("active: (idle)")
	}
	fmt.Printf("queued: %d waiting\n", s.QueueLength)
	if s.WiFi != nil {
		fmt.Printf("wifi: ssid=%q (provisioning AP)\n", s.WiFi.SSID)
	}
	return nil
}

// cmdWifi prints the rig's provisioning-AP credentials from /status, machine-
// readable (ssid=/psk= lines) so the e2e harness can provision the DUT onto the
// rig's own AP with no external creds. Errors if the rig runs no AP.
func cmdWifi(args []string) error {
	fs := newFlags("wifi")
	server := serverFlag(fs)
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}
	var s api.Status
	if err := (client{base: *server}).get("/status", &s); err != nil {
		return err
	}
	if s.WiFi == nil {
		return fmt.Errorf("rig %q has no provisioning AP configured", s.Rig)
	}
	fmt.Printf("ssid=%s\n", s.WiFi.SSID)
	fmt.Printf("psk=%s\n", s.WiFi.PSK)
	return nil
}

func cmdRelease(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: hitl release <id>")
	}
	id := args[0]
	fs := newFlags("release")
	server := serverFlag(fs)
	_ = fs.Parse(args[1:])
	if err := resolve(server); err != nil {
		return err
	}
	return (client{base: *server}).postRaw(fmt.Sprintf("/reservation/%s/release", id), nil)
}

func cmdSSH(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: hitl ssh <id>")
	}
	id := args[0]
	fs := newFlags("ssh")
	server := serverFlag(fs)
	keyPath := fs.String("key", "", "public key file (default: the dedicated ~/.config/hitl key)")
	_ = fs.Parse(args[1:])
	if err := resolve(server); err != nil {
		return err
	}
	_, priv, err := resolveKeypair(*keyPath)
	if err != nil {
		return err
	}
	var res api.Reservation
	if err := (client{base: *server}).get("/reservation/"+id, &res); err != nil {
		return err
	}
	if res.State != api.StateActive || res.SSH == nil {
		return fmt.Errorf("reservation %s is %s (not active)", id, res.State)
	}
	if h := hostFromServer(*server); h != "" {
		res.SSH.Host = h
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return openSSH(ctx, priv, res.SSH)
}

// --- flash ----------------------------------------------------------------

func cmdFlash(args []string) error {
	fs := newFlags("flash")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	port := fs.String("port", "/dev/ttyACM0", "serial device in the container")
	id := fs.String("id", "", "flash into this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation after flashing (default: release when we made it)")
	monitor := fs.Bool("monitor", false, "read the serial console after flashing")
	monSecs := fs.Float64("monitor-seconds", 10, "how long to read serial with --monitor (0 = until Ctrl-C)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}

	bundle := fs.Arg(0)
	if bundle == "" {
		return fmt.Errorf("usage: hitl flash [flags] <bundle.tar>")
	}
	if _, err := os.Stat(bundle); err != nil {
		return fmt.Errorf("bundle: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()

	// Ship the bundle and run the container's baked hitl-flash consumer.
	remoteBundle := "/tmp/" + filepath.Base(bundle)
	fmt.Fprintf(os.Stderr, "copying %s -> %s:%s\n", filepath.Base(bundle), ep.Host, remoteBundle)
	if err := scpTo(ctx, priv, ep, []string{bundle}, "/tmp/"); err != nil {
		return fmt.Errorf("scp: %w", err)
	}
	remoteCmd := fmt.Sprintf("hitl-flash %s --port %s", remoteBundle, *port)
	if *monitor {
		remoteCmd += fmt.Sprintf(" --monitor --monitor-seconds %g", *monSecs)
	}
	fmt.Fprintf(os.Stderr, "flashing %s on %s...\n", *port, ep.Host)
	return sshRun(ctx, priv, ep, remoteCmd)
}

// --- monitor --------------------------------------------------------------

func cmdMonitor(args []string) error {
	fs := newFlags("monitor")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	port := fs.String("port", "/dev/ttyACM0", "serial device in the container")
	id := fs.String("id", "", "monitor this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation after monitoring (default: release when we made it)")
	secs := fs.Float64("seconds", 0, "how long to read (0 = until Ctrl-C)")
	reset := fs.Bool("reset", false, "hard-reset the board first (to catch boot logs)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()

	cmd := fmt.Sprintf("hitl-monitor --port %s --seconds %g", *port, *secs)
	if *reset {
		cmd += " --reset"
	}
	return sshRun(ctx, priv, ep, cmd)
}

// --- ble ------------------------------------------------------------------

func cmdBle(args []string) error {
	// Subcommand comes first (hitl ble scan …); the rest are flags/positionals.
	sub := "scan"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	fs := newFlags("ble")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	seconds := fs.Float64("seconds", 6, "scan duration")
	name := fs.String("name", "", "scan: only show devices whose name contains this")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}

	var remote string
	switch sub {
	case "scan":
		remote = fmt.Sprintf("hitl-ble scan --seconds %g", *seconds)
		if *name != "" {
			remote += " --name '" + strings.ReplaceAll(*name, "'", "") + "'"
		}
	case "gatt":
		addr := fs.Arg(0)
		if addr == "" {
			return fmt.Errorf("usage: hitl ble gatt [flags] <address>")
		}
		remote = "hitl-ble gatt " + addr
	default:
		return fmt.Errorf("hitl ble: unknown subcommand %q (scan|gatt)", sub)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()
	return sshRun(ctx, priv, ep, remote)
}

// --- jtag -----------------------------------------------------------------

func cmdJtag(args []string) error {
	fs := newFlags("jtag")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}

	// Any remaining args pass through to openocd (e.g. -c "init; reset halt; ...").
	// No args → hitl-jtag's default (halt + read pc + reset-run).
	remote := "hitl-jtag"
	for _, a := range fs.Args() {
		remote += " " + shellQuote(a)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()
	return sshRun(ctx, priv, ep, remote)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// --- gdb ------------------------------------------------------------------

func cmdGdb(args []string) error {
	fs := newFlags("gdb")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	elf := fs.String("elf", "", "firmware ELF to load symbols from (copied into the container)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}

	if *elf != "" {
		if _, err := os.Stat(*elf); err != nil {
			return fmt.Errorf("elf: %w", err)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()

	remote := "hitl-gdb"
	if *elf != "" {
		if err := scpTo(ctx, priv, ep, []string{*elf}, "/tmp/"); err != nil {
			return fmt.Errorf("scp elf: %w", err)
		}
		remote += " /tmp/" + filepath.Base(*elf)
	}
	// Remaining args pass through to gdb (e.g. -batch -ex "bt"); none → interactive.
	for _, a := range fs.Args() {
		remote += " " + shellQuote(a)
	}
	return sshRunTTY(ctx, priv, ep, remote)
}

// --- run / cp -------------------------------------------------------------

// cmdRun executes an arbitrary command inside a reservation (reserving one if
// --id isn't given). It's the generic sibling of flash/monitor/ble — used by the
// test harness to drive a copied-in test driver against the DUT.
func cmdRun(args []string) error {
	fs := newFlags("run")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	tty := fs.Bool("tty", false, "allocate a pseudo-tty (for interactive commands)")
	require := requireFlag(fs)
	_ = fs.Parse(args)
	req, err := parseRequire(*require)
	if err != nil {
		return err
	}
	if err := resolve(server, req); err != nil {
		return err
	}
	remoteArgs := fs.Args()
	if len(remoteArgs) == 0 {
		return fmt.Errorf("usage: hitl run [flags] -- <command...>")
	}
	// Re-quote each arg so a multi-word arg stays one arg on the remote shell.
	parts := make([]string, len(remoteArgs))
	for i, a := range remoteArgs {
		parts[i] = shellQuote(a)
	}
	remote := strings.Join(parts, " ")

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()
	if *tty {
		return sshRunTTY(ctx, priv, ep, remote)
	}
	return sshRun(ctx, priv, ep, remote)
}

// cmdCp copies local files into a reservation's container (a remote directory).
func cmdCp(args []string) error {
	fs := newFlags("cp")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) < 2 {
		return fmt.Errorf("usage: hitl cp [flags] <local...> <remote-dir>")
	}
	locals, remoteDir := rest[:len(rest)-1], rest[len(rest)-1]
	for _, l := range locals {
		if _, err := os.Stat(l); err != nil {
			return fmt.Errorf("local file: %w", err)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()
	return scpTo(ctx, priv, ep, locals, remoteDir)
}

// --- forward --------------------------------------------------------------

// cmdForward opens an SSH local port-forward through a reservation: a port on
// this machine tunnels to <remote-host>:<remote-port>, whose far end is dialed
// FROM the rig's container — so the rig's LAN (e.g. the DUT's WiFi network)
// reaches the target, not this host. It prints the chosen local port on stdout,
// then blocks until interrupted (SIGINT/SIGTERM). Used by the e2e harness to
// reach a DUT that only the rig can see.
func cmdForward(args []string) error {
	fs := newFlags("forward")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "use this already-active reservation instead of making one")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	localPort := fs.Int("local-port", 0, "local port to bind (0 = pick a free one)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) != 2 {
		return fmt.Errorf("usage: hitl forward [flags] <remote-host> <remote-port>")
	}
	remoteHost := rest[0]
	remotePort, err := strconv.Atoi(rest[1])
	if err != nil {
		return fmt.Errorf("remote port %q: %w", rest[1], err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
	if err != nil {
		return err
	}
	defer release()

	lp := *localPort
	if lp == 0 {
		if lp, err = freeLocalPort(); err != nil {
			return fmt.Errorf("pick local port: %w", err)
		}
	}
	spec := fmt.Sprintf("%d:%s:%d", lp, remoteHost, remotePort)
	sshArgs := append(sshOpts(priv, "-p", ep.Port),
		"-o", "ExitOnForwardFailure=yes", "-N", "-L", spec,
		fmt.Sprintf("%s@%s", ep.User, ep.Host))
	tunnel := exec.CommandContext(ctx, "ssh", sshArgs...)
	tunnel.Stderr = os.Stderr
	if err := tunnel.Start(); err != nil {
		return fmt.Errorf("start ssh -L %s: %w", spec, err)
	}
	// Announce the port only once the local end accepts, so the caller can
	// connect the instant it reads the line.
	if err := waitPort(ctx, "127.0.0.1", lp, 20*time.Second); err != nil {
		_ = tunnel.Process.Kill()
		return fmt.Errorf("tunnel %s did not come up: %w", spec, err)
	}
	fmt.Printf("%d\n", lp)
	fmt.Fprintf(os.Stderr, "tunnel: localhost:%d -> (rig) -> %s:%d\n", lp, remoteHost, remotePort)
	if err := tunnel.Wait(); err != nil && ctx.Err() == nil {
		return err // a real ssh failure, not our own interrupt teardown
	}
	return nil
}

// freeLocalPort asks the OS for an unused loopback TCP port.
func freeLocalPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// --- btmon (BLE HCI capture) ----------------------------------------------

// cmdBtmon controls per-reservation BLE HCI (btmon) capture on the rig. The
// capture runs HOST-side (the unprivileged container can't open an HCI monitor
// socket) and its btsnoop is exposed read-only inside the reservation container;
// `fetch` pulls it out. Subcommands: start | stop | status | fetch | capture
// (the windowed start→run→stop→fetch convenience). See pi/hitl/README.md for the
// shared-adapter caveat.
func cmdBtmon(args []string) error {
	sub := "status"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	fs := newFlags("btmon")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id")
	keyPath := fs.String("key", "", "public key to authorize (default: dedicated ~/.config/hitl key)")
	id := fs.String("id", "", "reservation id (required for start/stop/status/fetch)")
	device := deviceFlag(fs)
	keep := fs.Bool("keep", false, "keep the reservation afterward (capture form; default: release when we made it)")
	mac := fs.String("mac", "", "DUT BLE MAC to annotate the trace by (the rig adapter is shared; see the note)")
	out := fs.String("out", "hci.btsnoop", "output btsnoop file (fetch/capture)")
	_ = fs.Parse(args)
	if err := resolve(server); err != nil {
		return err
	}
	c := client{base: *server}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch sub {
	case "start", "stop", "status":
		if *id == "" {
			return fmt.Errorf("hitl btmon %s needs --id RES (an active reservation)", sub)
		}
		var st api.CaptureStatus
		var err error
		switch sub {
		case "start":
			err = c.post(fmt.Sprintf("/reservation/%s/btmon/start", *id), nil, &st)
		case "stop":
			err = c.post(fmt.Sprintf("/reservation/%s/btmon/stop", *id), nil, &st)
		default: // status
			err = c.get(fmt.Sprintf("/reservation/%s/btmon", *id), &st)
		}
		if err != nil {
			return err
		}
		printCaptureStatus(&st)
		return nil

	case "fetch":
		if *id == "" {
			return fmt.Errorf("hitl btmon fetch needs --id RES")
		}
		outFile := *out
		if a := fs.Arg(0); a != "" {
			outFile = a
		}
		var st api.CaptureStatus
		if err := c.get(fmt.Sprintf("/reservation/%s/btmon", *id), &st); err != nil {
			return err
		}
		ep, priv, _, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, true)
		if err != nil {
			return err
		}
		defer release()
		if err := scpFrom(ctx, priv, ep, captureContainerPath(&st), outFile); err != nil {
			return fmt.Errorf("fetch trace: %w", err)
		}
		annotateCapture(outFile, *mac)
		if st.Running {
			fmt.Fprintln(os.Stderr, "note: capture is still running; fetched a snapshot (stop it with `hitl btmon stop --id …`)")
		}
		return nil

	case "capture":
		remoteArgs := fs.Args()
		if len(remoteArgs) == 0 {
			return fmt.Errorf("usage: hitl btmon capture [flags] -- <command...>")
		}
		parts := make([]string, len(remoteArgs))
		for i, a := range remoteArgs {
			parts[i] = shellQuote(a)
		}
		remote := strings.Join(parts, " ")

		ep, priv, resID, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *device, *keep)
		if err != nil {
			return err
		}
		defer release()

		var st api.CaptureStatus
		if err := c.post(fmt.Sprintf("/reservation/%s/btmon/start", resID), nil, &st); err != nil {
			return fmt.Errorf("start capture: %w", err)
		}
		fmt.Fprintln(os.Stderr, "btmon: capturing…")
		runErr := sshRun(ctx, priv, ep, remote)
		var stopped api.CaptureStatus
		if err := c.post(fmt.Sprintf("/reservation/%s/btmon/stop", resID), nil, &stopped); err != nil {
			fmt.Fprintf(os.Stderr, "warning: stop capture: %v\n", err)
		}
		// Fetch even if the command failed — the trace is the point of debugging it.
		if err := scpFrom(ctx, priv, ep, captureContainerPath(&st), *out); err != nil {
			return fmt.Errorf("fetch trace: %w (command error: %v)", err, runErr)
		}
		annotateCapture(*out, *mac)
		return runErr

	default:
		return fmt.Errorf("hitl btmon: unknown subcommand %q (start|stop|status|fetch|capture)", sub)
	}
}

// captureContainerPath is where the trace is readable inside the container,
// from the status if the daemon reported it, else the well-known default.
func captureContainerPath(st *api.CaptureStatus) string {
	if st.ContainerPath != "" {
		return st.ContainerPath
	}
	return "/run/hitl/capture/hci.btsnoop"
}

func printCaptureStatus(st *api.CaptureStatus) {
	state := "stopped"
	if st.Running {
		state = "running"
	}
	fmt.Printf("capture: %s  size=%s", state, humanBytes(st.SizeBytes))
	if st.StartedAt != nil {
		fmt.Printf("  since=%s", st.StartedAt.Format(time.Kitchen))
	}
	if st.Reason != "" {
		fmt.Printf("  (%s)", st.Reason)
	}
	fmt.Println()
	if st.ContainerPath != "" {
		fmt.Printf("in-container: %s  (read with `btmon -r`, or `hitl btmon fetch --id …`)\n", st.ContainerPath)
	}
}

// annotateCapture prints the shared-adapter caveat and, given the DUT's BLE MAC,
// the exact Wireshark filter to isolate it — the trace is annotated, not
// isolated (the rig has one controller shared by all DUTs).
func annotateCapture(outFile, mac string) {
	fmt.Fprintf(os.Stderr, "saved %s — opens in `btmon -r %s` and Wireshark.\n", outFile, outFile)
	fmt.Fprintln(os.Stderr, "NOTE: the rig has ONE Bluetooth controller shared by every DUT, so this trace")
	fmt.Fprintln(os.Stderr, "      contains other reservations' BLE traffic during the capture window —")
	fmt.Fprintln(os.Stderr, "      it is annotated by your DUT's BLE MAC, not isolated to it.")
	if mac != "" {
		fmt.Fprintf(os.Stderr, "      isolate your DUT in Wireshark with:  bluetooth.addr == %s\n", strings.ToLower(mac))
	} else {
		fmt.Fprintln(os.Stderr, "      pass --mac <DUT BLE MAC> to print the display filter for your DUT.")
	}
}

// humanBytes renders a byte count as a compact human-readable size.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(n)/float64(div), "KMGT"[exp])
}

// --- pool -----------------------------------------------------------------

// cmdPool prints the status of every runner (discovered from the tailnet tag, or
// an explicit --server-list/$HITL_SERVERS) and which one a bare `hitl reserve`
// would pick. Read-only; makes no reservation.
func cmdPool(args []string) error {
	fs := newFlags("pool")
	list := fs.String("server-list", "", "comma/space list of runner hosts (overrides discovery; default $HITL_SERVERS)")
	tag := fs.String("tag", envOr("HITL_TAG", tailnet.DefaultTag), "tailnet tag to discover runners by")
	_ = fs.Parse(args)
	var servers []string
	var source string
	switch {
	case strings.TrimSpace(*list) != "":
		servers, source = pool.Normalize(*list), "--server-list"
	case strings.TrimSpace(os.Getenv("HITL_SERVERS")) != "":
		servers, source = pool.Normalize(os.Getenv("HITL_SERVERS")), "$HITL_SERVERS"
	default:
		hosts, err := tailnet.Discover(*tag)
		if err != nil {
			return fmt.Errorf("discover tailnet tag %q: %w", *tag, err)
		}
		servers, source = pool.Normalize(strings.Join(hosts, " ")), "tailnet tag "+*tag
	}
	if len(servers) == 0 {
		return fmt.Errorf("no runners found (%s): tag some rigs, set $HITL_SERVERS, or pass --server-list", source)
	}
	fmt.Printf("runners from %s:\n", source)
	probes := pool.Probes(servers, fetchStatus)
	for _, p := range probes {
		if p.Err != nil {
			fmt.Printf("%-32s  DOWN (%v)\n", p.URL, p.Err)
			continue
		}
		st := p.Status
		who := "idle"
		if st.Active != nil {
			who = fmt.Sprintf("busy owner=%q", st.Active.Owner)
		}
		if len(st.Devices) > 0 {
			free := 0
			for _, d := range st.Devices {
				if d.Active == nil {
					free++
				}
			}
			who = fmt.Sprintf("%d/%d DUTs free", free, len(st.Devices))
		}
		fmt.Printf("%-32s  %-28s queue=%d lease=%ds\n", p.URL, who, st.QueueLength, st.LeaseSeconds)
	}
	if picked, err := pool.Pick(probes); err == nil {
		fmt.Printf("\npick: %s\n", picked)
	} else {
		fmt.Fprintf(os.Stderr, "\nno pick: %v\n", err)
	}
	return nil
}

// acquire yields an active reservation's SSH endpoint (host rewritten to match
// the server we reached, sshd port waited-on). With id set it reuses that
// reservation; otherwise it reserves one, heartbeats it, and — unless keep — the
// returned release() drops it. release is always non-nil (a no-op when reusing).
func acquire(ctx context.Context, c client, server, keyPath, owner, id, device string, keep bool) (*api.SSHEndpoint, string, string, func(), error) {
	_, priv, err := resolveKeypair(keyPath)
	if err != nil {
		return nil, "", "", nil, err
	}
	release := func() {}
	var ep *api.SSHEndpoint
	resID := id
	if id != "" {
		var res api.Reservation
		if err := c.get("/reservation/"+id, &res); err != nil {
			return nil, "", "", nil, err
		}
		if res.State != api.StateActive || res.SSH == nil {
			return nil, "", "", nil, fmt.Errorf("reservation %s is %s (not active)", id, res.State)
		}
		ep = res.SSH
	} else {
		pubBytes, err := os.ReadFile(mustPub(keyPath))
		if err != nil {
			return nil, "", "", nil, fmt.Errorf("read pubkey: %w", err)
		}
		var res api.Reservation
		if err := c.post("/reserve", api.ReserveRequest{Owner: owner, SSHPublicKey: string(pubBytes), Device: device}, &res); err != nil {
			return nil, "", "", nil, err
		}
		fmt.Fprintf(os.Stderr, "reserved: id=%s\n", res.ID)
		active, err := c.waitActive(ctx, res.ID)
		if err != nil {
			return nil, "", "", nil, err
		}
		ep = active.SSH
		resID = res.ID
		if !keep {
			release = func() {
				_ = c.postRaw(fmt.Sprintf("/reservation/%s/release", res.ID), nil)
				fmt.Fprintln(os.Stderr, "released")
			}
		}
		go c.heartbeatLoop(ctx, res.ID)
	}
	if h := hostFromServer(server); h != "" {
		ep.Host = h
	}
	if err := waitPort(ctx, ep.Host, ep.Port, 45*time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
	}
	return ep, priv, resID, release, nil
}

// mustPub returns the public key path for keyPath (resolveKeypair already ran in
// acquire, so this can't fail in practice).
func mustPub(keyPath string) string {
	pub, _, _ := resolveKeypair(keyPath)
	return pub
}

// --- ssh + keys -----------------------------------------------------------

// sshOpts are the common non-interactive SSH options (ephemeral known-hosts, our
// dedicated key only). `portFlag` is "-p" for ssh, "-P" for scp.
func sshOpts(privKey, portFlag string, port int) []string {
	o := []string{
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		portFlag, fmt.Sprint(port),
	}
	if privKey != "" {
		o = append(o, "-i", privKey, "-o", "IdentitiesOnly=yes")
	}
	return o
}

func openSSH(ctx context.Context, privKey string, ep *api.SSHEndpoint) error {
	sshArgs := append(sshOpts(privKey, "-p", ep.Port), fmt.Sprintf("%s@%s", ep.User, ep.Host))
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// scpTo copies local files into remoteDir on the reservation's container.
func scpTo(ctx context.Context, privKey string, ep *api.SSHEndpoint, locals []string, remoteDir string) error {
	args := sshOpts(privKey, "-P", ep.Port)
	args = append(args, locals...)
	args = append(args, fmt.Sprintf("%s@%s:%s", ep.User, ep.Host, remoteDir))
	cmd := exec.CommandContext(ctx, "scp", args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return cmd.Run()
}

// scpFrom copies a single remote file out of the reservation's container to a
// local path.
func scpFrom(ctx context.Context, privKey string, ep *api.SSHEndpoint, remotePath, localPath string) error {
	args := sshOpts(privKey, "-P", ep.Port)
	args = append(args, fmt.Sprintf("%s@%s:%s", ep.User, ep.Host, remotePath), localPath)
	cmd := exec.CommandContext(ctx, "scp", args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return cmd.Run()
}

// sshRun runs one command on the reservation, streaming its output.
func sshRun(ctx context.Context, privKey string, ep *api.SSHEndpoint, remoteCmd string) error {
	args := append(sshOpts(privKey, "-p", ep.Port), fmt.Sprintf("%s@%s", ep.User, ep.Host), remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// sshRunTTY runs a command with a pseudo-tty (for interactive tools like gdb).
func sshRunTTY(ctx context.Context, privKey string, ep *api.SSHEndpoint, remoteCmd string) error {
	args := append(sshOpts(privKey, "-p", ep.Port), "-t", fmt.Sprintf("%s@%s", ep.User, ep.Host), remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// resolveKeypair returns (pubkeyPath, privkeyPath) for a DEDICATED HITL key —
// not the caller's personal identity. It lives under $XDG_CONFIG_HOME/hitl,
// is passphrase-less (so reserve/ssh are non-interactive), and is generated once
// and reused (so `hitl ssh <id>` can reconnect to a reservation made earlier).
// Pass an explicit pubkey path via --key to override.
func resolveKeypair(keyArg string) (pub, priv string, err error) {
	if keyArg != "" {
		return keyArg, strings.TrimSuffix(keyArg, ".pub"), nil
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	dir = filepath.Join(dir, "hitl")
	priv = filepath.Join(dir, "id_ed25519")
	if _, e := os.Stat(priv); e != nil {
		if e := os.MkdirAll(dir, 0o700); e != nil {
			return "", "", e
		}
		cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-C", "hitl-agent", "-f", priv)
		if out, e := cmd.CombinedOutput(); e != nil {
			return "", "", fmt.Errorf("ssh-keygen: %w: %s", e, out)
		}
		fmt.Fprintf(os.Stderr, "created dedicated HITL key %s\n", priv)
	}
	return priv + ".pub", priv, nil
}

// --- tiny HTTP client -----------------------------------------------------

type client struct{ base string }

func (c client) get(path string, out any) error {
	resp, err := http.Get(c.base + path)
	if err != nil {
		return err
	}
	return decode(resp, out)
}

func (c client) post(path string, body, out any) error {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return err
	}
	resp, err := http.Post(c.base+path, "application/json", &buf)
	if err != nil {
		return err
	}
	return decode(resp, out)
}

func (c client) postRaw(path string, body any) error {
	return c.post(path, body, nil)
}

func decode(resp *http.Response, out any) error {
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var e api.Error
		b, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(b, &e)
		if e.Error != "" {
			return fmt.Errorf("server %d: %s", resp.StatusCode, e.Error)
		}
		return fmt.Errorf("server %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c client) waitActive(ctx context.Context, id string) (*api.Reservation, error) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	lastPos := -1
	for {
		var res api.Reservation
		if err := c.get("/reservation/"+id, &res); err != nil {
			return nil, err
		}
		switch res.State {
		case api.StateActive:
			return &res, nil
		case api.StateReleased:
			return nil, fmt.Errorf("reservation ended before activating: %s", res.Message)
		default:
			if res.Position != lastPos {
				fmt.Fprintf(os.Stderr, "waiting: %d ahead of you…\n", res.Position)
				lastPos = res.Position
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-t.C:
		}
	}
}

func (c client) heartbeatLoop(ctx context.Context, id string) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = c.postRaw(fmt.Sprintf("/reservation/%s/heartbeat", id), nil)
		}
	}
}

// --- small helpers --------------------------------------------------------

func newFlags(name string) *flag.FlagSet { return flag.NewFlagSet(name, flag.ExitOnError) }

func serverFlag(fs *flag.FlagSet) *string {
	// Default empty so resolveServer can distinguish "unset" (→ $HITL_SERVER, then
	// pool, then fallback) from an explicit --server / $HITL_SERVER value.
	return fs.String("server", envOr("HITL_SERVER", ""), "rig hitl-managerd URL (default $HITL_SERVER, or a free runner from $HITL_SERVERS)")
}

// deviceFlag pins a reservation to a named DUT on the rig (see `hitl status` for
// the names). Empty (the default) lets the rig pick any free DUT.
func deviceFlag(fs *flag.FlagSet) *string {
	return fs.String("device", envOr("HITL_DEVICE", ""), "pin to a specific DUT by name (default: any free DUT)")
}

// poolServers returns the runner base URLs to choose among when no explicit
// --server/$HITL_SERVER is given, and a label describing where they came from.
// Source precedence: an explicit $HITL_SERVERS list, else the tailnet nodes
// tagged $HITL_TAG (default tag:splanc-hitl), discovered via `tailscale status`.
// Returns (nil, "", nil) when there's nothing to go on (no list, discovery empty
// or unavailable) so the caller can fall back to its static default.
func poolServers() ([]string, string, error) {
	if list := os.Getenv("HITL_SERVERS"); strings.TrimSpace(list) != "" {
		return pool.Normalize(list), "$HITL_SERVERS", nil
	}
	tag := envOr("HITL_TAG", tailnet.DefaultTag)
	hosts, err := tailnet.Discover(tag)
	if err != nil {
		// Discovery is best-effort (e.g. no tailscale CLI): let the caller fall
		// back rather than fail outright, but surface why for the pool command.
		return nil, "tailnet tag " + tag, err
	}
	return pool.Normalize(strings.Join(hosts, " ")), "tailnet tag " + tag, nil
}

// resolveServer turns the (possibly empty) --server/$HITL_SERVER value into a
// concrete runner URL. With neither set, it discovers the runner pool (see
// poolServers), probes every runner's /status, and picks the shortest-queue one
// (see internal/pool). With nothing discoverable it errors with a hint rather
// than guessing a hostname (there is no canonical single rig under the naming
// scheme — see pi/hitl/README.md).
func resolveServer(s string, req ...pool.Require) (string, error) {
	if strings.TrimSpace(s) != "" {
		return s, nil // explicit --server/$HITL_SERVER: trust the operator's pick
	}
	servers, source, derr := poolServers()
	if len(servers) == 0 {
		hint := "pass --server (e.g. http://hitl-rig-1:8087) or set $HITL_SERVERS"
		if derr != nil {
			// Discovery failed — commonly no `tailscale` on PATH, which is what
			// `bazel test` sees (it sandboxes the action). `bazel run` inherits
			// your shell env, so discovery works there.
			return "", fmt.Errorf("no HITL rigs discovered via %s: %v — %s "+
				"(run these hardware tests with `bazel run`, not `bazel test`)", source, derr, hint)
		}
		return "", fmt.Errorf("no HITL rigs discovered via %s — %s", source, hint)
	}
	picked, err := pool.Pick(pool.Probes(servers, fetchStatus), req...)
	if err != nil {
		return "", fmt.Errorf("pool (%s): %w", source, err)
	}
	fmt.Fprintf(os.Stderr, "pool: picked %s (of %d runners from %s)\n", picked, len(servers), source)
	return picked, nil
}

// fetchStatus queries one runner's /status with a short timeout, so a down
// runner in the pool is skipped quickly rather than hanging the whole pick.
func fetchStatus(base string) (*api.Status, error) {
	hc := &http.Client{Timeout: 4 * time.Second}
	resp, err := hc.Get(base + "/status")
	if err != nil {
		return nil, err
	}
	var s api.Status
	if err := decode(resp, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// resolve replaces *server in place with the concrete runner URL (see
// resolveServer). Call once, right after fs.Parse.
func resolve(server *string, req ...pool.Require) error {
	s, err := resolveServer(*server, req...)
	if err != nil {
		return err
	}
	*server = s
	return nil
}

// requireFlag registers a --require capability filter for pool selection.
func requireFlag(fs *flag.FlagSet) *string {
	return fs.String("require", "", "only pick a rig with this capability (e.g. analyzer)")
}

// parseRequire maps the --require value to a pool.Require.
func parseRequire(s string) (pool.Require, error) {
	switch strings.TrimSpace(s) {
	case "":
		return pool.Require{}, nil
	case "analyzer":
		return pool.Require{Analyzer: true}, nil
	default:
		return pool.Require{}, fmt.Errorf("unknown --require %q (known: analyzer)", s)
	}
}

// hostFromServer extracts the host (name or IP) from the --server URL, so the
// SSH connection targets the same machine we reached the API on.
func hostFromServer(server string) string {
	u, err := url.Parse(server)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// waitPort blocks until host:port accepts a TCP connection or the timeout hits.
func waitPort(ctx context.Context, host string, port int, timeout time.Duration) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(timeout)
	for {
		d := net.Dialer{Timeout: 3 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("sshd at %s not reachable after %s: %w", addr, timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(750 * time.Millisecond):
		}
	}
}

func fmtTime(t *time.Time) string {
	if t == nil {
		return "?"
	}
	return t.Format(time.Kitchen)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func defaultOwner() string {
	if u := os.Getenv("USER"); u != "" {
		h, _ := os.Hostname()
		return u + "@" + h
	}
	h, _ := os.Hostname()
	return h
}
