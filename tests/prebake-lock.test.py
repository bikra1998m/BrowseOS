#!/usr/bin/env python3
"""Focused offline tests for the deterministic APK lock tooling."""

import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "prebake" / "build-repo.py"
SPEC = importlib.util.spec_from_file_location("browseros_build_repo", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


sample = """P:one
V:1.0-r0
D:two>=2 so:libc.musl-x86.so.1
p:cmd:one=1

P:two
V:2.0-r1
"""
packages, provides, filenames = MODULE.parse_index(sample, "main")
assert packages["two"]["filename"] == "two-2.0-r1.apk"  # final entry flushes at EOF
assert provides["cmd:one"] == "one"
assert filenames["one-1.0-r0.apk"]["repo"] == "main"
assert MODULE.dependency_name("two>=2") == "two"

resolved, missing = MODULE.resolve(packages, provides | {
    wanted: "one" for wanted in MODULE.WANT
})
assert "one" in resolved
assert "two" in resolved
assert "so:libc.musl-x86.so.1" in missing

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "atomic.txt"
    MODULE.atomic_write(path, b"locked")
    assert path.read_bytes() == b"locked"

lock = json.loads((ROOT / "prebake" / "packages.lock.json").read_text(encoding="utf-8"))
entries = MODULE.validate_lock(lock)
assert entries
assert entries == sorted(entries, key=lambda package: package["filename"])

print("prebake lock tooling checks passed")
