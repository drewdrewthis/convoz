#!/bin/sh
# Installs the Convoz CLI from the server that sent this script. It never needs root.
#   curl -fsSL __SERVER__/install | sh
# CONVOZ_INSTALL_DIR chooses the folder (default ~/.local/bin).
set -eu

SERVER='__SERVER__'
VERSION='__VERSION__'

fail() {
	echo "convoz install: $*" >&2
	exit 1
}

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
linux | darwin) ;;
*) fail "no CLI for the operating system $os" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "no CLI for the processor $(uname -m)" ;;
esac
name="convoz-$os-$arch"

dir=${CONVOZ_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}
mkdir -p "$dir"
# Inside the target folder, so the last step is a rename on one file system.
tmp=$(mktemp -d "$dir/.convoz-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

# ?v= names the server version: a URL with it never changes, so a cache may keep it for good.
curl -fsSL "$SERVER/cli/$name?v=$VERSION" -o "$tmp/$name" || fail "cannot download $SERVER/cli/$name"
curl -fsSL "$SERVER/cli/SHA256SUMS?v=$VERSION" -o "$tmp/SHA256SUMS" || fail "cannot download $SERVER/cli/SHA256SUMS"

want=$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS has no line for $name"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/$name" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
	got=$(shasum -a 256 "$tmp/$name" | awk '{ print $1 }')
else
	fail "neither sha256sum nor shasum is installed, so the download cannot be checked"
fi
[ "$got" = "$want" ] || fail "checksum mismatch for $name (wanted $want, got $got): not installed"

chmod 755 "$tmp/$name"
mv -f "$tmp/$name" "$dir/convoz"
"$dir/convoz" version
case ":$PATH:" in
*":$dir:"*) ;;
*) echo "Add convoz to your PATH:  export PATH=\"$dir:\$PATH\"" ;;
esac
