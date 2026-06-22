#!/usr/bin/env bash
# BrowserOS — one command to (re)build EVERYTHING correctly.
# Run after downloading or after any change:  ./rebuild-all.sh
set -euo pipefail
cd "$(dirname "$0")"

say(){ printf "\n\033[1;36m== %s ==\033[0m\n" "$*"; }

PY=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
[ -n "$PY" ] || { echo "Python 3 is required to rebuild BrowserOS." >&2; exit 1; }

say "1/4  Verifying the pinned Alpine ISO and emulator assets"
./scripts/setup.sh --alpine

say "2/4  Materializing and verifying the locked APK bundle"
"$PY" prebake/build-repo.py

say "3/4  Regenerating the 9p tools filesystem (with latest install.sh)"
"$PY" prebake/make-9p.py
bash ./scripts/generate-asset-manifest.sh

# Show what install.sh we just baked, so you can confirm it's the new one.
say "Verifying install.sh has the progress bar"
if grep -q "install.sh started" public/images/tools9p/* 2>/dev/null; then
  echo "  OK: new install.sh (with progress bar) is in the 9p tree"
else
  echo "  WARNING: could not confirm new install.sh — check prebake/make-9p.py"
fi

say "4/4  Building the self-contained binary"
( cd launcher && { ./build.sh; } )

say "DONE"
echo "Run it with:   ./launcher/dist/BrowserOS-windows-x64.exe"
echo "Then open http://127.0.0.1:8086 in a PRIVATE/Incognito window."
