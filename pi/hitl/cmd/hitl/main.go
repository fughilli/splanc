// Command hitl is the agent-facing CLI for the HITL rig. Run inside a
// claude-container session; it reaches the rig's hitl-managerd over the tailnet.
//
//	hitl reserve            # queue, then drop into an SSH shell on the rig
//	hitl status             # show the queue / active holder
//	hitl release <id>       # release a reservation
//	hitl ssh <id>           # SSH into an already-active reservation
//
// The rig URL comes from --server or $HITL_SERVER (e.g. http://hitl-rig:8087).
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
	"strconv"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/api"
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

  hitl reserve [--owner ID] [--server URL] [--key PUBKEY] [--keep]
  hitl status  [--server URL]
  hitl release <id> [--server URL]
  hitl ssh     <id> [--server URL]
  hitl flash   [--port DEV] [--id RES] [--keep] [--monitor] [--server URL] <bundle.tar>
  hitl monitor [--port DEV] [--id RES] [--keep] [--reset] [--seconds N] [--server URL]
  hitl ble     scan [--name S] [--seconds N] | gatt <address>   [--id RES] [--keep]
  hitl jtag    [--id RES] [--keep] [-- openocd args]            # C6 built-in USB-JTAG
  hitl gdb     [--elf FILE] [--id RES] [--keep] [-- gdb args]   # attach gdb via openocd

Server URL: --server or $HITL_SERVER (e.g. http://hitl-rig:8087).
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
	keep := fs.Bool("keep", false, "keep the reservation after the SSH session exits (default: release)")
	noShell := fs.Bool("no-shell", false, "just wait until active and print the endpoint; don't open a shell")
	_ = fs.Parse(args)

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
	if err := c.post("/reserve", api.ReserveRequest{Owner: *owner, SSHPublicKey: string(pubBytes)}, &res); err != nil {
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
	fmt.Fprintf(os.Stderr, "active: ssh %s@%s -p %d\n", ep.User, ep.Host, ep.Port)

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
		fmt.Printf("%s@%s:%d\n", ep.User, ep.Host, ep.Port)
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
	var s api.Status
	if err := (client{base: *server}).get("/status", &s); err != nil {
		return err
	}
	fmt.Printf("rig: %s   lease: %ds\n", s.Rig, s.LeaseSeconds)
	if s.Active != nil {
		fmt.Printf("active: id=%s owner=%q since=%s\n", s.Active.ID, s.Active.Owner, fmtTime(s.Active.StartedAt))
	} else {
		fmt.Println("active: (idle)")
	}
	fmt.Printf("queued: %d waiting\n", s.QueueLength)
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
	keep := fs.Bool("keep", false, "keep the reservation after flashing (default: release when we made it)")
	monitor := fs.Bool("monitor", false, "read the serial console after flashing")
	monSecs := fs.Float64("monitor-seconds", 10, "how long to read serial with --monitor (0 = until Ctrl-C)")
	_ = fs.Parse(args)

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
	ep, priv, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *keep)
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
	keep := fs.Bool("keep", false, "keep the reservation after monitoring (default: release when we made it)")
	secs := fs.Float64("seconds", 0, "how long to read (0 = until Ctrl-C)")
	reset := fs.Bool("reset", false, "hard-reset the board first (to catch boot logs)")
	_ = fs.Parse(args)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *keep)
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
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	seconds := fs.Float64("seconds", 6, "scan duration")
	name := fs.String("name", "", "scan: only show devices whose name contains this")
	_ = fs.Parse(args)

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
	ep, priv, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *keep)
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
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	_ = fs.Parse(args)

	// Any remaining args pass through to openocd (e.g. -c "init; reset halt; ...").
	// No args → hitl-jtag's default (halt + read pc + reset-run).
	remote := "hitl-jtag"
	for _, a := range fs.Args() {
		remote += " " + shellQuote(a)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *keep)
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
	keep := fs.Bool("keep", false, "keep the reservation afterward (default: release when we made it)")
	elf := fs.String("elf", "", "firmware ELF to load symbols from (copied into the container)")
	_ = fs.Parse(args)

	if *elf != "" {
		if _, err := os.Stat(*elf); err != nil {
			return fmt.Errorf("elf: %w", err)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	c := client{base: *server}
	ep, priv, release, err := acquire(ctx, c, *server, *keyPath, *owner, *id, *keep)
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

// acquire yields an active reservation's SSH endpoint (host rewritten to match
// the server we reached, sshd port waited-on). With id set it reuses that
// reservation; otherwise it reserves one, heartbeats it, and — unless keep — the
// returned release() drops it. release is always non-nil (a no-op when reusing).
func acquire(ctx context.Context, c client, server, keyPath, owner, id string, keep bool) (*api.SSHEndpoint, string, func(), error) {
	_, priv, err := resolveKeypair(keyPath)
	if err != nil {
		return nil, "", nil, err
	}
	release := func() {}
	var ep *api.SSHEndpoint
	if id != "" {
		var res api.Reservation
		if err := c.get("/reservation/"+id, &res); err != nil {
			return nil, "", nil, err
		}
		if res.State != api.StateActive || res.SSH == nil {
			return nil, "", nil, fmt.Errorf("reservation %s is %s (not active)", id, res.State)
		}
		ep = res.SSH
	} else {
		pubBytes, err := os.ReadFile(mustPub(keyPath))
		if err != nil {
			return nil, "", nil, fmt.Errorf("read pubkey: %w", err)
		}
		var res api.Reservation
		if err := c.post("/reserve", api.ReserveRequest{Owner: owner, SSHPublicKey: string(pubBytes)}, &res); err != nil {
			return nil, "", nil, err
		}
		fmt.Fprintf(os.Stderr, "reserved: id=%s\n", res.ID)
		active, err := c.waitActive(ctx, res.ID)
		if err != nil {
			return nil, "", nil, err
		}
		ep = active.SSH
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
	return ep, priv, release, nil
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
	return fs.String("server", envOr("HITL_SERVER", "http://hitl-rig:8087"), "rig hitl-managerd URL")
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
