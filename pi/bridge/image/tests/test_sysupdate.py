"""splanc_image.sysupdate / sysrelease / nixcache: the full-system OTA logic
against a fake host (Nix, systemd, the network and the bootloader are faked; the
state machine, file layout and every decision are real). The QEMU test
(nix/vm-test-ota.nix) runs the same code against real Nix and systemd."""

import hashlib
import json
import os

import pytest
from splanc_image import nixcache as nc
from splanc_image import sysrelease
from splanc_image import sysupdate as su

CHANNEL = "https://example.test/ota/bridge-system-pi5.json"
BASE = "https://example.test/ota/v1"
KEY = "splanc-bridge-1:" + "A" * 42 + "Q="
H = "0123456789abcdfghijklmnpqrsvwxyz"


def sp(i, name):
    h = (H * 2)[i : i + 32]
    return f"{nc.STORE_DIR}/{h}-{name}"


@pytest.fixture(autouse=True)
def store_dir(tmp_path, monkeypatch):
    root = os.path.realpath(tmp_path)
    monkeypatch.setattr(nc, "STORE_DIR", os.path.join(root, "nix", "store"))
    os.makedirs(nc.STORE_DIR)
    return nc.STORE_DIR


def narinfo(path, refs=(), data=b"nar", sig=True):
    fh = nc.nix32(hashlib.sha256(data).digest())
    lines = [
        f"StorePath: {path}",
        f"URL: nar/{fh}.nar.zst",
        "Compression: zstd",
        f"FileHash: sha256:{fh}",
        f"FileSize: {len(data)}",
        "NarHash: sha256:" + "1" * 52,
        f"NarSize: {len(data) * 3}",
        "References: " + " ".join(os.path.basename(r) for r in refs),
    ]
    if sig:
        lines.append("Sig: splanc-bridge-1:c2lnbmF0dXJl")
    return "\n".join(lines) + "\n"


def make_system(path, board="pi5"):
    os.makedirs(os.path.join(path, "bin"), exist_ok=True)
    stc = os.path.join(path, "bin", "switch-to-configuration")
    with open(stc, "w") as f:
        f.write("#!/bin/sh\n")
    os.chmod(stc, 0o755)
    os.makedirs(os.path.join(path, "etc", "splanc-bridge"), exist_ok=True)
    with open(os.path.join(path, "etc", "splanc-bridge", "image.json"), "w") as f:
        json.dump({"board": board}, f)
    with open(os.path.join(path, "splanc-rpi-config.txt"), "w") as f:
        f.write("[all]\nkernel=kernel.img\nos_prefix=nixos/default/\ndtparam=new=on\n")


class Release:
    """A published release: closure {path: (refs, nar bytes)} -> site files."""

    def __init__(self, top, extra, board="pi5", version="1.3.0", sig=True):
        self.top = top
        self.closure = {top: (extra, b"top-" + top.encode())}
        for p in extra:
            self.closure[p] = ((), b"dep-" + p.encode())
        self.infos = {
            nc.hash_part(p): nc.parse_narinfo(narinfo(p, refs, data, sig))
            for p, (refs, data) in self.closure.items()
        }
        self.manifest = nc.render_manifest(board, version, top, BASE, self.infos.values())
        man = nc.parse_manifest(self.manifest)
        murl = f"{BASE}/bridge-system-{board}-{version}.json"
        self.files = {murl: self.manifest, CHANNEL: nc.render_pointer(man, self.manifest, murl)}
        for p, (_, data) in self.closure.items():
            self.files[f"{BASE}/{self.infos[nc.hash_part(p)].nar_file}"] = data


