"""HITL gate: over-the-air firmware updates with the split loader (docs/design/ota.md).

Inside ONE reservation on a C6 DUT (rig DUTs get reflashed by others between
reservations), each phase on the device the previous one left:

  1. migrate  — flash this tree's LEGACY bundle (huge_app layout) clean, provision
                Wi-Fi over the wired console, upload a map, read the TLS pin; then the
                one-time USB migration the web flasher does: phase 1 writes everything
                below the app slot (table, erased otadata, loader) and the loader copies
                littlefs across; phase 2 writes the app. The device must come back on
                the same Wi-Fi with NO provisioning, the same TLS identity and the
                same stored map.
  2. upgrade  — A -> B over the air (B reports fw_version "+b"); B must prove healthy.
  3. crash    — an app that aborts at boot: the bootloader rolls back to the loader,
                which reports rolled_back; then B again, over the air, recovers it.
  4. unhealthy— an app that never becomes healthy (no render task): its health check
                rolls it back at the deadline; B again recovers it.
  5. powercut — an update interrupted half way by a chip reset (the rig can reset a
                DUT over USB but cannot cut its power; a reset aborts the flash write
                the same way): the loader comes back in recovery, the client resumes
                from the persisted offset, the image verifies and boots.
  6. badsig   — a manifest whose signature doesn't verify: the loader refuses it
                (bad_signature), nothing is written, and the device returns to the app.
  7. keyrot   — key rotation after a compromise: B signed by the (test) backup key with
                a key-epoch record, signed by the backup key, revoking the release key
                rides along and installs; then an image signed by the revoked release
                key is refused (revoked_key). Last: it leaves the DUT's NVS with the test
                release key revoked (every other test flashes with --erase-fs).

Every image is signed with the checked-in TEST key and the loader is the test-key
build, so this never touches the release key. Every phase's serial log is saved
(--log-dir), and the Reservation's always-on DUT serial capture is dumped on failure.

    bazel run //pi/hitl/harness:ota_gate -- --server http://hitl-rig-2:8087 \\
        --device c6-003f08 --log-dir /tmp/ota-logs [--phases migrate,upgrade]

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import io
import json
import os
import re
import ssl
import sys
import tarfile
import tempfile
import time
from typing import Any

PHASES = ("migrate", "upgrade", "crash", "unhealthy", "powercut", "badsig", "keyrot")

RUNFILES = {
    "legacy": "HITL_LEGACY_BUNDLE_RUNFILE",
    "ota_bundle": "HITL_OTA_BUNDLE_RUNFILE",
    "pkg_a": "HITL_OTA_A_RUNFILE",
    "pkg_b": "HITL_OTA_B_RUNFILE",
    "pkg_crash": "HITL_OTA_CRASH_RUNFILE",
    "pkg_unhealthy": "HITL_OTA_UNHEALTHY_RUNFILE",
    "pkg_b_backup": "HITL_OTA_B_BACKUP_RUNFILE",
    "epoch": "HITL_OTA_EPOCH_RUNFILE",
}


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(env: str) -> str | None:
    rel = os.environ.get(env)
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rel)
    except Exception:
        return None


def _save(log_dir: str | None, name: str, text: str) -> None:
    if not log_dir:
        return
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, f"{name}.log"), "w") as f:
        f.write(text)


def split_bundle(bundle: str, out_dir: str) -> tuple[str, str]:
    """The OTA bundle -> (phase-1 bundle: everything below the app slot, phase-2
    bundle: the app alone), exactly as a migrating flasher splits it."""
    with tarfile.open(bundle) as t:
        manifest = json.load(t.extractfile("flash.json"))
        files = {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
    app_off = int(manifest["ota"]["app_offset"], 16)
    paths = []
    for phase, keep in (("phase1", lambda o: o < app_off), ("phase2", lambda o: o >= app_off)):
        m = dict(manifest)
        m["images"] = [i for i in manifest["images"] if keep(int(i["offset"], 16))]
        path = os.path.join(out_dir, f"ota-{phase}.tar")
        with tarfile.open(path, "w") as t:
            blob = json.dumps(m).encode()
            ti = tarfile.TarInfo("flash.json")
            ti.size = len(blob)
            t.addfile(ti, io.BytesIO(blob))
            for img in m["images"]:
                data = files[img["file"]]
                ti = tarfile.TarInfo(img["file"])
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
        paths.append(path)
    return paths[0], paths[1]


def corrupt_signature(pkg: bytes) -> bytes:
    b = bytearray(pkg)
    b[44 + 7] ^= 0x01  # inside r: the signed bytes and the image stay intact
    return bytes(b)


_LEASE_RE = re.compile(r"DHCP LEASE ACQUIRED.*?IP\s+(\d{1,3}(?:\.\d{1,3}){3})")
_MIGRATE_RE = re.compile(r"\[loader\] migrate: done legacy=(\d) copied=(\d+) failed=(\d+)")


def last_lease(log: str) -> str | None:
    m = _LEASE_RE.findall(log)
    return m[-1] if m else None


class WssLink:
    """ota_core.Link over wss through the reservation's ssh tunnel.

    `port` is either a fixed local port or a callable that returns the current one:
    after an UNPLANNED reset the netstack draws a new MAC and the DUT comes back on a
    new DHCP lease, so the gate re-reads the IP from the DUT's serial log and re-tunnels
    (a planned restart keeps the IP)."""

    def __init__(self, port) -> None:
        self.port_fn = port if callable(port) else (lambda: port)
        self.port = None
        self.sock = None

    async def open(self, deadline: float):
        import ota_core as oc
        import websockets

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        last: BaseException | None = None
        while time.monotonic() < deadline:
            try:
                # Every attempt re-reads where the DUT is: an unplanned reset moves it.
                self.port = await asyncio.to_thread(self.port_fn)
                left = max(3.0, min(25.0, deadline - time.monotonic()))
                self.sock = await websockets.connect(
                    f"wss://127.0.0.1:{self.port}/ws", ssl=ctx, max_size=2**22, open_timeout=left
                )
                await self.sock.send(
                    oc.client(hello=oc.pb.Hello(client="hitl_ota", app_version="1"))
                )
                while True:
                    arm, msg = oc.server(await asyncio.wait_for(self.sock.recv(), timeout=left))
                    if arm == "welcome":
                        return msg
            except BaseException as e:  # noqa: BLE001 — the device is rebooting; retry
                if isinstance(e, (KeyboardInterrupt, SystemExit)):
                    raise
                last = e
                await self.close()
                await asyncio.sleep(1.5)
        raise TimeoutError(f"no welcome ({type(last).__name__}: {last})")

    async def send(self, frame: bytes) -> None:
        import ota_core as oc

        try:
            await self.sock.send(frame)
        except Exception as e:  # noqa: BLE001
            raise oc.LinkDropped(str(e)) from e

    async def recv(self, timeout: float) -> bytes:
        import ota_core as oc

        try:
            return await asyncio.wait_for(self.sock.recv(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError("recv")
        except Exception as e:  # noqa: BLE001
            raise oc.LinkDropped(str(e)) from e

    async def close(self) -> None:
        if self.sock is not None:
            try:
                await asyncio.wait_for(self.sock.close(), timeout=5)
            except Exception:  # noqa: BLE001
                pass
            self.sock = None


async def _session(port: int):
    link = WssLink(port)
    w = await link.open(time.monotonic() + 90)
    return link, w


async def _device_state(port: int, pull_map: bool = True) -> dict[str, Any]:
    """TLS pin + stored map digest + OTA status, over one session."""
    import ota_core as oc

    link, w = await _session(port)
    out: dict[str, Any] = {"fw_version": w.fw_version, "mac": w.mac, "loader": oc.in_loader(w)}
    try:
        ti = await oc.rpc(link, oc.client(get_tls_info=oc.pb.GetTlsInfo()), "tls_info")
        out["cert_sha256"] = ti.cert_sha256
        st = await oc.rpc(link, oc.client(get_ota_status=oc.pb.GetOtaStatus()))
        out["ota"] = oc.status_dict(st)
        if pull_map and not out["loader"]:
            data = b""
            while True:
                c = await oc.rpc(
                    link,
                    oc.client(get_stored_map=oc.pb.GetStoredMap(offset=len(data), max_len=1024)),
                    "stored_map_chunk",
                )
                if not c.data:
                    break
                data += c.data
                if len(data) >= c.total_len:
                    break
            out["map_len"] = len(data)
            out["map_sha"] = hashlib.sha256(data).hexdigest() if data else ""
            if data:
                b = oc.pb.MappingBundle.FromString(data)
                out["map_leds"] = len(b.map.leds)
    finally:
        await link.close()
    return out


async def _upload_map(port: int, n_leds: int) -> None:
    import ota_core as oc
    from map_upload_core import synth_output_map, window_plan
    from server import proto_wire

    link, _ = await _session(port)
    try:
        flat = synth_output_map(n_leds, "__ota_gate")
        frame = proto_wire.encode_client(flat)
        for seq, off, end, last in window_plan(len(frame), 1024):
            msg = oc.client(
                upload_chunk=oc.pb.UploadChunk(
                    upload_id=7,
                    seq=seq,
                    last=last,
                    kind=oc.pb.UploadChunk.MAP,
                    payload=frame[off:end],
                )
            )
            await oc.rpc(link, msg, "result_ready" if last else "chunk_ack", timeout=60)
    finally:
        await link.close()


def run(args) -> int:
    import ota_core as oc
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, wire_provision_dut

    work = tempfile.mkdtemp(prefix="hitl-ota-")
    phase1, phase2 = split_bundle(args.ota_bundle, work)
    pkgs = {
        k: open(getattr(args, k), "rb").read()
        for k in ("pkg_a", "pkg_b", "pkg_crash", "pkg_unhealthy", "pkg_b_backup")
    }
    epoch_rec = open(args.epoch, "rb").read()
    pkgs["badsig"] = corrupt_signature(pkgs["pkg_b"])

    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    tunnels = contextlib.ExitStack()
    tunnel_ports: dict[str, int] = {}
    ip = ""
    res.acquire()
    checks: list[oc.Check] = []
    report: dict[str, Any] = {"phases": {}}
    logs: dict[str, str] = {}

    def flash(remote: str, erase: bool, seconds: float, name: str) -> str:
        flags = " --erase-fs" if erase else ""
        proc = res.ssh_serialized(
            f"hitl-flash {remote}{flags} --monitor --monitor-seconds {seconds:g}",
            capture=True,
            timeout=300 + seconds,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            raise RuntimeError(f"hitl-flash {name} exited {proc.returncode}:\n{log[-2000:]}")
        log = ensure_booted(res, log, seconds)
        logs[name] = log
        return log

    def reset_dut() -> None:
        # A chip reset over the native USB (what the rig can do; it cannot cut power).
        # No serial monitor here: opening the port would reset the board again, and the
        # Reservation's always-on capture already records the boot.
        res.ssh_serialized(
            "esptool --chip esp32c6 -p /dev/ttyACM0 --before default_reset --after hard_reset run",
            capture=True,
            timeout=60,
        )

    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        res.ssh("mkdir -p /tmp/ota")
        res.scp_to([args.legacy, phase1, phase2], "/tmp/ota/")
        legacy_r = f"/tmp/ota/{os.path.basename(args.legacy)}"

        # -- 1. migrate ------------------------------------------------------------
        _log("[migrate] legacy bundle, clean (--erase-fs)")
        flash(legacy_r, True, 12.0, "legacy_flash")
        url = wire_provision_dut(res, ssid, password, 60.0)
        ip = url.split("/")[2]
        _log(f"[migrate] provisioned at {ip}")
        with res.forward(ip, 443) as port:
            asyncio.run(_upload_map(port, args.map_leds))
            before = asyncio.run(_device_state(port))
        _log(f"[migrate] before: {json.dumps(before)}")
        _log(
            "[migrate] USB phase 1: table + erased otadata + loader (nothing at/after the app slot)"
        )
        p1 = flash("/tmp/ota/ota-phase1.tar", False, args.migrate_seconds, "migrate_phase1")
        m = _MIGRATE_RE.search(p1)
        _log(f"[migrate] loader: {m.group(0) if m else 'NO migrate line'}")
        _log("[migrate] USB phase 2: the app")
        p2 = flash("/tmp/ota/ota-phase2.tar", False, args.boot_seconds, "migrate_phase2")
        ip2 = last_lease(p2) or ip
        after: dict[str, Any] = {"leased": last_lease(p2) is not None, "ip": ip2}
        after["migrated_files"] = int(m.group(2)) if m else 0
        if after["leased"]:
            with res.forward(ip2, 443) as port:
                after.update(asyncio.run(_device_state(port)))
        _log(f"[migrate] after: {json.dumps(after)}")
        before["map_leds"] = before.get("map_leds") or 0
        checks += oc.migration_checks(before, after)
        report["phases"]["migrate"] = {"before": before, "after": after}
        ip = ip2

        def current_port() -> int:
            """The local port of a tunnel to the DUT's CURRENT IP (from its serial log)."""
            nonlocal ip
            p = res.ssh("tail -c 60000 /tmp/hitl-serial/dut0.log", capture=True, timeout=30)
            seen = last_lease(p.stdout or "")
            if seen and seen != ip:
                _log(f"  [link] the DUT moved {ip} -> {seen}")
                ip = seen
            if ip not in tunnel_ports:
                tunnel_ports[ip] = tunnels.enter_context(res.forward(ip, 443))
            return tunnel_ports[ip]

        def ota_phase(name: str, pkg: bytes, expect: str, **kw) -> oc.PushResult | None:
            _log(f"[{name}] pushing v{oc.split_package(pkg)[2].version} expecting {expect}")
            r = None
            t0 = time.monotonic()
            if True:
                link = WssLink(current_port)
                try:
                    r = asyncio.run(
                        oc.push(
                            link,
                            pkg,
                            progress=_progress(name),
                            expect_healthy=False,
                            **kw,
                        )
                    )
                    outcome = r.outcome
                except oc.OtaError as e:
                    outcome = e.code
            _log(
                f"[{name}] outcome={outcome} in {time.monotonic() - t0:.0f}s "
                + json.dumps(r.__dict__ if r else {}, default=str)
            )
            report["phases"][name] = {"outcome": outcome, "result": r.__dict__ if r else None}
            checks.append(oc.Check(f"{name}.{expect}", outcome == expect, outcome))
            return r

        # -- 2. A -> B -------------------------------------------------------------
        if "upgrade" in args.phases:
            r = ota_phase("upgrade", pkgs["pkg_b"], "ok")
            if r:
                st = asyncio.run(_device_state(current_port(), pull_map=True))
                checks.append(
                    oc.Check("upgrade.runs_b", st["fw_version"].endswith("+b"), st["fw_version"])
                )
                checks.append(
                    oc.Check("upgrade.kept_map", st.get("map_sha") == before.get("map_sha"), "")
                )
                checks.append(
                    oc.Check(
                        "upgrade.throughput_reported",
                        (r.throughput_kib_s() or 0) > 0,
                        f"{r.throughput_kib_s()}",
                    )
                )
        # -- 3/4. broken apps roll back; B recovers ---------------------------------
        for name, key in (("crash", "pkg_crash"), ("unhealthy", "pkg_unhealthy")):
            if name in args.phases:
                ota_phase(name, pkgs[key], "rolled_back", health_s=300.0)
                ota_phase(f"{name}_recover", pkgs["pkg_b"], "ok")
        # -- 5. a reset half way through the transfer ------------------------------
        if "powercut" in args.phases:
            size = oc.split_package(pkgs["pkg_a"])[2].size
            fired = {"done": False}

            async def cut(offset: int) -> bool:
                if fired["done"] or offset < size // 2:
                    return False
                fired["done"] = True
                _log(f"[powercut] resetting the DUT at offset {offset}")
                await asyncio.to_thread(reset_dut)
                return True

            r = ota_phase("powercut", pkgs["pkg_a"], "ok", allow_downgrade=True, interrupt=cut)
            checks.append(
                oc.Check(
                    "powercut.resumed",
                    bool(r and r.resumed_from),
                    str(r.resumed_from if r else None),
                )
            )
        # -- 6. a bad signature is refused ------------------------------------------
        if "badsig" in args.phases:
            ota_phase("badsig", pkgs["badsig"], "bad_signature")
            # Nothing was written: the device returns to the app it had (A after the
            # powercut phase, else B), within the loader's refusal grace.
            back = None
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                try:
                    back = asyncio.run(_device_state(current_port(), pull_map=False))
                except Exception as e:  # noqa: BLE001
                    back = {"error": str(e)}
                if back.get("loader") is False:
                    break
                time.sleep(10)
            checks.append(
                oc.Check(
                    "badsig.back_in_the_app",
                    bool(back) and back.get("loader") is False,
                    json.dumps(back),
                )
            )
        # -- 7. key rotation after a compromise -------------------------------------
        if "keyrot" in args.phases:
            ota_phase("keyrot_backup", pkgs["pkg_b_backup"], "ok", key_epoch=epoch_rec)
            ota_phase("keyrot_revoked", pkgs["pkg_a"], "revoked_key", allow_downgrade=True)
            st = None
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                try:
                    st = asyncio.run(_device_state(current_port(), pull_map=False))
                except Exception as e:  # noqa: BLE001
                    st = {"error": str(e)}
                if st.get("loader") is False:
                    break
                time.sleep(10)
            ok = bool(st) and st.get("loader") is False
            ota = (st or {}).get("ota") or {}
            checks.append(oc.Check("keyrot.back_in_the_app", ok, json.dumps(st)))
            checks.append(
                oc.Check(
                    "keyrot.release_key_revoked",
                    ota.get("revoked_keys") == 1 and ota.get("key_epoch") == 1,
                    json.dumps(ota),
                )
            )
    except HarnessError as e:
        _log(f"infrastructure: {e}")
        checks.append(oc.Check("infrastructure", None, str(e)))
    except Exception as e:  # noqa: BLE001 — a DUT that drops off the network mid-gate is a FAIL
        import traceback

        traceback.print_exc()
        checks.append(oc.Check("unexpected", False, f"{type(e).__name__}: {e}"))
    finally:
        try:
            tunnels.close()
        except Exception:  # noqa: BLE001
            pass
        res.release()

    v = oc.verdict(checks)
    for name, text in logs.items():
        _save(args.log_dir, name, text)
    if v == "FAIL":
        _log(res.serial_tail())
    _log(
        "OTA_GATE_JSON "
        + json.dumps({"report": report, "checks": [c.__dict__ for c in checks]}, default=str)
    )
    for c in checks:
        _log(f"  {'PASS' if c.ok else ('SKIP' if c.ok is None else 'FAIL')} {c.name} {c.detail}")
    _log(f"RESULT unit={res._unit} phases={','.join(args.phases)} verdict={v}")
    return 1 if v == "FAIL" else 0


def _progress(name: str):
    last = {"t": 0.0}

    def p(phase: str, info: dict) -> None:
        now = time.monotonic()
        if phase != "transfer" or now - last["t"] > 5 or info.get("offset") == info.get("size"):
            last["t"] = now
            _log(f"  [{name}] {phase} {json.dumps(info)}")

    return p


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: OTA gate (split loader)")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-003f08)")
    ap.add_argument("--phases", default=",".join(PHASES))
    ap.add_argument("--map-leds", type=int, default=120)
    ap.add_argument("--migrate-seconds", type=float, default=25.0)
    ap.add_argument("--boot-seconds", type=float, default=45.0)
    ap.add_argument("--log-dir", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    for k, env in RUNFILES.items():
        ap.add_argument("--" + k.replace("_", "-"), default=_runfile(env))
    args = ap.parse_args()
    args.phases = [p for p in args.phases.split(",") if p]
    if "migrate" not in args.phases:
        raise SystemExit("the gate always starts from migrate (it sets up the device)")
    missing = [k for k in RUNFILES if not getattr(args, k)]
    if missing:
        raise SystemExit(f"missing inputs {missing} (run via bazel run, or pass them)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
