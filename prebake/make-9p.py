#!/usr/bin/env python3
"""Build a v86 virtio-9p filesystem tree from the downloaded apks, so the
guest (alpine-virt, which supports virtio-9p) can mount it WITHOUT needing any
block-device driver. v86 serves files from a flat dir + a fs.json index.

Output:
  ../public/images/tools9p/        (flat content-addressed files)
  ../public/images/tools9p.json    (the 9pfs index v86 loads)

The fs.json format used by v86 (copy/fs2json) is a nested array tree:
  [name, size, mtime, mode, uid, gid, [children...]]   for dirs
  [name, size, mtime, mode, uid, gid, sha256, version]  for files
We generate a minimal compatible tree containing /apks/*.apk plus setup and
guest-application launch scripts.
"""
import os, hashlib, json, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APKS = os.path.join(HERE, "apks", "x86")
OUT_DIR = os.path.join(HERE, "..", "public", "images", "tools9p")
OUT_JSON = os.path.join(HERE, "..", "public", "images", "tools9p.json")
LOCK = os.path.join(HERE, "packages.lock.json")

S_IFDIR = 0o040000
S_IFREG = 0o100000

INSTALL_SH = ("""#!/bin/sh
# Complete BrowserOS Ubuntu-like setup, run as ONE command (no typing races).
# Run with tracing to SEE every step:   sh -x /mnt/tools/install.sh
echo ">>> install.sh started <<<"
echo ">>> install.sh started <<<" > /dev/console 2>/dev/null
[ "$VERBOSE" = "1" ] && set -x
echo '== STEP 1/4: checking tools filesystem =='

# Mount the 9p tools fs if not already mounted.
if [ ! -d /mnt/tools/apks ]; then
  mkdir -p /mnt/tools
  for m in 9p 9pnet 9pnet_virtio; do modprobe $m 2>/dev/null; done
  mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/tools 2>/dev/null \\
    || mount -t 9p -o trans=virtio host9p /mnt/tools 2>/dev/null
fi
[ -d /mnt/tools/apks ] || { echo 'ERROR: tools fs not mounted'; exit 1; }

# Keep the compressed APKs on 9p. Copying the Firefox bundle into /tmp would
# waste hundreds of megabytes of the guest's RAM-backed live filesystem.
echo '== STEP 2/4: reading bundled packages =='
echo '== STEP 3/4: installing packages =='

total=$(ls /mnt/tools/apks/*.apk 2>/dev/null | wc -l)
echo "Installing $total verified packages directly from the tools filesystem..."
apk add --allow-untrusted --no-network --force-non-repository \
  /mnt/tools/apks/*.apk
echo '== All packages installed =='

echo '== Bringing up networking (eth0 + DHCP) =='
ip link set eth0 up 2>/dev/null
# Request a DHCP lease from the relay (background so it doesn't block boot).
( udhcpc -i eth0 -t 5 -n >/dev/null 2>&1 || ifup eth0 2>/dev/null ) &
# Enable networking at every boot too.
rc-update add networking boot 2>/dev/null
cat > /etc/network/interfaces <<'NEOF'
auto lo
iface lo inet loopback
auto eth0
iface eth0 inet dhcp
NEOF

echo '== STEP 4/4: configuring Ubuntu-like environment =='
cat > /usr/local/bin/apt <<'AEOF'
#!/bin/sh
# apt -> apk shim. Tries the INTERNET first (real installs); if offline,
# falls back to the bundled offline tools disk.
ALPVER=$(cut -d. -f1,2 /etc/alpine-release 2>/dev/null || echo 3.24)
ensure_repos() {
  # Make sure online repositories are configured.
  if ! grep -q dl-cdn /etc/apk/repositories 2>/dev/null; then
    echo "https://dl-cdn.alpinelinux.org/alpine/v$ALPVER/main" > /etc/apk/repositories
    echo "https://dl-cdn.alpinelinux.org/alpine/v$ALPVER/community" >> /etc/apk/repositories
  fi
}
c=$1; shift 2>/dev/null
case $c in
  update)
    ensure_repos
    echo "apt: updating package lists from the internet..."
    apk update ;;
  upgrade|full-upgrade|dist-upgrade)
    ensure_repos; apk upgrade ;;
  install)
    ensure_repos
    # Try online first; if that fails (no internet), use the offline bundle.
    apk add "$@" || {
      echo "apt: online install failed, trying offline bundle..."
      apk add --allow-untrusted --no-network --force-non-repository "$@" 2>/dev/null \
        || echo "apt: '$*' not available online or in the offline bundle."
    } ;;
  remove|purge) apk del "$@" ;;
  search) ensure_repos; apk search "$@" ;;
  show)   apk info "$@" ;;
  list)   apk list --installed ;;
  *) echo "apt: usage: update | upgrade | install | remove | search | show | list" ;;
esac
AEOF
chmod +x /usr/local/bin/apt
ln -sf /usr/local/bin/apt /usr/local/bin/apt-get

cat > /etc/profile.d/ubuntu.sh <<'PEOF'
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias grep='grep --color=auto'
export EDITOR=nano
export PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
PEOF
chmod +x /etc/profile.d/ubuntu.sh

echo ''
echo '=================================================='
echo ' Done! Ubuntu-like development environment ready.'
echo '=================================================='
[ "$BROWSEROS_SETUP_ONLY" = "1" ] || exec bash -l
""").encode()