class FakeHost(su.Host):
    def __init__(self, tmp, profile_dir, firmware):
        self.tmp = tmp
        self.profile_dir = profile_dir
        self.firmware = firmware
        self.files = {}
        self.valid = set()
        self.calls = []
        self.downloads = []
        self.verify_ok = True
        self.fail_boot_for = set()
        self.health = {}
        self.route = True
        self.rebooted = None
        self.clock = 1_000_000.0
        self.mono = 100.0
        self.free = 10 << 30
        self.import_board = "pi5"

    # -- network
    def fetch(self, url, limit):
        self.calls.append(("fetch", url))
        if url not in self.files:
            raise su.UpdateError(f"404 {url}")
        return self.files[url]

    def download(self, url, dest, limit):
        self.downloads.append(url)
        data = self.files[url]
        with open(dest, "wb") as f:
            f.write(data)
        return hashlib.sha256(data).digest()

    # -- clocks
    def now(self):
        return self.clock

    def monotonic(self):
        return self.mono

    def sleep(self, s):
        self.mono += s

    def free_bytes(self, path):
        return self.free

    def has_default_route(self):
        return self.route

    def unit_health(self, unit):
        return self.health.get(unit, (True, 3600.0))

    def booting(self):
        return False

    def reboot(self, tryboot):
        self.rebooted = "tryboot" if tryboot else "reboot"

    # -- nix / systemd
    def _gens(self):
        return sorted(
            int(n.split("-")[1]) for n in os.listdir(self.profile_dir) if n.endswith("-link")
        )

    def run(self, argv):
        self.calls.append(tuple(argv))
        if argv[:2] == ["nix-store", "--check-validity"]:
            return "".join(p + "\n" for p in argv[3:] if p not in self.valid)
        if argv[0] == "nix" and "verify" in argv:
            if not self.verify_ok:
                raise su.UpdateError("path is untrusted")
            return ""
        if argv[0] == "nix" and "copy" in argv:
            top = argv[-1]
            cache = argv[argv.index("--from") + 1][len("file://") :]
            # Only what the cache can provide: every narinfo, NARs for the missing.
            for name in os.listdir(cache):
                if name.endswith(".narinfo"):
                    ni = nc.parse_narinfo(open(os.path.join(cache, name)).read())
                    if ni.store_path not in self.valid:
                        assert os.path.exists(os.path.join(cache, ni.url)), ni.url
                        self.valid.add(ni.store_path)
            make_system(top, self.import_board)
            return ""
        if argv[:2] == ["nix-store", "--add-root"]:
            os.symlink(argv[-1], argv[2])
            return ""
        if argv[:2] == ["nix-store", "--gc"]:
            try:
                with open(os.path.join(self.tmp, "run", "sysupdate-status.json")) as f:
                    self.status_at_gc = json.load(f)
            except OSError:
                pass
            return ""
        if argv[0] == "nix-env":
            prof = argv[2]
            d = os.path.dirname(prof)
            op = argv[3]
            if op == "--set":
                n = max(self._gens(), default=0) + 1
                os.symlink(argv[4], os.path.join(d, f"system-{n}-link"))
                os.unlink(prof)
                os.symlink(f"system-{n}-link", prof)
            elif op == "--switch-generation":
                os.unlink(prof)
                os.symlink(f"system-{argv[4]}-link", prof)
            elif op == "--delete-generations":
                for n in argv[4:]:
                    assert (
                        os.readlink(prof) != f"system-{n}-link"
                    ), "deleting the current generation"
                    os.unlink(os.path.join(d, f"system-{n}-link"))
            return ""
        if argv[0].endswith("/bin/switch-to-configuration"):
            top = os.path.dirname(os.path.dirname(argv[0]))
            if top in self.fail_boot_for:
                raise su.UpdateError("installBootLoader failed")
            # The Pi 5 'kernel' loader: default = this system, plus the newest generation.
            newest = self._gens()[-1]
            target = os.path.realpath(os.path.join(self.profile_dir, f"system-{newest}-link"))
            for name, sys_ in (("default", top), (f"{newest}-default", target)):
                g = os.path.join(self.firmware, "nixos", name)
                os.makedirs(g, exist_ok=True)
                for f in ("kernel.img", "initrd"):
                    open(os.path.join(g, f), "w").close()
                with open(os.path.join(g, "cmdline.txt"), "w") as f:
                    f.write(f"console=tty1 init={sys_}/init\n")
            return ""
        raise AssertionError(f"unexpected command {argv}")


