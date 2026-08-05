// Command hitl-managerd is the Pi-side HITL reservation daemon. It exposes a
// small JSON API (over the tailnet) that agents use to queue for the rig; when
// a reservation reaches the head it starts a test container with an ESP32-C6 DUT
// attached and the holder's SSH key authorized, and returns the SSH endpoint.
//
// A rig may host several DUTs (each its own port + device nodes, run
// concurrently): pass one --dut '{"name":…,"ssh_port":…,"devices":[…]}' per DUT.
// With no --dut flags it falls back to a single DUT built from --ssh-port and
// --device (the original behavior).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/fughilli/splanc/pi/hitl/internal/ap"
	"github.com/fughilli/splanc/pi/hitl/internal/api"
	"github.com/fughilli/splanc/pi/hitl/internal/queue"
	"github.com/fughilli/splanc/pi/hitl/internal/runner"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func main() {
	hostname, _ := os.Hostname()

	addr := flag.String("addr", ":8087", "listen address (bind to the tailnet interface in prod)")
	rig := flag.String("rig", hostname, "rig name")
	host := flag.String("host", hostname, "host agents use to reach this machine (tailnet name)")
	image := flag.String("image", "hitl-test:latest", "OCI image for the test container")
	sshPort := flag.Int("ssh-port", 2222, "host port published to the container sshd")
	sshUser := flag.String("ssh-user", "agent", "login user inside the container")
	lease := flag.Duration("lease", 30*time.Minute, "heartbeat lease window")
	stateDir := flag.String("state-dir", "/var/lib/hitl", "writable scratch dir")
	podman := flag.String("podman", "podman", "podman binary")
	privileged := flag.Bool("privileged", true, "run the container privileged (raw USB/JTAG)")
	var devices stringList
	flag.Var(&devices, "device", "extra --device mapping for the single-DUT fallback (repeatable)")
	var duts stringList
	flag.Var(&duts, "dut", `a DUT as JSON: {"name":"c6-0","ssh_port":2222,"devices":["/dev/serial/by-id/…:/dev/ttyACM0"],"env":{"HITL_ADAPTER_SERIAL":"…"}} (repeatable; enables multi-DUT)`)
	// The rig's self-hosted provisioning AP (NetworkManager connection toggled
	// per-reservation). With --ap-conn set, the daemon brings it up while a
	// reservation is active and advertises its creds in /status so the harness
	// provisions the DUT onto it with no external WiFi.
	apConn := flag.String("ap-conn", "", "NetworkManager connection id for the provisioning AP (enables AP mode)")
	apSSID := flag.String("ap-ssid", "", "SSID advertised in /status for the provisioning AP")
	apPSK := flag.String("ap-psk", "", "passphrase advertised in /status for the provisioning AP")
	apIface := flag.String("ap-iface", "", "AP virtual interface to create on demand (e.g. ap0); empty = don't manage a vif")
	apSta := flag.String("ap-sta", "wlan0", "STA interface whose radio hosts the AP vif")
	nmcli := flag.String("nmcli", "nmcli", "nmcli binary used to toggle the AP connection")
	iw := flag.String("iw", "iw", "iw binary used to create the AP vif")
	ipBin := flag.String("ip", "ip", "ip binary used to set the AP vif MAC")
	flag.Parse()

	run := runner.NewPodman(runner.PodmanConfig{
		Image:      *image,
		Host:       *host,
		SSHUser:    *sshUser,
		StateDir:   *stateDir,
		Podman:     *podman,
		Privileged: *privileged,
	})

	devs, err := buildDevices(duts, *sshPort, devices)
	if err != nil {
		log.Fatalf("dut config: %v", err)
	}
	for _, d := range devs {
		log.Printf("dut: name=%s ssh-port=%d devices=%v", d.Name, d.SSHPort, d.Devices)
	}

	var opts []queue.Option
	opts = append(opts, queue.WithDevices(devs))
	var apCtl *ap.NMController
	// Advertise the provisioning-AP creds in /status (for `hitl wifi`) whenever an
	// SSID is configured — independent of whether the daemon toggles the AP.
	if *apSSID != "" {
		opts = append(opts, queue.WithWiFi(&api.WiFiInfo{SSID: *apSSID, PSK: *apPSK}))
		log.Printf("provisioning AP: ssid=%q", *apSSID)
	}
	// Per-reservation AP control (create the vif + toggle the NM connection) only
	// when --ap-conn is set. Unused for an always-on dedicated-radio AP; kept for
	// the future multi-DUT design.
	if *apConn != "" {
		apCtl = ap.New(*nmcli, *apConn, *apIface, *apSta, *iw, *ipBin)
		opts = append(opts, queue.WithAP(apCtl))
	}
	mgr := queue.New(*rig, *lease, run, opts...)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := mgr.Recover(ctx); err != nil {
		log.Printf("startup cleanup: %v", err)
	}
	// A crash mid-reservation could leave the AP up; ensure it's down at startup
	// (idempotent) so a fresh boot is STA-only until a reservation activates.
	if apCtl != nil {
		if err := apCtl.Down(ctx); err != nil {
			log.Printf("startup ap down: %v", err)
		}
	}

	// Reap expired leases periodically.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				mgr.ReapExpired(ctx)
			}
		}
	}()

	srv := &http.Server{Addr: *addr, Handler: routes(ctx, mgr)}
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sc)
	}()

	log.Printf("hitl-managerd: rig=%q listening on %s (image=%s lease=%s)", *rig, *addr, *image, *lease)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

