#!/usr/bin/env python3
"""Verify checked-in setup assets against scripts/assets.lock.sh."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1]
text = (ROOT / "scripts" / "assets.lock.sh").read_text(encoding="utf-8")
values = dict(re.findall(r'^([A-Z0-9_]+)="([^"]*)"$', text, flags=re.MULTILINE))
assert values["ALPINE_VERSION"] == "3.24"
assert values["ALPINE_RELEASE"] == "3.24.1"
assert "DEBIAN" not in text

assets = {
    "LIBV86_SHA256": ROOT / "public" / "vendor" / "libv86.js",
    "V86_WASM_SHA256": ROOT / "public" / "vendor" / "v86.wasm",
    "SEABIOS_SHA256": ROOT / "public" / "vendor" / "seabios.bin",
    "VGABIOS_SHA256": ROOT / "public" / "vendor" / "vgabios.bin",
    "BUILDROOT_ISO_SHA256": ROOT / "public" / "images" / "linux.iso",
    "ALPINE_ISO_SHA256": ROOT / "public" / "images" / "alpine.iso",
    "ALPINE_KERNEL_SHA256": ROOT / "public" / "images" / "alpine-vmlinuz-virt",
    "ALPINE_INITRAMFS_SHA256": ROOT / "public" / "images" / "alpine-initramfs-virt",
}

for variable, path in assets.items():
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert values[variable] == actual, f"{path.name}: {actual} != {values[variable]}"

setup = (ROOT / "scripts" / "setup.sh").read_text(encoding="utf-8")
assert "releases/latest" not in setup
assert "/master" not in setup
assert "source \"$ROOT/scripts/assets.lock.sh\"" in setup
assert "verify \"$tmp\" \"$expected\"" in setup
assert "extract-iso9660.py" in setup
assert "--debian" not in setup

launcher = (ROOT / "launcher" / "build.sh").read_text(encoding="utf-8")
assert "--with-debian" not in launcher

app = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
index = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
manifest = (ROOT / "public" / "asset-manifest.js").read_text(encoding="utf-8")
manifest_match = re.search(r"Object\.freeze\((\{.*\})\);", manifest, flags=re.DOTALL)
assert manifest_match
manifest_values = json.loads(manifest_match.group(1))

expected_urls = {
    "libv86": ("vendor/libv86.js", "LIBV86_SHA256"),
    "wasm": ("vendor/v86.wasm", "V86_WASM_SHA256"),
    "bios": ("vendor/seabios.bin", "SEABIOS_SHA256"),
    "vgaBios": ("vendor/vgabios.bin", "VGABIOS_SHA256"),
    "buildrootIso": ("images/linux.iso", "BUILDROOT_ISO_SHA256"),
    "alpineIso": ("images/alpine.iso", "ALPINE_ISO_SHA256"),
    "alpineKernel": ("images/alpine-vmlinuz-virt", "ALPINE_KERNEL_SHA256"),
    "alpineInitramfs": (
        "images/alpine-initramfs-virt",
        "ALPINE_INITRAMFS_SHA256",
    ),
}
for key, (path, variable) in expected_urls.items():
    assert manifest_values[key] == f"{path}?v={values[variable]}"

tools_hash = hashlib.sha256(
    (ROOT / "public" / "images" / "tools9p.json").read_bytes()
).hexdigest()
assert manifest_values["tools9pJson"] == f"images/tools9p.json?v={tools_hash}"
assert manifest_values["alpineVersion"] == values["ALPINE_RELEASE"]
assert manifest_values["preinstalledState"] is None
assert manifest_values["preinstalledStateMeta"] is None

assert "alpineVersion: ASSETS.alpineVersion" in app
assert "opts.boot_order = 0x123" in app
assert "opts.bzimage = { url: CFG.alpineKernel }" not in app
assert "patch-alpine-iso.py" in setup
assert "ALPINE_UPSTREAM_ISO_SHA256" in values
assert "noautodetect" in app
assert "savedMachine.osVersion !== CFG.alpineVersion" in app
assert "machine.osVersion !== CFG.alpineVersion" in app
assert "debian" not in app.lower()
assert 'value="debian"' not in index.lower()
assert '<script src="asset-loader.js"></script>' in index
assert '<script src="vendor/libv86.js' not in index
assert "generate-asset-manifest.sh" in setup
assert "generate-asset-manifest.sh" in (
    ROOT / "rebuild-all.sh"
).read_text(encoding="utf-8")

extractor_path = ROOT / "scripts" / "extract-iso9660.py"
spec = importlib.util.spec_from_file_location("browseros_iso9660", extractor_path)
assert spec and spec.loader
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)
with tempfile.TemporaryDirectory() as temporary:
    temporary = Path(temporary)
    image = extractor.ISO9660(ROOT / "public" / "images" / "alpine.iso")
    try:
        for source, checked_in in (
            ("boot/vmlinuz-virt", assets["ALPINE_KERNEL_SHA256"]),
            ("boot/initramfs-virt", assets["ALPINE_INITRAMFS_SHA256"]),
        ):
            extracted = temporary / checked_in.name
            image.extract(source, extracted)
            assert extracted.read_bytes() == checked_in.read_bytes()
        syslinux = temporary / "syslinux.cfg"
        image.extract("boot/syslinux/syslinux.cfg", syslinux)
        syslinux_text = syslinux.read_text(encoding="ascii")
        assert "noautodetect" in syslinux_text
        assert "noapic nolapic" in syslinux_text
        assert "ip=dhcp" in syslinux_text
        assert "PROMPT 0" in syslinux_text
        assert "console=ttyS0" not in syslinux_text
    finally:
        image.close()

print("setup asset lock checks passed")