class Bench:
    def __init__(self, tmp, mode="reboot", keys=(KEY,)):
        self.tmp = tmp
        self.prof = os.path.join(tmp, "profiles")
        self.run_dir = os.path.join(tmp, "run")
        self.fw = os.path.join(tmp, "firmware")
        for d in (self.prof, self.run_dir, self.fw):
            os.makedirs(d)
        with open(os.path.join(self.fw, "config.txt"), "w") as f:
            f.write("os_prefix=nixos/default/\n")
        self.a = sp(0, "nixos-system-a")
        make_system(self.a)
        os.symlink(self.a, os.path.join(self.prof, "system-1-link"))
        os.symlink("system-1-link", os.path.join(self.prof, "system"))
        self.boot_into(self.a)
        self.host = FakeHost(tmp, self.prof, self.fw)
        self.host.valid.add(self.a)
        self.shared = sp(1, "glibc")
        self.host.valid.add(self.shared)
        self.cfg = su.Config(
            channel_url=CHANNEL,
            board="pi5",
            public_keys=list(keys),
            boot_mode=mode,
            health_units=["splanc-bridge.service", "splanc-display.service"],
            firmware_dir=self.fw,
        )
        self.bridge_status = os.path.join(self.run_dir, "bridge-status.json")

    def boot_into(self, top):
        for n in ("current", "booted"):
            p = os.path.join(self.run_dir, n)
            if os.path.lexists(p):
                os.unlink(p)
            os.symlink(top, p)

    def updater(self):
        return su.Updater(
            self.cfg,
            self.host,
            state_dir=os.path.join(self.tmp, "state"),
            profile=os.path.join(self.prof, "system"),
            current=os.path.join(self.run_dir, "current"),
            booted=os.path.join(self.run_dir, "booted"),
            bridge_status=self.bridge_status,
            status_out=os.path.join(self.run_dir, "sysupdate-status.json"),
            store=nc.STORE_DIR,
            image_json=os.path.join(self.tmp, "image.json"),
            auto_check=su.auto_check_enabled(os.path.join(self.tmp, "bridge.env")),
        )

    def publish(self, name="nixos-system-b", **kw):
        top = sp(2, name)
        rel = Release(top, [self.shared, sp(3, "new-service")], **kw)
        self.host.files.update(rel.files)
        return rel

    def profile_target(self):
        return os.path.realpath(os.path.join(self.prof, "system"))

    def status(self):
        with open(os.path.join(self.run_dir, "sysupdate-status.json")) as f:
            return json.load(f)

    def busy(self, clients):
        with open(self.bridge_status, "w") as f:
            json.dump({"state": "paired", "clients": clients}, f)


@pytest.fixture
def bench(tmp_path):
    return Bench(os.path.realpath(tmp_path))


# ---- nixcache --------------------------------------------------------------


def test_nix32_matches_nix():
    # nix hash convert --hash-algo sha256 --to nix32 $(printf splanc | sha256sum)
    assert nc.nix32(hashlib.sha256(b"splanc").digest()) == (
        "1smqg1x5p68dxadm6zc87wd03nbz5nmk60vls1gs4ajzz8ka619i"
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.replace("URL: nar/", "URL: ../../etc/"),
        lambda t: t.replace("FileHash: sha256:", "FileHash: md5:"),
        lambda t: "\n".join(ln for ln in t.splitlines() if not ln.startswith("NarSize")),
        lambda t: t.replace("References: ", "References: ../evil "),
        lambda t: t + "StorePath: /nix/store/x\n",
    ],
)
def test_narinfo_parser_is_strict(mutate):
    good = narinfo(sp(0, "x"))
    nc.parse_narinfo(good)
    with pytest.raises(nc.CacheError):
        nc.parse_narinfo(mutate(good))