INSTALL_FIREFOX_SH = ("""#!/bin/sh
set -e
echo ">>> install-firefox.sh started <<<"
ROOT=/mnt/tools/firefox-root

if [ ! -d /mnt/tools/firefox-apks ]; then
  echo "ERROR: Firefox package group is not mounted"
  exit 1
fi

mkdir -p "$ROOT"/dev "$ROOT"/proc "$ROOT"/sys "$ROOT"/run "$ROOT"/tmp
mountpoint -q "$ROOT/dev" || mount -o bind /dev "$ROOT/dev"
mountpoint -q "$ROOT/proc" || mount -t proc proc "$ROOT/proc"
mountpoint -q "$ROOT/sys" || mount -o bind /sys "$ROOT/sys"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null || true

if [ ! -x "$ROOT/usr/bin/firefox-esr" ] || [ ! -x "$ROOT/usr/bin/Xorg" ]; then
  total=$(ls /mnt/tools/firefox-apks/*.apk 2>/dev/null | wc -l)
  echo "Installing $total verified Firefox/Xorg packages onto writable 9p storage..."
  apk add --root "$ROOT" --initdb --no-cache --allow-untrusted --no-network \
    --force-non-repository /mnt/tools/firefox-apks/*.apk
fi

mkdir -p "$ROOT/etc/X11/xorg.conf.d" "$ROOT/root/.config/openbox" \
  "$ROOT/root/.mozilla/browseros" "$ROOT/usr/local/bin"
cat > "$ROOT/etc/X11/xorg.conf.d/20-browseros-vga.conf" <<'XEOF'
Section "ServerFlags"
  Option "AutoAddDevices" "false"
EndSection
Section "Device"
  Identifier "BrowserOS VGA"
  Driver "modesetting"
  Option "AccelMethod" "none"
EndSection
Section "Screen"
  Identifier "BrowserOS Screen"
  Device "BrowserOS VGA"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1024x768" "800x600"
  EndSubSection
EndSection
Section "InputDevice"
  Identifier "BrowserOS Keyboard"
  Driver "libinput"
  Option "Device" "/dev/input/event0"
EndSection
Section "InputDevice"
  Identifier "BrowserOS Mouse"
  Driver "libinput"
  Option "Device" "/dev/input/event1"
EndSection
Section "ServerLayout"
  Identifier "BrowserOS Layout"
  Screen "BrowserOS Screen"
  InputDevice "BrowserOS Keyboard" "CoreKeyboard"
  InputDevice "BrowserOS Mouse" "CorePointer"
EndSection
XEOF

cat > "$ROOT/root/.config/openbox/autostart" <<'OEOF'
xsetroot -solid '#2c0a2e' &
OEOF

cat > "$ROOT/root/.config/mimeapps.list" <<'MEOF'
[Default Applications]
text/html=firefox-esr.desktop
x-scheme-handler/http=firefox-esr.desktop
x-scheme-handler/https=firefox-esr.desktop

[Added Associations]
text/html=firefox-esr.desktop;
x-scheme-handler/http=firefox-esr.desktop;
x-scheme-handler/https=firefox-esr.desktop;
MEOF

cat > "$ROOT/usr/local/bin/browseros-firefox-session" <<'FEOF'
#!/bin/sh
export GDK_BACKEND=x11
export BROWSER=firefox-esr
export DEFAULT_BROWSER=firefox-esr
export LIBGL_ALWAYS_SOFTWARE=1
export MOZ_X11_EGL=0
export MOZ_DISABLE_CONTENT_SANDBOX=1
export MOZ_DISABLE_GMP_SANDBOX=1
export MOZ_ENABLE_WAYLAND=0
export MOZ_WEBRENDER=0
xsetroot -solid '#2c0a2e'
openbox > /tmp/browseros-openbox.log 2>&1 &
exec dbus-run-session -- firefox-esr --no-remote --new-instance \
  --profile /root/.mozilla/browseros https://duckduckgo.com/ \
  > /tmp/browseros-firefox.log 2>&1
FEOF
chmod +x "$ROOT/usr/local/bin/browseros-firefox-session"

cat > "$ROOT/root/.mozilla/browseros/user.js" <<'FEOF'
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("gfx.webrender.all", false);
user_pref("layers.acceleration.disabled", true);
FEOF

cat > "$ROOT/usr/local/bin/browseros-firefox-inner" <<'FEOF'
#!/bin/sh
export HOME=/root
export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
exec startx /usr/local/bin/browseros-firefox-session -- :0 -nolisten tcp vt1
FEOF
chmod +x "$ROOT/usr/local/bin/browseros-firefox-inner"

cat > /usr/local/bin/browseros-firefox <<'FEOF'
#!/bin/sh
set -e
ROOT=/mnt/tools/firefox-root
modprobe psmouse 2>/dev/null || true
if [ ! -e /dev/dri/card0 ]; then
  echo "Starting the VM graphics adapter..."
  modprobe bochs defx=1024 defy=768
fi
[ -e /dev/dri/card0 ] || {
  echo "ERROR: the BrowserOS graphics adapter did not start"
  exit 1
}
mkdir -p "$ROOT"/dev "$ROOT"/proc "$ROOT"/sys
mountpoint -q "$ROOT/dev" || mount -o bind /dev "$ROOT/dev"
mountpoint -q "$ROOT/proc" || mount -t proc proc "$ROOT/proc"
mountpoint -q "$ROOT/sys" || mount -o bind /sys "$ROOT/sys"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null || true
exec chroot "$ROOT" /usr/local/bin/browseros-firefox-inner
FEOF
chmod +x /usr/local/bin/browseros-firefox

echo ''
echo '=================================================='
echo ' Firefox ESR and the graphical desktop are ready.'
echo ' Run browseros-firefox to start the graphical browser.'
echo '=================================================='
""").encode()

