#!/bin/bash
set -euo pipefail

# Converter entrypoint: copy installed soffice binary into shared output directory
OUT_DIR=${CONVERTER_OUT_DIR:-/out}
mkdir -p "$OUT_DIR"

SOFFICE_PATH=""
if command -v soffice >/dev/null 2>&1; then
  SOFFICE_PATH=$(command -v soffice)
elif command -v libreoffice >/dev/null 2>&1; then
  SOFFICE_PATH=$(command -v libreoffice)
fi

if [ -z "$SOFFICE_PATH" ]; then
  echo "[converter] soffice not found in image"
  exec "$@"
fi

DEST="$OUT_DIR/soffice"
if [ -x "$DEST" ]; then
  echo "[converter] soffice already present in $DEST"
else
  echo "[converter] Copying $SOFFICE_PATH -> $DEST"
  cp "$SOFFICE_PATH" "$DEST"
  chmod +x "$DEST"
fi

echo "[converter] Ready - keeping container running"
exec "$@"
