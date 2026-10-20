"""Disk enumeration: only removable media is ever offered (captured OS output)."""

import json
import plistlib

import pytest
from splanc_flasher import disks, flash


def mac_info(**kw):
    base = {
        "Internal": False,
        "RemovableMediaOrExternalDevice": True,
        "MediaName": "SD Card Reader",
        "TotalSize": 31_914_983_424,
        "BusProtocol": "USB",
        "VirtualOrPhysical": "Physical",
    }
    base.update(kw)
    return plistlib.dumps(base)


def test_macos_external_sd_is_offered_as_raw_node():
    ds = disks.parse_macos(plistlib.dumps({"WholeDisks": ["disk4"]}), {"disk4": mac_info()})
    assert [d.id for d in ds] == ["/dev/rdisk4"]
    assert ds[0].bus == "USB" and round(ds[0].size_gb) == 32


@pytest.mark.parametrize(
    "info",
    [
        {"Internal": True, "MediaName": "APPLE SSD"},
        {"RemovableMediaOrExternalDevice": False, "Ejectable": False},
        {"VirtualOrPhysical": "Virtual"},
        {"BusProtocol": "Disk Image"},
        {"TotalSize": 0},  # reader without a card
    ],
)
def test_macos_refuses(info):
    ds = disks.parse_macos(plistlib.dumps({"WholeDisks": ["disk0"]}), {"disk0": mac_info(**info)})
    assert ds == []


def test_macos_missing_info_is_skipped():
    assert disks.parse_macos(plistlib.dumps({"WholeDisks": ["disk9"]}), {}) == []


def win(n, **kw):
    d = {
        "Number": n,
        "FriendlyName": "Generic STORAGE DEVICE",
        "Size": 15_931_539_456,
        "BusType": "USB",
        "IsSystem": False,
        "IsBoot": False,
        "IsReadOnly": False,
    }
    d.update(kw)
    return d


def test_windows_filters_system_boot_readonly_and_bus():
    js = json.dumps(
        [
            win(1),
            win(0, IsSystem=True, IsBoot=True, FriendlyName="NVMe"),
            win(2, IsReadOnly=True),
            win(3, BusType="SATA"),
            win(4, BusType="SD", Size=0),
            win(5, BusType="SD"),
        ]
    )
    assert [d.id for d in disks.parse_windows(js)] == [r"\\.\PhysicalDrive1", r"\\.\PhysicalDrive5"]


def test_windows_single_object_and_empty():
    assert len(disks.parse_windows(json.dumps(win(2)))) == 1
    assert disks.parse_windows("") == []


def lsblk(*devs):
    return json.dumps({"blockdevices": list(devs)})


def blk(name, **kw):
    d = {
        "name": name,
        "model": "SD/MMC",
        "size": 31_914_983_424,
        "rm": True,
        "hotplug": True,
        "type": "disk",
        "tran": "usb",
        "ro": False,
        "mountpoints": [None],
    }
    d.update(kw)
    return d


def test_linux_removable_only():
    js = lsblk(
        blk("sda", rm=False, hotplug=False, model="Samsung SSD"),
        blk("sdb"),
        blk("mmcblk0", tran=None),
        blk("loop0", type="loop"),
        blk("zram0"),
        blk("sdc", ro=True),
        blk("sdd", size=0),
    )
    assert [d.id for d in disks.parse_linux(js)] == ["/dev/sdb", "/dev/mmcblk0"]


def test_linux_never_offers_the_running_system_even_if_hotplug():
    # e.g. a laptop booted from a USB stick: / lives on a "removable" disk.
    root = blk(
        "sdb",
        children=[
            {"name": "sdb1", "mountpoints": ["/boot"]},
            {"name": "sdb2", "mountpoints": ["/"]},
        ],
    )
    swap = blk("sdc", children=[{"name": "sdc1", "mountpoints": ["[SWAP]"]}])
    old_lsblk = blk("sdd", mountpoints=None, children=[{"name": "sdd1", "mountpoint": "/home"}])
    media = blk("sde", children=[{"name": "sde1", "mountpoints": ["/media/me/boot"]}])
    assert [d.id for d in disks.parse_linux(lsblk(root, swap, old_lsblk, media))] == ["/dev/sde"]


def test_size_helpers():
    d = disks.Disk(id="/dev/sdb", name="x", size=8 * 10**9, removable=True)
    assert d.fits(2 * 10**9) and not d.fits(9 * 10**9)
    assert not d.large
    assert disks.Disk(id="/dev/sdb", name="x", size=500 * 10**9, removable=True).large
    assert d.to_dict()["size_gb"] == 8.0


def test_flash_refuses_a_disk_that_is_not_currently_listed(monkeypatch, tmp_path):
    img = tmp_path / "a.img"
    img.write_bytes(b"\0" * 4096)
    monkeypatch.setattr(flash, "find_disk", lambda _id: None)
    with pytest.raises(flash.FlashError, match="no longer connected"):
        flash.flash(str(img), "/dev/sda", {})


def test_flash_refuses_a_card_smaller_than_the_image(monkeypatch, tmp_path):
    img = tmp_path / "a.img"
    img.write_bytes(b"\0" * 8192)
    small = disks.Disk(id="/dev/sdz", name="Tiny", size=4096, removable=True)
    monkeypatch.setattr(flash, "find_disk", lambda _id: small)
    called = []
    monkeypatch.setattr(flash.subprocess, "Popen", lambda *a, **k: called.append(a))
    with pytest.raises(flash.FlashError, match="smaller than the image"):
        flash.flash(str(img), "/dev/sdz", {})
    assert called == []  # never elevated, never wrote