def test_manifest_closure_needs_every_reference():
    top, dep = sp(0, "top"), sp(1, "dep")
    infos = {nc.hash_part(top): nc.parse_narinfo(narinfo(top, [dep]))}
    man = nc.parse_manifest(nc.render_manifest("pi5", "1.0.0", top, BASE, infos.values()))
    with pytest.raises(nc.CacheError, match="no narinfo"):
        man.closure()


def test_manifest_rejects_http_and_mismatched_keys():
    top = sp(0, "top")
    ni = nc.parse_narinfo(narinfo(top))
    with pytest.raises(nc.CacheError, match="non-https"):
        nc.parse_manifest(nc.render_manifest("pi5", "1.0.0", top, "http://x", [ni]))
    doc = json.loads(nc.render_manifest("pi5", "1.0.0", top, BASE, [ni]))
    doc["narinfo"] = {(H * 2)[5:37]: ni.text}  # keyed by another hash
    with pytest.raises(nc.CacheError):
        nc.parse_manifest(json.dumps(doc).encode())


def test_public_key_file():
    assert nc.parse_public_keys(f"# comment\n\n{KEY}  # the CI key\n") == [KEY]
    with pytest.raises(nc.CacheError):
        nc.parse_public_keys("not-a-key\n")


def test_tryboot_config():
    txt = "[all]\nkernel=kernel.img\nos_prefix=nixos/default/\n[pi5]\nfoo=1\n"
    out = su.tryboot_config(txt, "nixos/7-default")
    assert "os_prefix=nixos/7-default/\n" in out and "nixos/default/" not in out
    assert out.replace("7-default", "default") == txt
    with pytest.raises(su.UpdateError):
        su.tryboot_config("kernel=kernel.img\n", "nixos/7-default")


# ---- sysrelease (CI) -------------------------------------------------------


def write_cache(d, release, sign=True):
    os.makedirs(os.path.join(d, "nar"))
    for p, (refs, data) in release.closure.items():
        text = narinfo(p, refs, data, sig=sign)
        ni = nc.parse_narinfo(text)
        with open(os.path.join(d, ni.hash + ".narinfo"), "w") as f:
            f.write(text)
        with open(os.path.join(d, ni.url), "wb") as f:
            f.write(data)


def test_sysrelease_flattens_a_signed_cache(tmp_path):
    rel = Release(sp(2, "sys"), [sp(3, "dep")])
    cache, out = str(tmp_path / "cache"), str(tmp_path / "out")
    write_cache(cache, rel)
    s = sysrelease.build_manifest(cache, rel.top, "pi5", "1.3.0", BASE, out, "splanc-bridge-1")
    assert s["paths"] == 2 and s["nar_files"] == 2
    assert sorted(os.listdir(out)) == sorted(
        [ni.nar_file for ni in rel.infos.values()] + ["bridge-system-pi5-1.3.0.json"]
    )
    data = open(os.path.join(out, s["manifest"]), "rb").read()
    man = nc.parse_manifest(data)
    assert man.toplevel == rel.top and len(man.closure()) == 2
    ptr_file = str(tmp_path / "ptr.json")
    assert sysrelease.main(["pointer", "--manifest", os.path.join(out, s["manifest"]),
                            "--manifest-url", BASE + "/m.json", "--out", ptr_file]) == 0  # fmt: skip
    ptr = nc.parse_pointer(open(ptr_file, "rb").read())
    assert ptr.manifest_sha256 == hashlib.sha256(data).hexdigest() and ptr.board == "pi5"


