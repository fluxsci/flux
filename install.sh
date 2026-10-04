#!/usr/bin/env bash
# Flux installer: the one supported way to install and update Flux.
#
#   curl -fsSL https://fluxsci.github.io/install.sh | bash
#
# macOS (Apple Silicon or Intel): installs Flux.app into /Applications (or ~/Applications
# when /Applications is not writable). Debian/Ubuntu (x86-64): installs the .deb with apt,
# which asks for your password. Either way it downloads the release from GitHub, checks
# it against the release's SHA256SUMS, puts ~/.local/bin on your PATH for the `flux`
# command, and opens Flux.
#
# Options (pass them after `bash -s --`, e.g. `curl … | bash -s -- --version v0.2.0`):
#   --version vX.Y.Z   install that release instead of the latest (or set FLUX_VERSION)
#   --update           replace an existing install (what Flux's "Update now" runs)
#   --wait-pid PID     wait for that process (the running Flux) to exit first
#   --relaunch         open Flux when done, even with --update
#   --no-launch        do not open Flux when done
#
# Why a script rather than a downloaded app: files fetched by curl carry no quarantine
# flag, so macOS opens Flux without the "unidentified developer" detour. Flux has no
# Apple Developer ID (an owner decision); the app is ad-hoc signed, which Apple Silicon
# requires to run at all.
set -euo pipefail

# The whole body is one brace group: with `curl … | bash`, bash then reads the entire script
# before running any of it, so nothing that reads stdin (apt, sudo) can swallow the rest.
{
REPO="fluxsci/flux"
PATH_MARKER="# Added by Flux: put the flux command on PATH"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

# Test seams (verify-install-script.ts); not for normal use.
BASE_URL="${FLUX_INSTALL_BASE_URL:-}"
OS_OVERRIDE="${FLUX_INSTALL_OS:-}"
APPS_DIR_OVERRIDE="${FLUX_INSTALL_APPS_DIR:-}"

version="${FLUX_VERSION:-}"
update=0
wait_pid=""
launch=auto

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value (e.g. v0.2.0)"; version="$2"; shift 2 ;;
    --update) update=1; shift ;;
    --wait-pid) [ $# -ge 2 ] || die "--wait-pid needs a process id"; wait_pid="$2"; shift 2 ;;
    --relaunch) launch=yes; shift ;;
    --no-launch) launch=no; shift ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
if [ "$launch" = auto ]; then
  if [ "$update" = 1 ]; then launch=no; else launch=yes; fi
fi

# --- platform ---------------------------------------------------------------------------
os="${OS_OVERRIDE:-$(uname -s)}"
case "$os" in
  Darwin|mac) os=mac ;;
  Linux|linux) os=linux ;;
  *) die "Flux supports macOS and Debian/Ubuntu Linux; this is $os." ;;
esac
machine="$(uname -m)"
if [ "$os" = mac ]; then
  case "$machine" in
    arm64) arch=arm64 ;;
    x86_64)
      # A Terminal running under Rosetta reports x86_64 on Apple Silicon: install the native build.
      if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi ;;
    *) die "unsupported Mac architecture: $machine" ;;
  esac
  asset="Flux-mac-$arch.zip"
else
  case "$machine" in
    x86_64|amd64) arch=amd64 ;;
    *) die "Flux for Linux is built for x86-64 only; this machine is $machine." ;;
  esac
  [ -n "$OS_OVERRIDE" ] || command -v apt-get >/dev/null 2>&1 || die "Flux for Linux installs with apt (Debian/Ubuntu); apt-get was not found."
  asset="Flux-linux-$arch.deb"
fi
command -v curl >/dev/null 2>&1 || die "curl is required."

if [ -z "$BASE_URL" ]; then
  if [ -n "$version" ]; then
    case "$version" in v*) ;; *) version="v$version" ;; esac
    BASE_URL="https://github.com/$REPO/releases/download/$version"
  else
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  fi
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/flux-install.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# --- download and verify ----------------------------------------------------------------
say "Downloading $asset${version:+ ($version)}"
curl -fL --retry 3 --progress-bar -o "$tmp/$asset" "$BASE_URL/$asset" \
  || die "could not download $BASE_URL/$asset"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$BASE_URL/SHA256SUMS" \
  || die "could not download $BASE_URL/SHA256SUMS"
expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"; fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
say "Checksum verified"

# --- wait for a running Flux to exit -----------------------------------------------------
if [ -n "$wait_pid" ]; then
  say "Waiting for Flux to quit"
  for _ in $(seq 1 120); do kill -0 "$wait_pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$wait_pid" 2>/dev/null && die "Flux (pid $wait_pid) is still running; quit it and run the installer again"
fi

# --- PATH for the `flux` command ---------------------------------------------------------
# Flux writes ~/.local/bin/flux itself on launch when that folder exists; make sure it does
# and that new terminals see it.
ensure_path() {
  mkdir -p "$HOME/.local/bin"
  local rc
  local shell_name="${SHELL:-}"; shell_name="${shell_name##*/}"
  case "$shell_name" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) if [ "$os" = mac ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    *) if [ "$os" = mac ]; then rc="$HOME/.zshrc"; else rc="$HOME/.bashrc"; fi ;;
  esac
  if [ -f "$rc" ] && grep -qF "$PATH_MARKER" "$rc"; then return; fi
  printf '\n%s\n%s\n' "$PATH_MARKER" "$PATH_LINE" >> "$rc"
  path_added="$rc"
}
path_added=""

# --- install -----------------------------------------------------------------------------
if [ "$os" = mac ]; then
  if [ -n "$APPS_DIR_OVERRIDE" ]; then apps="$APPS_DIR_OVERRIDE"
  elif [ -w /Applications ]; then apps=/Applications
  else apps="$HOME/Applications"; fi
  mkdir -p "$apps"
  target="$apps/Flux.app"

  if [ -z "$wait_pid" ] && [ -z "$OS_OVERRIDE" ] && pgrep -xq Flux; then
    say "Quitting the running Flux"
    osascript -e 'quit app "Flux"' >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do pgrep -xq Flux || break; sleep 0.5; done
    pgrep -xq Flux && die "Flux is still running; quit it and run the installer again"
  fi

  say "Installing Flux.app into $apps"
  mkdir "$tmp/unpacked"
  if command -v ditto >/dev/null 2>&1; then ditto -x -k "$tmp/$asset" "$tmp/unpacked"
  else unzip -q "$tmp/$asset" -d "$tmp/unpacked"; fi
  [ -d "$tmp/unpacked/Flux.app" ] || die "the download did not contain Flux.app"
  # Belt and braces: curl sets no quarantine flag, but never let one through.
  xattr -dr com.apple.quarantine "$tmp/unpacked/Flux.app" 2>/dev/null || true

  # Swap in place: the old app stays recoverable until the new one is in.
  if [ -e "$target" ]; then mv "$target" "$tmp/Flux.app.previous"; fi
  if ! mv "$tmp/unpacked/Flux.app" "$target"; then
    [ -e "$tmp/Flux.app.previous" ] && mv "$tmp/Flux.app.previous" "$target"
    die "could not move Flux.app into $apps; the previous install was kept"
  fi
  ensure_path
  if [ "$launch" = yes ] && [ -z "$OS_OVERRIDE" ]; then open "$target"; fi
else
  say "Installing $asset with apt (you may be asked for your password)"
  # apt reads the file as the unprivileged _apt user: make it readable to avoid a warning.
  chmod 755 "$tmp"; chmod 644 "$tmp/$asset"
  if [ -n "$OS_OVERRIDE" ]; then : # test seam: no system changes
  elif [ "$(id -u)" = 0 ]; then apt-get install -y "$tmp/$asset" </dev/null
  else sudo apt-get install -y "$tmp/$asset" </dev/null; fi
  ensure_path
  if [ "$launch" = yes ] && [ -z "$OS_OVERRIDE" ] && [ -x /opt/Flux/flux ]; then
    (setsid /opt/Flux/flux >/dev/null 2>&1 &) || true
  fi
fi

installed="${version:-the latest release}"
if [ "$update" = 1 ]; then say "Flux updated to $installed."; else say "Flux installed ($installed)."; fi
if [ -n "$path_added" ]; then
  say "Added ~/.local/bin to your PATH in $path_added; open a new terminal to use the \`flux\` command."
fi
if [ "$update" = 0 ]; then
  echo "    Next: Flux opens a short setup window for the optional extras (Paper export, PDF, agents)."
  echo "    Docs: https://fluxsci.github.io/"
fi
}
