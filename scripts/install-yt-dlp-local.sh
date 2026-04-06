#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/bin"
BIN_PATH="$BIN_DIR/yt-dlp"
BASE_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download"

platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
asset="yt-dlp"

if [[ "$platform" == "linux" ]]; then
  case "$arch" in
    x86_64|amd64)
      asset="yt-dlp_linux"
      ;;
    aarch64|arm64)
      asset="yt-dlp_linux_aarch64"
      ;;
    *)
      asset="yt-dlp"
      ;;
  esac
elif [[ "$platform" == "darwin" ]]; then
  asset="yt-dlp_macos"
fi

url="$BASE_URL/$asset"

echo "[yt-dlp] Installing local binary"
echo "[yt-dlp] URL: $url"

tmp_file="$BIN_PATH.tmp-$$"
mkdir -p "$BIN_DIR"

curl -fL "$url" -o "$tmp_file"
chmod +x "$tmp_file"
mv "$tmp_file" "$BIN_PATH"

"$BIN_PATH" --version

echo "[yt-dlp] Local binary is ready: $BIN_PATH"