def test_sysrelease_refuses_unsigned_or_incomplete(tmp_path):
    rel = Release(sp(2, "sys"), [sp(3, "dep")])
    cache = str(tmp_path / "cache")
    write_cache(cache, rel, sign=False)
    with pytest.raises(nc.CacheError, match="not signed"):
        sysrelease.build_manifest(
            cache, rel.top, "pi5", "1.3.0", BASE, str(tmp_path / "o"), "splanc-bridge-1"
        )
    os.unlink(os.path.join(cache, rel.infos[nc.hash_part(sp(3, "dep"))].url))
    with pytest.raises(nc.CacheError, match="missing"):
        sysrelease.build_manifest(cache, rel.top, "pi5", "1.3.0", BASE, str(tmp_path / "o2"))


# ---- device: check + stage ---------------------------------------------------


def test_disabled_without_a_key(tmp_path):
    b = Bench(os.path.realpath(tmp_path), keys=())
    b.publish()
    assert b.updater().run() == 0
    assert b.updater().install() == 0
    assert b.host.calls == []  # never even looked at the channel
    assert b.status()["state"] == "disabled"


def test_timer_only_discovers_never_downloads_or_installs(bench):
    rel = bench.publish()
    u = bench.updater()
    assert u.run() == 0
    st = u.load_state()
    # Found and sized (pointer + manifest), but not a single NAR fetched.
    assert st["available"]["toplevel"] == rel.top and st["available"]["version"] == "1.3.0"
    assert (st["available"]["paths"], st["available"]["total_paths"]) == (2, 3)
    assert st["available"]["download_bytes"] == sum(
        len(d) for p, (_, d) in rel.closure.items() if p != bench.shared
    )
    assert bench.host.downloads == [] and st["staged"] is None
    assert not [c for c in bench.host.calls if c[0] in ("nix", "nix-env")]
    assert bench.host.rebooted is None and bench.profile_target() == bench.a
    s = bench.status()
    assert s["state"] == "available" and s["available"]["version"] == "1.3.0"
    assert s["checked_at"] == bench.host.clock and s["auto_check"] is True
    # Days later, still idle, still not installed: there is no forced apply any more.
    for _ in range(20):
        bench.host.clock += 86400
        assert u.run() == 0
    assert bench.host.downloads == [] and bench.host.rebooted is None
    # The manifest is fetched once per release, not on every check.
    murl = next(x for x in rel.files if x.endswith("-1.3.0.json"))
    assert sum(1 for c in bench.host.calls if c == ("fetch", murl)) == 1


def test_scan_reports_up_to_date_and_learns_the_running_version(bench):
    rel = bench.publish()
    bench.boot_into(rel.top)
    bench.host.valid.add(rel.top)
    u = bench.updater()
    assert u.scan_now() == 0
    s = bench.status()
    assert s["state"] == "idle" and s["message"] == "up to date (1.3.0)"
    assert s["current_version"] == "1.3.0" and s["available"] is None
    assert bench.host.downloads == []


def test_confirmed_install_downloads_verifies_and_applies(bench):
    rel = bench.publish()
    bench.busy(2)  # an app is connected: the confirmation is what counts
    u = bench.updater()
    assert u.run() == 0 and bench.host.downloads == []
    assert u.install() == 0
    # glibc is already there: its NAR was never downloaded.
    shared = rel.infos[nc.hash_part(bench.shared)].nar_file
    assert (
        all(not x.endswith(shared) for x in bench.host.downloads) and len(bench.host.downloads) == 2
    )
    assert bench.host.rebooted == "reboot"
    assert bench.profile_target() == rel.top
    assert (rel.top + "/bin/switch-to-configuration", "boot") in bench.host.calls
    assert not os.path.exists(os.path.join(bench.tmp, "state", "cache"))  # cleaned up
    st = u.load_state()
    assert st["pending"]["old"] == bench.a and st["pending"]["new"] == rel.top
    assert st["pending"]["old_gen"] == 1 and st["pending"]["new_gen"] == 2
    assert bench.status()["state"] == "rebooting"


