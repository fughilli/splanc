"""Over-the-air update client + the OTA gate's verdicts (docs/design/ota.md).

`push()` drives one update through any `Link` (a wss session that can be reopened):
the app's handoff (ota_begin -> REBOOTING -> reconnect to the loader), the
stop-and-wait chunk stream with resume (a dropped link or a device reset re-sends
ota_begin and continues from the offset the loader reports), ota_finish, and the
wait for the new app to prove healthy (or for the loader to report the rollback).
The same client is what the HITL gate (hitl_ota.py) and a developer
(`ota_push.py --url ...`) use; tests/test_ota_core.py runs it against a simulated
device (app + loader + slot + rollback).

The `.ota` package is the 108-byte signed manifest followed by the image.
"""

from __future__ import annotations

import asyncio
import hashlib
import struct
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

import ledmapper_pb2 as pb

MANIFEST_LEN = 108

MODE_APP = pb.OtaStatus.MODE_APP
MODE_LOADER = pb.OtaStatus.MODE_LOADER
IDLE = pb.OtaStatus.STATE_IDLE
REBOOTING = pb.OtaStatus.STATE_REBOOTING
RECEIVING = pb.OtaStatus.STATE_RECEIVING
INSTALLED = pb.OtaStatus.STATE_INSTALLED
FAILED = pb.OtaStatus.STATE_FAILED
DOWNLOADING = pb.OtaStatus.STATE_DOWNLOADING
VERIFYING = pb.OtaStatus.STATE_VERIFYING


class OtaError(RuntimeError):
    """The update failed; `code` is the device's refusal code (or a client one)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass
class Manifest:
    version: int
    size: int
    sha256: bytes
    flags: int
    signature: bytes

    @staticmethod
    def parse(b: bytes) -> "Manifest":
        if len(b) != MANIFEST_LEN:
            raise OtaError("bad_package", f"manifest is {len(b)} bytes, want {MANIFEST_LEN}")
        version, size = struct.unpack_from("<II", b, 0)
        (flags,) = struct.unpack_from("<I", b, 40)
        return Manifest(version, size, b[8:40], flags, b[44:])


def split_package(pkg: bytes) -> tuple[bytes, bytes, Manifest]:
    """`.ota` -> (manifest bytes, image, parsed manifest); checks the image matches."""
    if len(pkg) <= MANIFEST_LEN:
        raise OtaError("bad_package", "too short")
    manifest, image = pkg[:MANIFEST_LEN], pkg[MANIFEST_LEN:]
    m = Manifest.parse(manifest)
    if m.size != len(image) or hashlib.sha256(image).digest() != m.sha256:
        raise OtaError("bad_package", "image does not match its manifest")
    return manifest, image, m


def client(**arm: Any) -> bytes:
    """ClientMessage with one arm, e.g. client(ota_chunk=pb.OtaChunk(...))."""
    return pb.ClientMessage(**arm).SerializeToString()


def server(raw: bytes) -> tuple[str, Any]:
    m = pb.ServerMessage.FromString(raw)
    arm = m.WhichOneof("msg")
    return arm or "", getattr(m, arm) if arm else None


class Link(Protocol):
    """A reconnectable session to the device (wss in the field and on the rig)."""

    async def open(self, deadline: float) -> pb.Welcome:
        """(Re)connect and do hello -> welcome, retrying until `deadline`."""

    async def send(self, frame: bytes) -> None: ...

    async def recv(self, timeout: float) -> bytes: ...

    async def close(self) -> None: ...


class LinkDropped(ConnectionError):
    pass


async def rpc(link: Link, frame: bytes, want: str = "ota_status", timeout: float = 30.0) -> Any:
    await link.send(frame)
    end = time.monotonic() + timeout
    while True:
        left = end - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"no {want} reply")
        arm, msg = server(await link.recv(left))
        if arm == want:
            return msg
        if arm == "error":
            raise OtaError(msg.code or "error", msg.message)


def in_loader(w: pb.Welcome) -> bool:
    return w.HasField("ota") and w.ota.mode == MODE_LOADER


@dataclass
class PushResult:
    """What happened, for logs and the gate's verdicts."""

    version: int = 0
    size: int = 0
    handoff_s: float | None = None  # app -> loader (welcome in the loader)
    transfer_s: float | None = None
    bytes_sent: int = 0
    resumes: int = 0
    resumed_from: list[int] = field(default_factory=list)
    finish_s: float | None = None
    boot_s: float | None = None  # INSTALLED -> the new app's welcome
    healthy_s: float | None = None  # -> last_result "ok"
    final: dict[str, Any] = field(default_factory=dict)  # last ota_status, as a dict
    outcome: str = ""  # "ok" | "rolled_back" | a refusal code

    def throughput_kib_s(self) -> float | None:
        if not self.transfer_s:
            return None
        return self.bytes_sent / 1024 / self.transfer_s


