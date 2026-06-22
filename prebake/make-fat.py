#!/usr/bin/env python3
"""Pack the downloaded apks + an install script into a FAT16 disk image
that the v86 VM mounts as a second drive. Output: ../public/images/tools.img
"""
import os, glob, subprocess, math
from pyfatfs.PyFat import PyFat
from pyfatfs.PyFatFS import PyFatFS

HERE = os.path.dirname(__file__)
APKS = os.path.join(HERE, "apks", "x86")
OUT = os.path.join(HERE, "..", "public", "images", "tools.img")

INSTALL_SH = """#!/bin/sh
# Auto-install pre-baked tools from this disk (no internet needed).
set -e
echo '== BrowserOS: installing pre-baked tools (offline) =='
apk add --allow-untrusted --no-network /mnt/tools/apks/*.apk
cat > /usr/local/bin/apt <<'EOF'
#!/bin/sh
c=$1; shift 2>/dev/null
case $c in
  update) echo 'apt: (offline image) packages already installed';;
  install) exec apk add --allow-untrusted --no-network "$@";;
  remove|purge) exec apk del "$@";;
  list) exec apk list --installed;;
  *) echo 'apt: update|install|remove|list';;
esac
EOF
chmod +x /usr/local/bin/apt
cat > /etc/profile.d/ubuntu.sh <<'EOF'
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias grep='grep --color=auto'
export EDITOR=nano
export PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
EOF
chmod +x /etc/profile.d/ubuntu.sh
echo '== Done! Starting bash. Try: ll  /  python3 --version =='
exec bash -l
"""

def main():
    files = sorted(glob.glob(os.path.join(APKS, "*.apk")))
    total = sum(os.path.getsize(f) for f in files) + 65536
    size = int(math.ceil(total / (1024*1024)) + 4) * 1024 * 1024  # MB, +slack
    print(f"{len(files)} apks, image size {size//1024//1024} MB")

    # Create blank image and format FAT
    with open(OUT, "wb") as f:
        f.truncate(size)
    pf = PyFat()
    pf.mkfs(OUT, fat_type=PyFat.FAT_TYPE_FAT16, size=size)
    pf.close()

    fs = PyFatFS(OUT)
    fs.makedirs("/apks", recreate=True)
    for p in files:
        with open(p, "rb") as src:
            data = src.read()
        with fs.openbin("/apks/" + os.path.basename(p), "w") as dst:
            dst.write(data)
    with fs.openbin("/install.sh", "w") as dst:
        dst.write(INSTALL_SH.encode())
    fs.close()
    print(f"Wrote {OUT} ({os.path.getsize(OUT)//1024//1024} MB)")

if __name__ == "__main__":
    main()