def test_cli_check_stages_while_busy_and_waits_for_a_confirmation(bench):
    rel = bench.publish()
    bench.busy(1)
    u = bench.updater()
    assert u.install(when_idle=True) == 0
    st = u.load_state()
    assert st["staged"]["toplevel"] == rel.top and st["pending"] is None
    assert (st["staged"]["fetched_paths"], st["staged"]["total_paths"]) == (2, 3)
    assert bench.host.rebooted is None and bench.profile_target() == bench.a
    s = bench.status()
    assert s["state"] == "staged" and s["staged"] == {"version": "1.3.0"}
    # The app disconnects; the timer still never applies it (no confirmation yet).
    bench.busy(0)
    bench.host.clock += 7 * 86400
    n = len(bench.host.downloads)
    assert u.run() == 0
    assert bench.host.rebooted is None and len(bench.host.downloads) == n
    assert bench.status()["state"] == "staged"
    # Booting again: the screens see the staged update from the saved state.
    os.unlink(os.path.join(bench.run_dir, "sysupdate-status.json"))
    assert bench.updater().publish() == 0
    assert bench.status()["state"] == "staged"
    # The confirmation installs it without downloading anything again.
    assert u.install() == 0
    assert bench.host.rebooted == "reboot" and len(bench.host.downloads) == n


def test_a_second_run_waits_for_the_lock(bench):
    bench.publish()
    u = bench.updater()
    with u.locked():
        assert bench.updater().run() == 0  # the timer skips
        assert bench.updater().install() == 1  # gave up after its wait
    assert bench.host.downloads == []


def test_auto_update_off_still_allows_a_manual_scan(bench, monkeypatch):
    bench.publish()
    monkeypatch.setenv("SPLANC_AUTO_UPDATE", "0")
    assert su.auto_check_enabled("/nonexistent") is False
    u = bench.updater()
    assert u.auto_check is False
    assert u.scan_now() == 0
    assert bench.status()["available"]["version"] == "1.3.0"
    assert bench.status()["auto_check"] is False


def test_auto_update_setting_from_the_flash_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("SPLANC_AUTO_UPDATE", raising=False)
    env = tmp_path / "bridge.env"
    env.write_text("SPLANC_RELAY=wss://x\nSPLANC_AUTO_UPDATE=0\n")
    assert su.auto_check_enabled(str(env)) is False
    env.write_text("SPLANC_AUTO_UPDATE=1\n")
    assert su.auto_check_enabled(str(env)) is True
    assert su.auto_check_enabled(str(tmp_path / "missing")) is True


def test_signature_failure_imports_nothing(bench):
    bench.publish()
    bench.host.verify_ok = False
    u = bench.updater()
    assert u.install() == 1
    st = u.load_state()
    assert "not signed by a trusted key" in st["last_result"]["message"]
    assert not [c for c in bench.host.calls if c[0] == "nix" and "copy" in c]
    assert st["staged"] is None and bench.profile_target() == bench.a
    assert not os.path.exists(os.path.join(bench.tmp, "state", "cache"))
    # The keys passed to Nix are exactly the image's.
    verify = next(c for c in bench.host.calls if c[0] == "nix" and "verify" in c)
    assert verify[verify.index("trusted-public-keys") + 1] == KEY
    # Never a narinfo Nix remembered from an earlier release at the same cache URL.
    assert verify[verify.index("narinfo-cache-positive-ttl") + 1] == "0"
    assert bench.status()["state"] == "failed"
    # A failed background check is retried after retry_interval, not every 15 minutes.
    bench.host.files.clear()
    assert u.run() == 1
    n = len(bench.host.calls)
    u.run()
    assert len(bench.host.calls) == n


def test_tampered_nar_is_rejected(bench):
    rel = bench.publish()
    nar = next(u for u in rel.files if u.endswith(".nar.zst") and "dep-" not in u)
    bench.host.files[nar] = b"evil"
    assert bench.updater().install() == 1
    assert bench.profile_target() == bench.a
    assert not [c for c in bench.host.calls if c[0] == "nix"]