def status_dict(st: Any) -> dict[str, Any]:
    return {
        "mode": pb.OtaStatus.Mode.Name(st.mode),
        "state": pb.OtaStatus.State.Name(st.state),
        "version": st.version,
        "size": st.size,
        "offset": st.offset,
        "error": st.error,
        "app_version": st.app_version,
        "app_fw_version": st.app_fw_version,
        "loader_reason": st.loader_reason,
        "last_result": st.last_result,
        "loader_version": st.loader_version,
        "key_epoch": st.key_epoch,
        "revoked_keys": st.revoked_keys,
        "security_floor": st.security_floor,
        "board": st.board,
    }


Progress = Callable[[str, dict[str, Any]], None]


def _noop(_phase: str, _info: dict[str, Any]) -> None:
    pass


async def push(
    link: Link,
    pkg: bytes,
    *,
    allow_downgrade: bool = False,
    progress: Progress = _noop,
    reconnect_s: float = 120.0,
    health_s: float = 240.0,
    max_resumes: int = 8,
    chunk_bytes: int | None = None,
    interrupt: Callable[[int], Awaitable[bool]] | None = None,
    expect_healthy: bool = True,
    key_epoch: bytes = b"",
) -> PushResult:
    """Install `pkg` on the device behind `link`. Raises OtaError on a refusal.

    `interrupt(offset)` (tests/HITL) is awaited after each acknowledged chunk; when it
    returns True the link is treated as dropped (the caller cut power or the link), and
    the transfer resumes. With `expect_healthy=False` the call returns as soon as the
    outcome is known (a rollback is then the expected end, not an error).
    """
    manifest, image, m = split_package(pkg)
    r = PushResult(version=m.version, size=m.size)
    t0 = time.monotonic()
    w = await link.open(time.monotonic() + reconnect_s)
    st = await rpc(link, client(get_ota_status=pb.GetOtaStatus()))
    if st.error == "legacy_layout":
        raise OtaError("legacy_layout", "this device needs the one-time USB migration first")
    if not in_loader(w):
        progress("handoff", {"from": status_dict(st)})
        st = await rpc(
            link,
            client(
                ota_begin=pb.OtaBegin(
                    manifest=manifest, allow_downgrade=allow_downgrade, key_epoch=key_epoch
                )
            ),
        )
        if st.state == FAILED:
            raise OtaError(st.error, "refused by the app")
        if st.state != REBOOTING:
            raise OtaError(
                "protocol", f"app answered ota_begin with {pb.OtaStatus.State.Name(st.state)}"
            )
        await link.close()
        w = await _reopen_until(link, lambda w: in_loader(w), reconnect_s, "the loader")
        r.handoff_s = time.monotonic() - t0

    # In the loader: begin (or resume) and stream.
    t1 = time.monotonic()
    offset = None
    while True:
        try:
            if offset is None:
                st = await rpc(
                    link,
                    client(
                        ota_begin=pb.OtaBegin(
                            manifest=manifest, allow_downgrade=allow_downgrade, key_epoch=key_epoch
                        )
                    ),
                )
                if st.state == FAILED:
                    r.final = status_dict(st)
                    r.outcome = st.error
                    raise OtaError(st.error, "refused by the loader")
                offset = st.offset
                if offset:
                    r.resumed_from.append(offset)
                chunk = min(chunk_bytes or st.max_chunk or 4096, st.max_chunk or 4096)
                progress("transfer", {"offset": offset, "size": m.size})
            while offset < m.size:
                end = min(offset + chunk, m.size)
                st = await rpc(
                    link, client(ota_chunk=pb.OtaChunk(offset=offset, data=image[offset:end]))
                )
                if st.state == FAILED and st.error != "out_of_order":
                    r.final = status_dict(st)
                    r.outcome = st.error
                    raise OtaError(st.error, f"chunk at {offset}")
                r.bytes_sent += end - offset if st.state != FAILED else 0
                offset = st.offset
                progress("transfer", {"offset": offset, "size": m.size})
                if interrupt is not None and await interrupt(offset):
                    raise LinkDropped("interrupted")
            break
        except (LinkDropped, TimeoutError, ConnectionError, OSError) as e:
            r.resumes += 1
            if r.resumes > max_resumes:
                raise OtaError("link", f"gave up after {max_resumes} resumes: {e}") from e
            progress("resume", {"after": str(e), "resumes": r.resumes})
            await link.close()
            w = await _reopen_until(
                link, lambda w: in_loader(w), reconnect_s, "the loader (resume)"
            )
            offset = None
    r.transfer_s = time.monotonic() - t1

    t2 = time.monotonic()
    st = await rpc(link, client(ota_finish=pb.OtaFinish()), timeout=60.0)
    r.finish_s = time.monotonic() - t2
    if st.state != INSTALLED:
        r.final = status_dict(st)
        r.outcome = st.error or "not_installed"
        raise OtaError(r.outcome, "finish refused")
    progress("installed", {"version": m.version})
    await link.close()

    # The new app boots pending verify; it marks itself valid once healthy, or the
    # bootloader / its health check rolls it back to the loader.
    t3 = time.monotonic()
    end = t3 + health_s
    while True:
        w = await _reopen_until(
            link, lambda w: True, max(5.0, end - time.monotonic()), "the device"
        )
        if r.boot_s is None and not in_loader(w):
            r.boot_s = time.monotonic() - t3
        try:
            st = await rpc(link, client(get_ota_status=pb.GetOtaStatus()))
        except (TimeoutError, ConnectionError, OSError):
            st = None
        if st is not None:
            r.final = status_dict(st)
            if st.mode == MODE_LOADER and st.last_result == "rolled_back":
                r.outcome = "rolled_back"
                progress("rolled_back", r.final)
                break
            if st.mode == MODE_APP and st.last_result == "ok" and st.app_version == m.version:
                r.outcome = "ok"
                r.healthy_s = time.monotonic() - t3
                progress("healthy", r.final)
                break
            if st.mode == MODE_LOADER and st.loader_reason in ("no_app", "incomplete"):
                r.outcome = st.loader_reason
                break
        if time.monotonic() >= end:
            r.outcome = r.outcome or "timeout"
            break
        await link.close()
        await asyncio.sleep(3.0)
    await link.close()
    if expect_healthy and r.outcome != "ok":
        raise OtaError(r.outcome, f"after install: {r.final}")
    return r


