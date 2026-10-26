#!/bin/sh
# Installs NotchUser into GNOME Shell for the current user.
#   ./install.sh          install from this folder
#   ./install.sh pack     build dist/notchuser@magnumja.github.io.zip (for gnome-extensions install)
set -e
cd "$(dirname "$0")"
UUID=notchuser@magnumja.github.io
FILES="metadata.json extension.js stylesheet.css"

if [ "${1:-}" = "pack" ]; then
  mkdir -p dist
  rm -f "dist/$UUID.zip"
  zip -q -j "dist/$UUID.zip" $FILES
  echo "ok: dist/$UUID.zip"
  exit 0
fi

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp $FILES "$DEST/"
gnome-extensions enable "$UUID" 2>/dev/null || true

echo "NotchUser instalado em $DEST"
echo "Agora saia da sessão e entre de novo (no Wayland o GNOME só carrega extensões novas assim)."
echo "Depois, se ele não aparecer:  gnome-extensions enable $UUID"