def test_manifest_hash_and_board_are_checked(bench):
    rel = bench.publish()
    murl = next(u for u in rel.files if u.endswith(".json") and u != CHANNEL)
    bench.host.files[murl] += b" "
    u = bench.updater()
    assert u.run() == 1 and "sha256" in u.load_state()["last_result"]["message"]
    assert u.install() == 1 and "sha256" in u.load_state()["last_result"]["message"]
    b2 = Bench(os.path.join(bench.tmp, "other"))
    b2.publish(board="pi4")
    assert b2.updater().scan_now() == 1
    assert "board" in b2.updater().load_state()["last_result"]["message"]


def test_imported_system_for_another_board_is_not_applied(bench):
    bench.publish()
    bench.host.import_board = "pi4"
    assert bench.updater().install() == 1
    assert bench.profile_target() == bench.a and bench.host.rebooted is None


def test_up_to_date_and_known_bad(bench):
    rel = bench.publish()
    u = bench.updater()
    st = u.load_state()
    st["bad"] = [rel.top]
    u.save_state(st)
    assert u.install() == 0 and u.scan_now() == 0
    assert bench.host.downloads == [] and bench.host.rebooted is None
    assert u.load_state()["available"] is None
    assert "failed on this bridge before" in bench.status()["message"]


def test_low_space_drops_old_generations_first(bench):
    bench.publish()
    bench.host.free = 1
    assert bench.updater().install() == 1
    assert ("nix-store", "--gc") in bench.host.calls
    assert "not enough space" in bench.updater().load_state()["last_result"]["message"]


# ---- device: apply ----------------------------------------------------------


def test_apply_failure_restores_the_old_system(bench):
    rel = bench.publish()
    bench.host.fail_boot_for.add(rel.top)
    u = bench.updater()
    assert u.install() == 1
    st = u.load_state()
    assert bench.profile_target() == bench.a and sorted(os.listdir(bench.prof)) == [
        "system",
        "system-1-link",
    ]
    assert st["pending"] is None and rel.top in st["bad"]
    assert (bench.a + "/bin/switch-to-configuration", "boot") in bench.host.calls
    assert bench.host.rebooted is None


def test_tryboot_apply_keeps_the_old_default(tmp_path):
    b = Bench(os.path.realpath(tmp_path), mode="tryboot")
    rel = b.publish()
    assert b.updater().install() == 0
    assert b.host.rebooted == "tryboot"
    # The OLD system's installer ran (default entry + config.txt stay old) ...
    assert (b.a + "/bin/switch-to-configuration", "boot") in b.host.calls
    assert (rel.top + "/bin/switch-to-configuration", "boot") not in b.host.calls
    assert f"init={b.a}/init" in open(os.path.join(b.fw, "nixos/default/cmdline.txt")).read()
    # ... and tryboot.txt boots generation 2 once, with the NEW config.txt.
    tb = open(os.path.join(b.fw, "tryboot.txt")).read()
    assert "os_prefix=nixos/2-default/" in tb and "dtparam=new=on" in tb


# ---- device: confirm ----------------------------------------------------------


def applied(bench, mode="reboot"):
    rel = bench.publish()
    u = bench.updater()
    assert u.install() == 0 and bench.host.rebooted
    bench.host.rebooted = None
    bench.boot_into(rel.top)
    return rel, u


def test_healthy_new_system_is_committed(bench):
    rel, u = applied(bench)
    # an older generation lying around is pruned (keep current + previous)
    os.symlink(bench.a, os.path.join(bench.prof, "system-0-link"))
    assert u.confirm() == 0
    st = u.load_state()
    assert st["pending"] is None and st["last_result"]["result"] == "committed"
    assert st["last_result"]["fetched_paths"] == 2
    s = bench.status()
    assert s["state"] == "idle" and s["current_version"] == "1.3.0" and s["available"] is None
    assert bench.host.status_at_gc["state"] == "idle"  # already before the (slow) GC
    assert sorted(os.listdir(bench.prof)) == ["system", "system-1-link", "system-2-link"]
    assert bench.profile_target() == rel.top and bench.host.rebooted is None
    assert ("nix-store", "--gc") in bench.host.calls
    assert not os.path.lexists(os.path.join(bench.tmp, "state", "staged-system"))
    assert u.confirm() == 0  # nothing pending: no-op


