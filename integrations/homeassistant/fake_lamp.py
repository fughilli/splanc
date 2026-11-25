"""An in-process fake Splanc lamp: wss://127.0.0.1:<port>/ws with a self-signed
certificate, speaking the binary protobuf envelopes, with the netstack's
one-session takeover rule (firmware/player_app/session_takeover.h):

- one live session; a newcomer takes over an IDLE one (the old one gets WS
  close 4001), a BUSY one refuses the newcomer;
- power_state is pushed only to sessions that sent a power arm.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import ssl
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from custom_components.splanc import protocol as p


def make_cert(directory: Path, cn: str = "splanc-test") -> tuple[Path, Path, str]:
    """A self-signed EC P-256 cert like the lamp's; returns (cert, key, sha256)."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = dt.datetime.now(dt.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )
    cp, kp = directory / f"{cn}.crt", directory / f"{cn}.key"
    cp.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    kp.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return cp, kp, hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


@dataclass
class Session:
    ws: web.WebSocketResponse
    subscribed: bool = False
    busy: bool = False
    received: list[tuple[int, dict]] = field(default_factory=list)


class FakeLamp:
    def __init__(
        self, *, mac: str = "AA:BB:CC:00:11:22", name: str = "Coil", power: bool = True
    ) -> None:
        self.mac = mac
        self.name = name
        self.features = ["effects", "keypoints", "decks"] + (["power"] if power else [])
        self.on = True
        self.brightness = 0.8
        self.effect_id = "aurora"
        self.keypoints = ["Calm", "Party"]
        self.seq = 1
        self.trigger_count = 0
        self.source = p.SOURCE_BOOT
        self.session: Session | None = None
        self.log: list[tuple[int, dict]] = []  # every client message (arm, fields)
        self.connects = 0
        self.refused = 0
        self._tmp = tempfile.TemporaryDirectory()
        self._runner: web.AppRunner | None = None
        self.port = 0
        self.fingerprint = ""
        self._cn = 0

    @property
    def host(self) -> str:
        return f"127.0.0.1:{self.port}"

    async def start(self, port: int = 0) -> None:
        self._cn += 1
        cert, key, self.fingerprint = make_cert(Path(self._tmp.name), f"lamp{self._cn}")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        app = web.Application()
        app.router.add_get("/ws", self._handle)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", port, ssl_context=ctx)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]

    async def restart_with_new_cert(self) -> None:
        """A factory reset: same lamp, same port, a new certificate."""
        port = self.port
        await self.stop()
        await self.start(port)

    async def stop(self) -> None:
        if self.session is not None:
            await self.session.ws.close()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    # -- state ------------------------------------------------------------------

    def power_state(self) -> p.PowerState:
        return p.PowerState(
            on=self.on,
            phase=p.PHASE_ON if self.on else p.PHASE_OFF,
            brightness=self.brightness,
            effect_id=self.effect_id,
            source=self.source,
            toggle_trigger="touch_tap",
            trigger_count=self.trigger_count,
            seq=self.seq,
        )

    def welcome(self) -> bytes:
        return p.encode_welcome(
            p.Welcome(
                session_id="s1",
                mac=self.mac,
                device_name=self.name,
                brightness=self.brightness,
                fw_version="1.20.0",
                features=self.features,
            )
        )

    async def push(self) -> None:
        s = self.session
        if s is not None and s.subscribed and "power" in self.features and not s.ws.closed:
            await s.ws.send_bytes(p.encode_power_state(self.power_state()))

    async def tap(self) -> None:
        """A tap on the lid: the toggle trigger fires."""
        self.on = not self.on
        self.trigger_count += 1
        self.source = p.SOURCE_TRIGGER
        self.seq += 1
        await self.push()

    async def change_effect(self, effect_id: str, keypoints: list[str]) -> None:
        self.effect_id = effect_id
        self.keypoints = keypoints
        self.seq += 1
        await self.push()

    def sent(self, arm: int) -> list[dict]:
        return [f for a, f in self.log if a == arm]

    # -- the wire ---------------------------------------------------------------

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        old = self.session
        if old is not None and not old.ws.closed:
            if old.busy:
                self.refused += 1
                raise web.HTTPServiceUnavailable()  # the firmware RSTs; any refusal will do
            await old.ws.close(code=4001, message=b"taken over by another client")
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        s = Session(ws)
        self.session = s
        self.connects += 1
        async for msg in ws:
            if msg.type != WSMsgType.BINARY:
                continue
            arm, body = p.decode_client(msg.data)
            s.received.append((arm, body))
            self.log.append((arm, body))
            await self._answer(s, arm, body)
        if self.session is s:
            self.session = None
        return ws

    async def _answer(self, s: Session, arm: int, body: dict) -> None:
        ws = s.ws
        if arm == p.C_HELLO:
            await ws.send_bytes(self.welcome())
        elif arm in (p.C_GET_POWER, p.C_SET_POWER):
            if "power" not in self.features:
                await ws.send_bytes(p.encode_error("unsupported", "no power"))
                return
            s.subscribed = True
            if arm == p.C_SET_POWER:
                on = bool(body.get(1, [0])[0])
                if body.get(2):
                    on = not self.on
                if on != self.on:
                    self.on = on
                    self.seq += 1
                self.source = p.SOURCE_CLIENT
            await ws.send_bytes(p.encode_power_state(self.power_state()))
        elif arm == p.C_SET_BRIGHTNESS:
            self.brightness = p.unpack_double(body[1][0]) if 1 in body else 0.0
            self.seq += 1
            await ws.send_bytes(self.welcome())
            await self.push()
        elif arm == p.C_LIST_KEYPOINTS:
            await ws.send_bytes(
                p.encode_keypoint_list(
                    p.KeypointList(effect_id=self.effect_id, names=self.keypoints, capacity=16)
                )
            )
        elif arm == p.C_BLEND_KEYPOINTS:
            await ws.send_bytes(
                p.encode_playback(p.PlaybackState(active=True, effect=self.effect_id))
            )
        else:
            await ws.send_bytes(p.encode_error("unsupported", f"arm {arm}"))

    async def phone_connects(self, *, busy: bool = False) -> asyncio.Task:
        """The phone app opens a session (taking over an idle one). Returns the
        task holding the phone's socket open; cancel it to 'close the app'."""
        import aiohttp

        ready = asyncio.Event()
        result: dict = {}

        async def run() -> None:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            async with aiohttp.ClientSession() as sess:
                async with sess.ws_connect(f"wss://{self.host}/ws", ssl=ctx) as ws:
                    await ws.send_bytes(p.hello("phone", "1"))
                    await ws.receive()
                    if self.session is not None:
                        self.session.busy = busy
                    result["ok"] = True
                    ready.set()
                    async for _ in ws:
                        pass

        task = asyncio.get_running_loop().create_task(run())
        await asyncio.wait_for(ready.wait(), 5)
        return task
