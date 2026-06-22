# Building a custom company OS image for BrowserOS

Ship a Linux image with **your software pre-installed**. v86 boots any i686
(32-bit x86) Linux. Two supported formats:

- **CD-ROM ISO** (simplest; what the UI uses) → drop in `public/images/`, point `cdrom` at it.
- **Hard-disk image** (persistent installs, larger) → use the `hda` option.

You build these on a normal Linux machine with QEMU (not inside the browser).

---

## Option A — Customize Alpine (recommended, small & fast)

1. **Boot Alpine in QEMU and install to a disk image:**
   ```bash
   qemu-img create -f raw company.img 2G
   qemu-system-i386 -m 1G -hda company.img \
     -cdrom alpine-virt-3.24.1-x86.iso -boot d -net user -net nic
   ```
   At the prompt: `root`, then `setup-alpine` (choose `sys` disk mode → `vda`).

2. **Install your tools, then power off:**
   ```bash
   apk add bash git python3 nodejs your-package
   # copy in your app:  use 'wget'/'scp', or mount a second disk
   poweroff
   ```

3. **Shrink & ship:** convert to a raw image and place it:
   ```bash
   cp company.img public/images/company.img
   ```

4. **Point BrowserOS at it** — in `public/app.js`, add a branch:
   ```js
   // inside boot(), else-branch:
   opts.hda = { url: "images/company.img", async: true, size: <bytes> };
   opts.boot_order = 0x123;
   ```
   (`async:true` + the included server's Range support streams the disk on demand.)

---

## Option B — Pre-baked ISO (read-only, instant)

Use any tool that builds a bootable i686 ISO (e.g. `mkisofs`/`xorriso` with a
kernel + initramfs, or Buildroot/Alpine's ISO output). Then:

```bash
cp my-os.iso public/images/company.iso
```
and set `CFG.cdrom = "images/company.iso"` (or add it to the OS dropdown in
`index.html` + `osNames` in `app.js`).

---

## Option C — Buildroot from scratch (smallest, fully custom)

```bash
git clone https://github.com/buildroot/buildroot && cd buildroot
make qemu_x86_defconfig
make menuconfig      # add packages, set BR2_x86_i686
make -j$(nproc)      # outputs output/images/{bzImage,rootfs.iso9660}
```
Copy `rootfs.iso9660` → `public/images/company.iso`.

---

## Tips
- Keep it **i686 (32-bit)** — v86 emulates a 32-bit CPU.
- Disk images can be large; the bundled `server.py` supports HTTP **Range**, and
  hosts must too (Netlify/Vercel/S3 do).
- For a saved "golden" boot, you can capture a v86 **state file** and ship it as
  `initial_state` so users skip the boot wait entirely.
