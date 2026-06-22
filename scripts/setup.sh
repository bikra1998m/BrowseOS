#!/usr/bin/env bash
# BrowserOS — one-time setup: fetch the v86 engine + a bootable Linux image.
# These binary assets cannot live inside the HTML file, so we download them
# once into public/vendor and public/images. Multiple mirrors are tried.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/public/vendor"
IMAGES="$ROOT/public/images"
mkdir -p "$VENDOR" "$IMAGES"
# shellcheck source=assets.lock.sh
source "$ROOT/scripts/assets.lock.sh"

say(){ printf "\033[1;34m▶ %s\033[0m\n" "$*"; }
ok(){  printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
err(){ printf "\033[1;31m✗ %s\033[0m\n" "$*"; }

# Print a lowercase SHA-256 digest using common platform tools.
sha256_file(){
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
  else err "No SHA-256 tool found (need sha256sum, shasum, or openssl)"; return 1
  fi
}

verify(){
  local file="$1" expected="$2" actual
  actual="$(sha256_file "$file")" || return 1
  [ "$actual" = "$expected" ] || {
    err "checksum mismatch: $(basename "$file")"
    echo "   expected: $expected" >&2
    echo "   actual:   $actual" >&2
    return 1
  }
}

find_python(){
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# get <dest> <sha256> <url...> — try mirrors, verify, then atomically install.
get(){
  local dest="$1" expected="$2"; shift 2
  if [ -s "$dest" ]; then
    if verify "$dest" "$expected"; then
      ok "verified: $(basename "$dest")"
      return 0
    fi
    say "Replacing outdated or corrupt asset: $(basename "$dest")"
    rm -f "$dest"
  fi
  local url tmp="${dest}.part"
  for url in "$@"; do
    say "downloading $(basename "$dest")  ←  $url"
    rm -f "$tmp"
    if curl -fL --retry 3 -o "$tmp" "$url" && verify "$tmp" "$expected"; then
      mv -f "$tmp" "$dest"
      ok "got + verified $(basename "$dest")"
      return 0
    fi
  done
  rm -f "$tmp"
  err "could not download $(basename "$dest")"; return 1
}

CDN="https://cdn.jsdelivr.net/npm/v86@${V86_VERSION}"
UNPKG="https://unpkg.com/v86@${V86_VERSION}"
RAW="https://raw.githubusercontent.com/copy/v86/${V86_COMMIT}"
IMAGE_CDN="https://cdn.jsdelivr.net/npm/v86@${BUILDROOT_IMAGE_VERSION}"
IMAGE_UNPKG="https://unpkg.com/v86@${BUILDROOT_IMAGE_VERSION}"

say "Fetching v86 engine (WASM)…"
get "$VENDOR/libv86.js" "$LIBV86_SHA256" "$CDN/build/libv86.js" "$UNPKG/build/libv86.js"
get "$VENDOR/v86.wasm" "$V86_WASM_SHA256" "$CDN/build/v86.wasm" "$UNPKG/build/v86.wasm"

say "Fetching BIOS ROMs…"
get "$VENDOR/seabios.bin" "$SEABIOS_SHA256" "$RAW/bios/seabios.bin"
get "$VENDOR/vgabios.bin" "$VGABIOS_SHA256" "$RAW/bios/vgabios.bin"

say "Fetching bootable Linux image (Buildroot, ~5.4 MB, offline-capable)…"
get "$IMAGES/linux.iso" "$BUILDROOT_ISO_SHA256" \
  "$IMAGE_CDN/images/linux.iso" "$IMAGE_UNPKG/images/linux.iso"

# Optional: full Alpine Linux (run: ./scripts/setup.sh --alpine)
if [ "${1:-}" = "--alpine" ]; then
  say "Fetching full Alpine Linux ISO (virt, ~49 MB)…"
  # IMPORTANT: use the -virt kernel. The standard ISO kernel panics in v86
  # (setup_IO_APIC). -virt is tuned for emulated/virtual hardware and boots
  # reliably. Tools are delivered via the virtio-9p tools tree, not an IDE disk.
  BASE="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/x86"
  # If a large standard ISO was fetched before, replace it with the -virt one.
  if [ -s "$IMAGES/alpine.iso" ] && [ "$(stat -c%s "$IMAGES/alpine.iso" 2>/dev/null || echo 0)" -gt 100000000 ]; then
    say "Replacing the standard ISO (panics in v86) with the -virt ISO…"
    rm -f "$IMAGES/alpine.iso"
  fi
  if [ -s "$IMAGES/alpine.iso" ] && verify "$IMAGES/alpine.iso" "$ALPINE_ISO_SHA256"; then
    ok "verified: alpine.iso"
  else
    UPSTREAM="$IMAGES/alpine-upstream.iso"
    if [ -s "$IMAGES/alpine.iso" ] &&
       verify "$IMAGES/alpine.iso" "$ALPINE_UPSTREAM_ISO_SHA256"; then
      mv -f "$IMAGES/alpine.iso" "$UPSTREAM"
    else
      rm -f "$IMAGES/alpine.iso"
      get "$UPSTREAM" "$ALPINE_UPSTREAM_ISO_SHA256" "$BASE/$ALPINE_ISO_NAME"
    fi
    PYTHON="$(find_python)" || {
      err "Python 3 is required to patch Alpine's boot configuration"
      exit 1
    }
    "$PYTHON" "$ROOT/scripts/patch-alpine-iso.py" \
      "$UPSTREAM" "$IMAGES/alpine.iso"
    verify "$IMAGES/alpine.iso" "$ALPINE_ISO_SHA256"
    rm -f "$UPSTREAM"
    ok "patched + verified: alpine.iso"
  fi
  if ! { [ -s "$IMAGES/alpine-vmlinuz-virt" ] &&
         verify "$IMAGES/alpine-vmlinuz-virt" "$ALPINE_KERNEL_SHA256" &&
         [ -s "$IMAGES/alpine-initramfs-virt" ] &&
         verify "$IMAGES/alpine-initramfs-virt" "$ALPINE_INITRAMFS_SHA256"; }; then
    PYTHON="${PYTHON:-$(find_python)}" || {
      err "Python 3 is required to extract Alpine's kernel and initramfs"
      exit 1
    }
    "$PYTHON" "$ROOT/scripts/extract-iso9660.py" "$IMAGES/alpine.iso" \
      "boot/vmlinuz-virt=$IMAGES/alpine-vmlinuz-virt" \
      "boot/initramfs-virt=$IMAGES/alpine-initramfs-virt"
  fi
  verify "$IMAGES/alpine-vmlinuz-virt" "$ALPINE_KERNEL_SHA256"
  verify "$IMAGES/alpine-initramfs-virt" "$ALPINE_INITRAMFS_SHA256"
  ok "Alpine ready. Pick 'Alpine Linux' in the OS dropdown, then Boot."
  echo "   Login: root (no password). Then run 'setup-alpine' to install/configure."
fi

bash "$ROOT/scripts/generate-asset-manifest.sh"

echo
ok "Setup complete. Now run:  ./scripts/start.sh"
echo "   Want full Alpine?  ./scripts/setup.sh --alpine   (recommended: small & fast)"
echo "   Want YOUR own OS?  see scripts/build-custom-image.md"
