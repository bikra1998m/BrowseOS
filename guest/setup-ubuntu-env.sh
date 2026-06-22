#!/bin/sh
# BrowserOS — make Alpine feel like Ubuntu.
# Installs a standard dev toolset and adds Ubuntu-style conveniences:
#   * bash as a comfortable shell + an `ll` alias and a familiar prompt
#   * sudo, git, curl, wget, nano, vim, python3, htop, net-tools, coreutils
#   * an `apt` shim so `apt install X` / `apt update` map to apk
# Run inside the guest:  sh setup-ubuntu-env.sh    (or paste it in)
set -e

echo ">> Enabling online Alpine repositories (CD-ROM only has ~100 packages)…"
. /etc/os-release 2>/dev/null || true
VER="$(cut -d. -f1,2 /etc/alpine-release 2>/dev/null || echo 3.24)"
echo "https://dl-cdn.alpinelinux.org/alpine/v${VER}/main" > /etc/apk/repositories
echo "https://dl-cdn.alpinelinux.org/alpine/v${VER}/community" >> /etc/apk/repositories

echo ">> Updating package index…"
apk update

echo ">> Installing the standard toolset…"
apk add --no-cache \
  bash bash-completion sudo shadow \
  git curl wget \
  nano vim less \
  python3 py3-pip \
  htop procps net-tools iproute2 \
  coreutils findutils grep sed gawk tar gzip

echo ">> Creating an 'apt' shim (translates apt → apk)…"
cat > /usr/local/bin/apt <<'EOF'
#!/bin/sh
# Minimal apt→apk shim for an Ubuntu-like feel on Alpine.
cmd="$1"; shift 2>/dev/null || true
case "$cmd" in
  update)            exec apk update ;;
  upgrade|full-upgrade|dist-upgrade) exec apk upgrade ;;
  install)           exec apk add "$@" ;;
  remove|purge)      exec apk del "$@" ;;
  search)            exec apk search "$@" ;;
  show)              exec apk info "$@" ;;
  list)              exec apk list --installed ;;
  autoremove|clean)  echo "apt: nothing to do (apk manages this)"; ;;
  *) echo "apt (shim): unknown '$cmd'. Use update|upgrade|install|remove|search|show|list"; exit 1 ;;
esac
EOF
chmod +x /usr/local/bin/apt
ln -sf /usr/local/bin/apt /usr/local/bin/apt-get 2>/dev/null || true

echo ">> Configuring an Ubuntu-style bash environment…"
cat > /etc/profile.d/ubuntu-feel.sh <<'EOF'
# Ubuntu-like aliases + prompt
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias ls='ls --color=auto 2>/dev/null || ls'
alias grep='grep --color=auto'
export EDITOR=nano
# Green user@host, blue path — classic Ubuntu look
export PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
EOF
chmod +x /etc/profile.d/ubuntu-feel.sh

# Make bash the default login shell for root.
sed -i 's#^root:\(.*\):/bin/[a-z]*#root:\1:/bin/bash#' /etc/passwd 2>/dev/null || true

echo
echo "=========================================================="
echo " Done! Your Alpine now feels like Ubuntu."
echo " Start bash now with:   exec bash -l"
echo " Try:  ll    apt install cowsay    python3 --version"
echo "=========================================================="
