"""Virtual LED wall as a Splanc player the phone app can add by address.

    bazel run //pi/player_rs:wall -- --leds 400

Runs `player_host` (the real player session core: the same mapping code book,
pattern clock and protocol the ESP32/Pi players run) with no LED output, and has
it serve the built web app's virtual wall (web/wall.html) over HTTPS on its WSS
port. The wall page, opened from the player's own origin, reaches the player's
control plane same-origin, learns the code book + pattern epoch the phone set
with start_mapping (get_pattern) and the player clock (time sync), and renders
every frame locally with the WASM hue-code kernel at the display's refresh rate.
Nothing is streamed, so the frame timing is the browser's vsync, not the network.

The phone adds the player like any other: Add device -> Enter address ->
wss://<this laptop>:<port>. The certificate is self-signed, exactly like a real
player's, and the app's trust flow handles it (the player answers the trust
popup at https://<this laptop>:<port>/).

The same origin also serves THIS build of the phone app at
https://<this laptop>:<port>/app/ (with the wasm solver next to it), for testing
app changes that the installed app doesn't have yet, e.g. hue code v2 phase 2:
https://<this laptop>:<port>/app/?sync=stagger_pilot asks the player for the
staggered pilot (this host player advertises hue_stagger_pilot).

Flags are passed through to player_host (see docs/host-player.md); defaults here:
--output null, --name "Virtual wall", --state-dir "" (memory only), port 8443.
"""

import os
import socket
import sys
import tempfile


def lan_ip() -> str | None:
    """The address on the LAN the default route uses (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1: routed like a public address
            ip = s.getsockname()[0]
    except OSError:
        return None
    return None if ip.startswith(("0.", "127.")) else ip


def flag(args: list[str], name: str, default: str) -> str:
    """The LAST value of `name` in args (player_host's later flags win)."""
    val = default
    for i, a in enumerate(args[:-1]):
        if a == name:
            val = args[i + 1]
    return val


def player_args(args: list[str], web_root: str) -> list[str]:
    """player_host argv: the wall defaults, then the user's flags (which win)."""
    out = ["--name", "Virtual wall", "--state-dir", "", "--web-root", web_root]
    if "--output" not in args:
        out += ["--output", "null"]
    if "--leds" not in args:
        out += ["--leds", "400"]
    return out + args


def instructions(port: str, ip: str | None, leds: str) -> str:
    phone_host = f"{ip}:{port}" if ip else f"<this computer's IP>:{port}"
    return "\n".join(
        [
            "",
            f"Virtual LED wall: {leds} LEDs",
            "",
            "1. On this computer, open",
            f"       https://localhost:{port}/wall.html",
            "   accept the certificate warning (Advanced -> Proceed), then press Fullscreen.",
            "",
            "2. On the phone, in the Splanc app: Device tab -> link icon (Enter address manually)",
            "   -> Enter address (the Wi-Fi fields can stay empty), and enter",
            f"       wss://{phone_host}",
            "   The app asks you to trust the certificate once, as with a real player.",
            "   (Or scan the QR code below first: it opens the trust page in the browser.)",
            "",
            "3. Point the phone at the wall and map it as usual (LED count = the --leds value).",
            "",
            "To run THIS build of the app instead of the installed one (e.g. hue code v2:",
            "append ?sync=stagger_pilot), open on the phone",
            f"       https://{phone_host}/app/",
            "",
        ]
    )


def stage_web_root(dist: str, solver: str | None) -> str:
    """A web root of the built app (web/dist) plus the wasm solver at solver/,
    as the site deploys it (web/stage_site.lib.sh), so the app served at /app/
    can solve on the phone. Symlinks into the runfiles; nothing is copied."""
    if not solver or not os.path.isdir(solver):
        return dist
    root = tempfile.mkdtemp(prefix="splanc_wall_root_")
    for name in os.listdir(dist):
        os.symlink(os.path.join(dist, name), os.path.join(root, name))
    if not os.path.exists(os.path.join(root, "solver")):
        os.symlink(solver, os.path.join(root, "solver"))
    return root


def main() -> None:
    args = sys.argv[1:]
    from python.runfiles import runfiles

    r = runfiles.Create()
    host_bin = r.Rlocation("_main/pi/player_rs/player_host")
    web_root = r.Rlocation("_main/web/dist")
    if not (host_bin and os.path.exists(host_bin)) or not (web_root and os.path.isdir(web_root)):
        sys.exit("wall: player_host or web/dist missing from runfiles; run via bazel run")
    web_root = stage_web_root(web_root, r.Rlocation("_main/solver/solver_web"))

    port = flag(args, "--serve-port", "8443")
    ip = lan_ip()
    print(instructions(port, ip, flag(args, "--leds", "400")), flush=True)
    if ip:
        try:
            import segno

            segno.make(f"https://{ip}:{port}/", error="m").terminal(compact=True)
        except Exception as e:  # noqa: BLE001 - the QR is a convenience only
            print(f"(no QR code: {e})")
    sys.stdout.flush()
    os.execv(host_bin, [host_bin, *player_args(args, web_root)])


if __name__ == "__main__":
    main()