// dutSpec is the JSON shape of a --dut flag value.
type dutSpec struct {
	Name    string            `json:"name"`
	SSHPort int               `json:"ssh_port"`
	Devices []string          `json:"devices"`
	Env     map[string]string `json:"env"`
}

// buildDevices turns the --dut flags into runner.Devices. With no --dut flags it
// synthesizes a single DUT from the legacy --ssh-port/--device flags, preserving
// the original single-DUT behavior. It rejects duplicate names and ports so a
// misconfiguration can't collide two DUTs onto one container port.
func buildDevices(duts []string, sshPort int, devices []string) ([]runner.Device, error) {
	if len(duts) == 0 {
		return []runner.Device{{Name: "dut0", SSHPort: sshPort, Devices: devices}}, nil
	}
	var out []runner.Device
	names, ports := map[string]bool{}, map[int]bool{}
	for i, raw := range duts {
		var s dutSpec
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			return nil, fmt.Errorf("--dut #%d %q: %w", i+1, raw, err)
		}
		if s.Name == "" {
			return nil, fmt.Errorf("--dut #%d: name is required", i+1)
		}
		if s.SSHPort == 0 {
			return nil, fmt.Errorf("--dut %q: ssh_port is required", s.Name)
		}
		if names[s.Name] {
			return nil, fmt.Errorf("--dut %q: duplicate name", s.Name)
		}
		if ports[s.SSHPort] {
			return nil, fmt.Errorf("--dut %q: ssh_port %d already used by another DUT", s.Name, s.SSHPort)
		}
		names[s.Name], ports[s.SSHPort] = true, true
		out = append(out, runner.Device{Name: s.Name, SSHPort: s.SSHPort, Devices: s.Devices, Env: s.Env})
	}
	return out, nil
}

func routes(ctx context.Context, mgr *queue.Manager) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, mgr.Status())
	})

	mux.HandleFunc("POST /reserve", func(w http.ResponseWriter, r *http.Request) {
		var req api.ReserveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		if strings.TrimSpace(req.SSHPublicKey) == "" {
			writeErr(w, http.StatusBadRequest, "ssh_public_key is required")
			return
		}
		if req.Device != "" && !mgr.HasDevice(req.Device) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown device %q; rig has %v", req.Device, mgr.Devices()))
			return
		}
		writeJSON(w, http.StatusAccepted, mgr.Reserve(ctx, req))
	})

	mux.HandleFunc("GET /reservation/{id}", func(w http.ResponseWriter, r *http.Request) {
		res, err := mgr.Get(r.PathValue("id"))
		if err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /reservation/{id}/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if err := mgr.Heartbeat(r.PathValue("id")); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		res, _ := mgr.Get(r.PathValue("id"))
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /reservation/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		if err := mgr.Release(ctx, r.PathValue("id"), "released by holder"); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	return logging(mux)
}

func logging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, api.Error{Error: msg})
}
