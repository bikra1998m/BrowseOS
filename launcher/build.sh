#!/usr/bin/env bash
# Build prerequisite-free BrowserOS binaries for Windows, macOS, and Linux.
# Output: launcher/dist/  (each file is fully self-contained, no runtime deps)
#
# By default this BUNDLES Alpine Linux inside every binary (the shared .exe
# then includes the full apk distro, not just Buildroot).
#   ./build.sh              → bundle Alpine (downloads it if missing)
#   ./build.sh --lite       → skip Alpine, embed only Buildroot (smaller)
set -euo pipefail
cd "$(dirname "$0")"

LITE=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

say(){ printf "\033[1;34m▶ %s\033[0m\n" "$*"; }
ok(){  printf "\033[1;32m✓ %s\033[0m\n" "$*"; }

# 1) Make sure the OS images we want to embed are present in ../public/images.
if [ "$LITE" -eq 0 ]; then
  say "Verifying the pinned Alpine image before embedding it…"
  ( cd .. && ./scripts/setup.sh --alpine )
  ok "Alpine will be bundled ($(du -h ../public/images/alpine.iso | cut -f1))"
fi
# 2) The Go program embeds ../public, so copy it in for the build context.
#    (Honor --lite by excluding the big optional images from the copy.)
rm -rf public && mkdir -p public
cleanup(){ rm -rf public; }
trap cleanup EXIT
cp -r ../public/. ./public/
if [ "$LITE" -eq 1 ]; then
  rm -f public/images/alpine.iso \
        public/images/alpine-vmlinuz-virt public/images/alpine-initramfs-virt \
        public/images/alpine-preinstalled.bin public/images/alpine-preinstalled.json
  rm -rf public/images/tools9p public/images/tools9p.json
fi

mkdir -p dist
echo
say "Building self-contained binaries (embedding $(du -sh public/images | cut -f1) of OS images)…"

build() { # GOOS GOARCH out
  echo "  → $3"
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -buildvcs=false -trimpath -ldflags "-s -w" -o "dist/$3" .
}

build linux   amd64 "BrowserOS-linux-x64"
build linux   arm64 "BrowserOS-linux-arm64"
build darwin  amd64 "BrowserOS-macos-intel"
build darwin  arm64 "BrowserOS-macos-apple-silicon"
build windows amd64 "BrowserOS-windows-x64.exe"

rm -rf public
trap - EXIT
echo
ok "Done. Distributable binaries are in launcher/dist/ :"
ls -lh dist/
echo
echo "Each file is fully self-contained — users just double-click / run it."
[ "$LITE" -eq 0 ] && echo "Alpine is bundled: the default boot is a full apk-based Linux, offline."