def test_unhealthy_new_system_rolls_back(bench):
    rel, u = applied(bench)
    bench.host.health["splanc-display.service"] = (False, 0.0)
    assert u.confirm() == 1
    st = u.load_state()
    assert bench.host.rebooted == "reboot"
    assert bench.profile_target() == bench.a
    assert sorted(os.listdir(bench.prof)) == ["system", "system-1-link"]
    assert rel.top in st["bad"] and st["pending"] is None and st["available"] is None
    assert "splanc-display.service not up" in st["last_result"]["message"]
    assert (bench.a + "/bin/switch-to-configuration", "boot") in bench.host.calls
    # waited the whole health timeout before giving up
    assert bench.host.mono >= 100 + bench.cfg.health_timeout


def test_restarting_unit_and_lost_network_are_unhealthy(bench):
    rel, u = applied(bench)
    bench.host.health["splanc-bridge.service"] = (True, 2.0)  # just restarted again
    assert u.confirm() == 1
    rel2 = Bench(os.path.join(bench.tmp, "b2"))
    rel2_, u2 = applied(rel2)
    rel2.host.route = False
    assert u2.confirm() == 1
    assert "no network" in u2.load_state()["last_result"]["message"]


def test_units_already_broken_before_the_update_dont_count(bench):
    bench.host.health["splanc-display.service"] = (False, 0.0)  # e.g. a broken HAT
    rel, u = applied(bench)
    assert u.confirm() == 0
    assert u.load_state()["last_result"]["result"] == "committed"


def test_booting_the_old_system_with_an_update_pending_rolls_back_quietly(tmp_path):
    b = Bench(os.path.realpath(tmp_path), mode="tryboot")
    rel = b.publish()
    u = b.updater()
    u.install()
    b.host.rebooted = None
    # tryboot fell back: the firmware booted config.txt = the old system.
    assert u.confirm() == 1
    st = u.load_state()
    assert b.host.rebooted is None and st["pending"] is None and rel.top in st["bad"]
    assert b.profile_target() == b.a
    assert not os.path.exists(os.path.join(b.fw, "tryboot.txt"))


def test_tryboot_commit_makes_the_new_system_the_default(tmp_path):
    b = Bench(os.path.realpath(tmp_path), mode="tryboot")
    rel, u = applied(b)
    assert u.confirm() == 0
    assert f"init={rel.top}/init" in open(os.path.join(b.fw, "nixos/default/cmdline.txt")).read()
    assert not os.path.exists(os.path.join(b.fw, "tryboot.txt"))


def test_boot_loop_gives_up(bench):
    rel, u = applied(bench)
    st = u.load_state()
    st["pending"]["attempts"] = su.MAX_BOOT_ATTEMPTS
    u.save_state(st)
    assert u.confirm() == 1 and bench.host.rebooted == "reboot"
    assert "boots" in u.load_state()["last_result"]["message"]


def test_crash_before_the_generation_was_recorded(bench):
    rel = bench.publish()
    u = bench.updater()
    bench.busy(1)
    u.install(when_idle=True)
    st = u.load_state()
    # apply() got as far as `nix-env --set`, then the power went.
    st["pending"] = {
        "old": bench.a,
        "old_gen": 1,
        "new": rel.top,
        "new_gen": None,
        "mode": "reboot",
    }
    u.save_state(st)
    bench.host.run(["nix-env", "-p", os.path.join(bench.prof, "system"), "--set", rel.top])
    assert u.confirm() == 1
    assert sorted(os.listdir(bench.prof)) == ["system", "system-1-link"]
    assert bench.profile_target() == bench.a and bench.host.rebooted is None