LAUNCH_FIREFOX_SH = ("""#!/bin/sh
set -e

if ! command -v firefox-esr >/dev/null 2>&1 ||
   ! command -v Xorg >/dev/null 2>&1 ||
   ! command -v browseros-firefox >/dev/null 2>&1; then
  echo "Firefox GUI is not installed yet; installing the bundled packages..."
  sh /mnt/tools/install-firefox.sh
fi

ip link set eth0 up 2>/dev/null || true
echo "Connecting the VM network..."
udhcpc -i eth0 -t 5 -n -q >/dev/null 2>&1 ||
  ifup eth0 >/dev/null 2>&1 ||
  echo "Warning: VM network setup did not receive a lease"
echo "Starting Firefox inside the Alpine VM..."
exec /usr/local/bin/browseros-firefox
""").encode()

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def locked_apks():
    with open(LOCK, "r", encoding="utf-8") as f:
        lock = json.load(f)
    if lock.get("format") != 1 or lock.get("arch") != "x86":
        raise RuntimeError("packages.lock.json has an unsupported format/architecture")
    packages = sorted(lock.get("packages") or [], key=lambda p: p["filename"])
    if not packages:
        raise RuntimeError("packages.lock.json contains no APKs")

    expected = {p["filename"] for p in packages}
    actual = {name for name in os.listdir(APKS) if name.endswith(".apk")}
    extra = sorted(actual - expected)
    missing = sorted(expected - actual)
    if extra or missing:
        raise RuntimeError(
            "APK directory differs from lock"
            + (f"; extra: {', '.join(extra)}" if extra else "")
            + (f"; missing: {', '.join(missing)}" if missing else "")
        )

    files = []
    for package in packages:
        path = os.path.join(APKS, package["filename"])
        with open(path, "rb") as f:
            data = f.read()
        if len(data) != package["size"] or sha256(data) != package["sha256"]:
            raise RuntimeError(f"{package['filename']} does not match packages.lock.json")
        groups = package.get("groups") or []
        if not groups or any(group not in {"base", "firefox"} for group in groups):
            raise RuntimeError(
                f"{package['filename']} has invalid or missing package groups"
            )
        files.append((path, data, package))
    return files

def main():
    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)

    files = locked_apks()
    group_children = {"base": [], "firefox": []}
    for p, data, package in files:
        h = sha256(data)
        # v86 fetches file content as baseurl + sha256 (FLAT, no subdirs).
        with open(os.path.join(OUT_DIR, h), "wb") as o:
            o.write(data)
        # File entry: [name, size, mtime, mode, uid, gid, sha256]
        entry = [os.path.basename(p), len(data), 0, S_IFREG | 0o644, 0, 0, h]
        for group in package["groups"]:
            group_children[group].append(entry)

    scripts = [
        ("install.sh", INSTALL_SH),
        ("install-firefox.sh", INSTALL_FIREFOX_SH),
        ("launch-firefox.sh", LAUNCH_FIREFOX_SH),
    ]
    script_entries = []
    for name, data in scripts:
        digest = sha256(data)
        with open(os.path.join(OUT_DIR, digest), "wb") as output:
            output.write(data)
        script_entries.append(
            [name, len(data), 0, S_IFREG | 0o755, 0, 0, digest]
        )

    # fsroot = array of TOP-LEVEL entries (no wrapper root node).
    # Dir entry: [name, size, mtime, mode, uid, gid, [children]]
    fsroot = [
        ["apks", 0, 0, S_IFDIR | 0o755, 0, 0, group_children["base"]],
        ["firefox-apks", 0, 0, S_IFDIR | 0o755, 0, 0, group_children["firefox"]],
        *script_entries,
    ]
    total = sum(len(data) for _, data, _ in files) + sum(
        len(data) for _, data in scripts
    )
    with open(OUT_JSON, "w") as f:
        json.dump({"fsroot": fsroot, "version": 3, "size": total}, f)

    print(f"9p tree: {len(files)} apks -> {OUT_DIR}")
    print(f"index:   {OUT_JSON}")

if __name__ == "__main__":
    main()