def pulls_image(w: pb.Welcome) -> bool:
    """A Splanc MAX (docs/design/max-ota.md): it downloads its own image."""
    return "ota_pull" in list(w.features)


async def pull(
    link: Link,
    manifest: bytes,
    *,
    source_url: str = "",
    allow_downgrade: bool = False,
    key_epoch: bytes = b"",
    progress: Progress = _noop,
    within_s: float = 1800.0,
    poll_s: float = 2.0,
    expect_healthy: bool = True,
    interrupt: Callable[[dict[str, Any]], Awaitable[bool]] | None = None,
) -> PushResult:
    """Update a PULL device (Splanc MAX): send only the 108-byte manifest, then follow
    the device's own download -> import -> reboot into the new system ONCE -> health
    check over get_ota_status, reconnecting through every reboot. Mirrors
    web/src/net/otaUpdate.ts pullUpdate. `interrupt(status)` (HITL) is awaited after
    every status read; True = the caller cut the power, keep polling."""
    m = Manifest.parse(manifest[:MANIFEST_LEN])
    r = PushResult(version=m.version, size=m.size)
    t0 = time.monotonic()
    await link.open(time.monotonic() + 120)
    st = await rpc(
        link,
        client(
            ota_begin=pb.OtaBegin(
                manifest=manifest[:MANIFEST_LEN],
                allow_downgrade=allow_downgrade,
                key_epoch=key_epoch,
                source_url=source_url,
            )
        ),
    )
    r.final = status_dict(st)
    if st.state == FAILED:
        r.outcome = st.error
        raise OtaError(st.error, "refused")
    progress("download", {"offset": st.offset, "size": m.size})
    installed = False
    end = t0 + within_s
    while True:
        if st is not None:
            r.final = status_dict(st)
            if st.state == FAILED and not installed:
                r.outcome = st.error
                raise OtaError(st.error, "failed on the device")
            if st.state == DOWNLOADING:
                r.bytes_sent = st.offset
                progress("download", {"offset": st.offset, "size": m.size})
            elif st.state in (VERIFYING, INSTALLED):
                if r.transfer_s is None:
                    r.transfer_s = time.monotonic() - t0
                    r.bytes_sent = m.size
                if st.state == INSTALLED and not installed:
                    installed = True
                    r.finish_s = time.monotonic() - t0
                    progress("installed", {"version": m.version})
            elif st.state == IDLE:
                if st.last_result == "ok" and st.app_version == m.version:
                    r.outcome = "ok"
                    r.healthy_s = time.monotonic() - t0
                    progress("healthy", r.final)
                    break
                if st.last_result == "rolled_back" and (installed or st.version == m.version):
                    r.outcome = "rolled_back"
                    progress("rolled_back", r.final)
                    break
                if st.last_result == "installed":
                    if not installed:
                        installed = True
                        r.finish_s = time.monotonic() - t0
                    if r.boot_s is None:
                        r.boot_s = time.monotonic() - t0
                        progress("trial", r.final)
                elif st.last_result == "aborted":
                    r.outcome = "aborted"
                    raise OtaError("aborted", "cancelled on the device")
            if interrupt is not None and await interrupt(r.final):
                r.resumes += 1
        if time.monotonic() >= end:
            r.outcome = r.outcome or "timeout"
            break
        await asyncio.sleep(poll_s)
        try:
            st = await rpc(link, client(get_ota_status=pb.GetOtaStatus()), timeout=15.0)
        except (OtaError, TimeoutError, ConnectionError, OSError, LinkDropped):
            st = None
            r.resumes += 1
            await link.close()
            try:
                await link.open(min(end, time.monotonic() + 60))
            except (TimeoutError, ConnectionError, OSError):
                pass
    await link.close()
    if expect_healthy and r.outcome != "ok":
        raise OtaError(r.outcome, f"after install: {r.final}")
    return r


