#!/usr/bin/env python3
"""Create/verify BrowserOS's locked Alpine package bundle.

Normal use is deterministic:
    python build-repo.py             # materialize the checked-in lock
    python build-repo.py --check     # offline integrity check

Updating dependencies is explicit:
    python build-repo.py --update-lock

The update command fetches Alpine APKINDEX archives, resolves WANT plus
dependencies, downloads each APK, and rewrites packages.lock.json with exact
filenames, sizes, repositories, and SHA-256 hashes.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request

FORMAT = 1
ARCH = "x86"
ALPINE_VERSION = "3.24"
BASE = f"https://dl-cdn.alpinelinux.org/alpine/v{ALPINE_VERSION}"
REPOS = ("main", "community")
HERE = Path(__file__).resolve().parent
OUT = HERE / "apks" / ARCH
LOCK = HERE / "packages.lock.json"
USER_AGENT = "BrowserOS-prebake/1"

WANT_GROUPS = {
    "base": [
        "bash", "sudo", "git", "curl", "wget", "nano", "vim", "less",
        "python3", "py3-pip", "htop", "procps", "net-tools",
        "coreutils", "grep", "sed", "tar", "gzip", "openssl", "ca-certificates",
        "bash-completion", "shadow",
    ],
    # Guest graphical desktop and browser. Firefox runs inside v86's Alpine VM,
    # not in or through the host browser UI.
    "firefox": [
        "alpine-base", "busybox-binsh",
        "firefox-esr", "xorg-server", "xinit", "openbox",
        "xf86-video-vesa", "xf86-input-libinput",
        "font-dejavu", "adwaita-icon-theme", "dbus", "dbus-x11",
        "xsetroot", "xrandr",
    ],
}
WANT = list(dict.fromkeys(
    package for group in WANT_GROUPS.values() for package in group
))


def request_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def parse_index(text: str, repo: str) -> tuple[dict, dict, dict]:
    packages: dict[str, dict] = {}
    provides: dict[str, str] = {}
    filenames: dict[str, dict] = {}
    current: dict[str, str] = {}

    def flush() -> None:
        if not current.get("P") or not current.get("V"):
            current.clear()
            return
        package = dict(current)
        package["repo"] = repo
        package["filename"] = f"{package['P']}-{package['V']}.apk"
        packages[package["P"]] = package
        filenames[package["filename"]] = package
        provides.setdefault(package["P"], package["P"])
        for token in package.get("p", "").split():
            provides[token.split("=", 1)[0]] = package["P"]
        current.clear()

    for line in text.splitlines():
        if not line.strip():
            flush()
            continue
        key, separator, value = line.partition(":")
        if not separator:
            continue
        if key in ("D", "p"):
            current[key] = (current.get(key, "") + " " + value).strip()
        else:
            current[key] = value
    flush()
    return packages, provides, filenames


def fetch_indexes() -> tuple[dict, dict, dict]:
    all_packages: dict[str, dict] = {}
    all_provides: dict[str, str] = {}
    all_filenames: dict[str, dict] = {}
    for repo in REPOS:
        url = f"{BASE}/{repo}/{ARCH}/APKINDEX.tar.gz"
        print(f"Fetching {url}")
        archive = request_bytes(url)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            member = tar.extractfile("APKINDEX")
            if member is None:
                raise RuntimeError(f"{url} does not contain APKINDEX")
            text = member.read().decode("utf-8", errors="replace")
        packages, provides, filenames = parse_index(text, repo)
        all_packages.update(packages)
        all_provides.update(provides)
        all_filenames.update(filenames)
    print(f"Loaded {len(all_packages)} packages and {len(all_provides)} provides")
    return all_packages, all_provides, all_filenames


def dependency_name(token: str) -> str:
    value = token.strip()
    for operator in (">=", "<=", "=", ">", "<", "~"):
        if operator in value:
            value = value.split(operator, 1)[0]
    return value


def resolve(
    packages: dict, provides: dict, wanted: list[str] | None = None
) -> tuple[dict, set[str]]:
    wanted = WANT if wanted is None else wanted
    unresolved_wants = sorted(
        requested
        for requested in wanted
        if requested not in packages and requested not in provides
    )
    if unresolved_wants:
        raise RuntimeError("Requested packages were not resolved: " + ", ".join(unresolved_wants))

    resolved: dict[str, dict] = {}
    missing: set[str] = set()
    queue = list(wanted)
    while queue:
        requested = queue.pop()
        package_name = provides.get(requested) or (
            requested if requested in packages else None
        )
        if not package_name:
            missing.add(requested)
            continue
        if package_name in resolved:
            continue
        package = packages[package_name]
        resolved[package_name] = package
        for dependency in package.get("D", "").split():
            name = dependency_name(dependency)
            # Absolute-path dependencies such as /bin/sh are supplied by the
            # Alpine live base. Resolving them to an arbitrary APK provider can
            # replace BusyBox's shell (for example with yash-binsh).
            if name and not name.startswith(("!", "/")):
                queue.append(name)
    return resolved, missing


def validate_lock(lock: dict) -> list[dict]:
    if lock.get("format") != FORMAT:
        raise RuntimeError(f"Unsupported lock format: {lock.get('format')!r}")
    if lock.get("alpine_version") != ALPINE_VERSION or lock.get("arch") != ARCH:
        raise RuntimeError(
            "Lock targets Alpine "
            f"{lock.get('alpine_version')}/{lock.get('arch')}, expected "
            f"{ALPINE_VERSION}/{ARCH}"
        )
    packages = lock.get("packages")
    if not isinstance(packages, list) or not packages:
        raise RuntimeError("Lock has no packages")
    seen: set[str] = set()
    for package in packages:
        filename = package.get("filename", "")
        digest = package.get("sha256", "")
        size = package.get("size")
        if (
            not filename.endswith(".apk")
            or Path(filename).name != filename
            or len(digest) != 64
            or not isinstance(size, int)
            or size <= 0
            or filename in seen
        ):
            raise RuntimeError(f"Invalid lock entry: {package!r}")
        seen.add(filename)
    return sorted(packages, key=lambda package: package["filename"])


def load_lock() -> tuple[dict, list[dict]]:
    if not LOCK.exists():
        raise RuntimeError(
            f"{LOCK.name} is missing. Restore it from source control or run "
            "--lock-existing/--update-lock intentionally."
        )
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    return lock, validate_lock(lock)


def verify_package(path: Path, package: dict) -> None:
    actual_size = path.stat().st_size
    if actual_size != package["size"]:
        raise RuntimeError(
            f"{path.name}: size {actual_size}, expected {package['size']}"
        )
    actual_hash = sha256_file(path)
    if actual_hash != package["sha256"]:
        raise RuntimeError(
            f"{path.name}: SHA-256 {actual_hash}, expected {package['sha256']}"
        )


def download_locked_package(package: dict) -> bytes:
    repositories = [package["repository"]] if package.get("repository") else list(REPOS)
    errors = []
    for repo in repositories:
        url = f"{BASE}/{repo}/{ARCH}/{package['filename']}"
        try:
            data = request_bytes(url)
        except (urllib.error.URLError, TimeoutError) as error:
            errors.append(f"{repo}: {error}")
            continue
        if len(data) != package["size"] or sha256_bytes(data) != package["sha256"]:
            errors.append(f"{repo}: downloaded bytes do not match the lock")
            continue
        print(f"  + {package['filename']} ({len(data) // 1024} KiB, {repo})")
        return data
    raise RuntimeError(
        f"Could not fetch locked package {package['filename']}: " + "; ".join(errors)
    )


def materialize(check_only: bool) -> None:
    _, packages = load_lock()
    OUT.mkdir(parents=True, exist_ok=True)
    locked_names = {package["filename"] for package in packages}
    unexpected = sorted(path.name for path in OUT.glob("*.apk") if path.name not in locked_names)
    if unexpected:
        raise RuntimeError(
            "Unexpected APKs would make the 9p image non-reproducible: "
            + ", ".join(unexpected)
        )

    for package in packages:
        destination = OUT / package["filename"]
        if destination.exists():
            verify_package(destination, package)
            continue
        if check_only:
            raise RuntimeError(f"Locked package is missing: {destination}")
        atomic_write(destination, download_locked_package(package))
        verify_package(destination, package)
    print(f"Verified {len(packages)} locked APKs in {OUT}")


def package_metadata(path: Path) -> dict[str, str]:
    with tarfile.open(path, mode="r:*") as archive:
        member = archive.extractfile(".PKGINFO")
        if member is None:
            raise RuntimeError(f"{path.name} has no .PKGINFO")
        values = {}
        for line in member.read().decode("utf-8", errors="replace").splitlines():
            key, separator, value = line.partition(" = ")
            if separator and key in {"pkgname", "pkgver", "origin", "commit"}:
                values.setdefault(key, value)
        return values


def write_lock(entries: list[dict], source: str) -> None:
    lock = {
        "format": FORMAT,
        "alpine_version": ALPINE_VERSION,
        "arch": ARCH,
        "repositories": list(REPOS),
        "requested": WANT,
        "requested_groups": WANT_GROUPS,
        "source": source,
        "packages": sorted(entries, key=lambda package: package["filename"]),
    }
    validate_lock(lock)
    encoded = (json.dumps(lock, indent=2, sort_keys=True) + "\n").encode("utf-8")
    atomic_write(LOCK, encoded)
    print(f"Wrote {LOCK} with {len(entries)} packages")


def lock_existing() -> None:
    files = sorted(OUT.glob("*.apk"))
    if not files:
        raise RuntimeError(f"No APKs found in {OUT}")
    entries = []
    for path in files:
        metadata = package_metadata(path)
        entries.append({
            "filename": path.name,
            "package": metadata.get("pkgname", ""),
            "version": metadata.get("pkgver", ""),
            "origin": metadata.get("origin", ""),
            "commit": metadata.get("commit", ""),
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    write_lock(entries, "existing verified APK bundle")
    materialize(check_only=True)


def update_lock() -> None:
    packages, provides, _ = fetch_indexes()
    resolved: dict[str, dict] = {}
    package_groups: dict[str, set[str]] = {}
    missing: set[str] = set()
    for group, wanted in WANT_GROUPS.items():
        group_resolved, group_missing = resolve(packages, provides, wanted)
        missing.update(group_missing)
        for name, package in group_resolved.items():
            resolved[name] = package
            package_groups.setdefault(name, set()).add(group)
    if missing:
        print(
            "Base/virtual dependencies not present in APKINDEX: "
            + ", ".join(sorted(missing))
        )
    OUT.mkdir(parents=True, exist_ok=True)
    existing_entries = {}
    if LOCK.exists():
        try:
            _, current = load_lock()
            existing_entries = {entry["filename"]: entry for entry in current}
        except Exception:
            existing_entries = {}
    entries = []
    for name, package in sorted(resolved.items()):
        filename = package["filename"]
        destination = OUT / filename
        url = f"{BASE}/{package['repo']}/{ARCH}/{filename}"
        existing = existing_entries.get(filename)
        if destination.exists() and existing:
            verify_package(destination, existing)
            size = existing["size"]
            data_hash = existing["sha256"]
            print(f"  = {filename} ({size // 1024} KiB)")
        else:
            data = request_bytes(url)
            atomic_write(destination, data)
            data_hash = sha256_bytes(data)
            size = len(data)
            print(f"  + {filename} ({size // 1024} KiB)")
        entries.append({
            "filename": filename,
            "package": name,
            "version": package["V"],
            "repository": package["repo"],
            "groups": sorted(package_groups[name]),
            "size": size,
            "sha256": data_hash,
        })
    write_lock(entries, "Alpine APKINDEX dependency resolution")
    wanted_names = {entry["filename"] for entry in entries}
    for stale in OUT.glob("*.apk"):
        if stale.name not in wanted_names:
            print(f"  - removing stale package {stale.name}")
            stale.unlink()
    materialize(check_only=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify lock and APKs without network")
    mode.add_argument(
        "--update-lock",
        action="store_true",
        help="resolve dependencies from Alpine indexes and rewrite the lock",
    )
    mode.add_argument(
        "--lock-existing",
        action="store_true",
        help="create a lock from the APK files already present (no network)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.update_lock:
            update_lock()
        elif args.lock_existing:
            lock_existing()
        else:
            materialize(check_only=args.check)
        return 0
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
