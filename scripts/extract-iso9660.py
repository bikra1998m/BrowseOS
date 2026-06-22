#!/usr/bin/env python3
"""Extract files from a plain ISO9660 image using only the Python standard library."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile

SECTOR_SIZE = 2048


def comparable_name(name: str) -> str:
    """Match common ISO9660-mangled names without requiring Rock Ridge."""
    return name.rstrip(".").replace("_", "-").casefold()


def directory_record(data: bytes) -> tuple[int, int, bool, str]:
    if len(data) < 34:
        raise ValueError("truncated ISO9660 directory record")
    extent = int.from_bytes(data[2:6], "little")
    size = int.from_bytes(data[10:14], "little")
    is_directory = bool(data[25] & 0x02)
    name_length = data[32]
    name_bytes = data[33:33 + name_length]
    if name_bytes == b"\x00":
        name = "."
    elif name_bytes == b"\x01":
        name = ".."
    else:
        name = name_bytes.decode("ascii").split(";", 1)[0]
    return extent, size, is_directory, name


class ISO9660:
    def __init__(self, path: Path, writable: bool = False):
        self.path = path
        self.file = path.open("r+b" if writable else "rb")
        self.writable = writable
        self.root = self._read_root()

    def close(self) -> None:
        self.file.close()

    def _read_root(self) -> tuple[int, int, bool, str]:
        for sector in range(16, 256):
            self.file.seek(sector * SECTOR_SIZE)
            descriptor = self.file.read(SECTOR_SIZE)
            if len(descriptor) != SECTOR_SIZE or descriptor[1:6] != b"CD001":
                raise ValueError("not a supported ISO9660 image")
            descriptor_type = descriptor[0]
            if descriptor_type == 1:
                length = descriptor[156]
                return directory_record(descriptor[156:156 + length])
            if descriptor_type == 255:
                break
        raise ValueError("ISO9660 primary volume descriptor not found")

    def _entries_with_offsets(self, record: tuple[int, int, bool, str]):
        extent, size, is_directory, _ = record
        if not is_directory:
            raise ValueError("path component is not a directory")
        directory_offset = extent * SECTOR_SIZE
        self.file.seek(directory_offset)
        data = self.file.read(size)
        offset = 0
        while offset < len(data):
            length = data[offset]
            if length == 0:
                offset = ((offset // SECTOR_SIZE) + 1) * SECTOR_SIZE
                continue
            raw = data[offset:offset + length]
            if len(raw) != length:
                raise ValueError("truncated ISO9660 directory")
            yield directory_record(raw), directory_offset + offset
            offset += length

    def _entries(self, record: tuple[int, int, bool, str]):
        for entry, _ in self._entries_with_offsets(record):
            yield entry

    def find_record(self, source: str) -> tuple[tuple[int, int, bool, str], int]:
        current = self.root
        current_offset = 156
        for component in [part for part in source.replace("\\", "/").split("/") if part]:
            wanted = comparable_name(component)
            match = next(
                (
                    item
                    for item in self._entries_with_offsets(current)
                    if comparable_name(item[0][3]) == wanted
                ),
                None,
            )
            if match is None:
                raise FileNotFoundError(f"{source}: {component!r} not found in ISO")
            current, current_offset = match
        return current, current_offset

    def find(self, source: str) -> tuple[int, int, bool, str]:
        return self.find_record(source)[0]

    def replace(self, source: str, data: bytes) -> None:
        if not self.writable:
            raise PermissionError("ISO image was not opened for writing")
        (extent, old_size, is_directory, _), record_offset = self.find_record(source)
        if is_directory:
            raise IsADirectoryError(source)
        allocated = ((old_size + SECTOR_SIZE - 1) // SECTOR_SIZE) * SECTOR_SIZE
        if len(data) > allocated:
            raise ValueError(
                f"{source}: replacement is {len(data)} bytes, allocated extent is {allocated}"
            )
        self.file.seek(extent * SECTOR_SIZE)
        self.file.write(data)
        self.file.write(b"\x00" * (allocated - len(data)))
        self.file.seek(record_offset + 10)
        self.file.write(len(data).to_bytes(4, "little"))
        self.file.write(len(data).to_bytes(4, "big"))
        self.file.flush()
        os.fsync(self.file.fileno())

    def extract(self, source: str, destination: Path) -> None:
        extent, size, is_directory, _ = self.find(source)
        if is_directory:
            raise IsADirectoryError(source)
        self.file.seek(extent * SECTOR_SIZE)
        destination.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(
            prefix=destination.name + ".", suffix=".tmp", dir=destination.parent
        )
        try:
            with os.fdopen(handle, "wb") as output:
                remaining = size
                while remaining:
                    chunk = self.file.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError(f"{source}: unexpected end of ISO")
                    output.write(chunk)
                    remaining -= len(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        except Exception:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: extract-iso9660.py IMAGE.iso SOURCE=DEST [SOURCE=DEST ...]",
            file=sys.stderr,
        )
        return 2
    image = ISO9660(Path(sys.argv[1]))
    try:
        for mapping in sys.argv[2:]:
            source, separator, destination = mapping.partition("=")
            if not separator or not source or not destination:
                raise ValueError(f"invalid extraction mapping: {mapping!r}")
            image.extract(source, Path(destination))
            print(f"Extracted {source} -> {destination}")
    finally:
        image.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
