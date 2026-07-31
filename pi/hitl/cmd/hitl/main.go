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
	"net/http"
	"net/url"
	"os"
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

Server URL: --server or $HITL_SERVER (e.g. http://hitl-rig:8087).
`)
}

// --- reserve --------------------------------------------------------------

func cmdReserve(args []string) error {
	fs := newFlags("reserve")
	server := serverFlag(fs)
	owner := fs.String("owner", envOr("HITL_OWNER", defaultOwner()), "reservation owner id (for logs/status)")
	keyPath := fs.String("key", "", "SSH public key file to authorize (default: ~/.ssh/id_ed25519.pub, else ephemeral)")
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
	keyPath := fs.String("key", "", "SSH private key (default: ~/.ssh/id_ed25519)")
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

// --- ssh + keys -----------------------------------------------------------

func openSSH(ctx context.Context, privKey string, ep *api.SSHEndpoint) error {
	sshArgs := []string{
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-p", fmt.Sprint(ep.Port),
	}
	if privKey != "" {
		sshArgs = append(sshArgs, "-i", privKey, "-o", "IdentitiesOnly=yes")
	}
	sshArgs = append(sshArgs, fmt.Sprintf("%s@%s", ep.User, ep.Host))
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// resolveKeypair returns (pubkeyPath, privkeyPath). If keyArg is a pubkey path,
// its sibling (minus .pub) is the private key. Else prefer ~/.ssh/id_ed25519,
// else generate an ephemeral ed25519 keypair with ssh-keygen.
func resolveKeypair(keyArg string) (pub, priv string, err error) {
	home, _ := os.UserHomeDir()
	if keyArg != "" {
		pub = keyArg
		priv = strings.TrimSuffix(keyArg, ".pub")
		return pub, priv, nil
	}
	def := filepath.Join(home, ".ssh", "id_ed25519")
	if _, e := os.Stat(def + ".pub"); e == nil {
		return def + ".pub", def, nil
	}
	// Ephemeral keypair under a temp dir.
	dir, e := os.MkdirTemp("", "hitl-key-")
	if e != nil {
		return "", "", e
	}
	priv = filepath.Join(dir, "id_ed25519")
	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-C", "hitl-agent", "-f", priv)
	if out, e := cmd.CombinedOutput(); e != nil {
		return "", "", fmt.Errorf("ssh-keygen: %w: %s", e, out)
	}
	fmt.Fprintf(os.Stderr, "generated ephemeral key %s\n", priv)
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
