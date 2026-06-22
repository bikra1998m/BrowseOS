#!/usr/bin/env python3
"""Create BrowserOS's boot-compatible Alpine ISO from a verified upstream ISO."""

from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = ROOT / "scripts" / "extract-iso9660.py"
SYSLINUX_CONFIG = b"""SERIAL 0 115200
TIMEOUT 10
PROMPT 0
DEFAULT virt

LABEL virt
MENU LABEL Linux virt
KERNEL /boot/vmlinuz-virt
INITRD /boot/initramfs-virt
FDTDIR /boot/dtbs-virt
APPEND modules=loop,squashfs,sd-mod,usb-storage,virtio_pci,virtio_net,9p,9pnet,9pnet_virtio ip=dhcp quiet noautodetect noapic nolapic
"""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: patch-alpine-iso.py UPSTREAM.iso OUTPUT.iso", file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    destination.parent.mkdir(parents=True, exist_ok=True)

    spec = importlib.util.spec_from_file_location("browseros_iso9660", EXTRACTOR)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load ISO9660 helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    handle, temporary_name = tempfile.mkstemp(
        prefix=destination.name + ".", suffix=".tmp", dir=destination.parent
    )
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        image = module.ISO9660(temporary, writable=True)
        try:
            image.replace("boot/syslinux/syslinux.cfg", SYSLINUX_CONFIG)
        finally:
            image.close()
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(f"Patched Alpine ISO -> {destination} ({sha256(destination)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