async def _reopen_until(
    link: Link, ok: Callable[[pb.Welcome], bool], within: float, what: str
) -> pb.Welcome:
    end = time.monotonic() + within
    last = None
    while time.monotonic() < end:
        try:
            w = await link.open(end)
        except (TimeoutError, ConnectionError, OSError) as e:
            last = e
            await asyncio.sleep(1.0)
            continue
        if ok(w):
            return w
        await link.close()
        await asyncio.sleep(2.0)
    raise OtaError("timeout", f"never reached {what} ({last})")


# -- the HITL gate's verdicts -------------------------------------------------------


@dataclass
class Check:
    name: str
    ok: bool | None  # None = skipped (infrastructure, not a firmware verdict)
    detail: str = ""


def verdict(checks: list[Check]) -> str:
    """FAIL if any check failed; SKIP if nothing could be checked; else PASS."""
    if any(c.ok is False for c in checks):
        return "FAIL"
    if not any(c.ok for c in checks):
        return "SKIP"
    return "PASS"


def migration_checks(before: dict[str, Any], after: dict[str, Any]) -> list[Check]:
    """The one-time USB migration kept the device's state: same Wi-Fi (it rejoined
    with no provisioning), the same TLS identity (cert pin), the same stored map."""
    out = []
    out.append(
        Check(
            "migrate.rejoined_without_provisioning", bool(after.get("leased")), after.get("ip", "")
        )
    )
    if before.get("cert_sha256"):
        out.append(
            Check(
                "migrate.same_tls_identity",
                after.get("cert_sha256") == before.get("cert_sha256"),
                f"{before.get('cert_sha256', '')[:12]} -> {after.get('cert_sha256', '')[:12]}",
            )
        )
    if before.get("map_leds"):
        out.append(
            Check(
                "migrate.same_map",
                after.get("map_leds") == before.get("map_leds")
                and after.get("map_sha") == before.get("map_sha"),
                f"{before.get('map_leds')} LEDs -> {after.get('map_leds')}",
            )
        )
    out.append(
        Check(
            "migrate.loader_copied_littlefs",
            after.get("migrated_files", 0) > 0,
            str(after.get("migrated_files")),
        )
    )
    return out
