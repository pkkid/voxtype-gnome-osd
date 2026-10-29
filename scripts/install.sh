#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "${PROJECT_DIR}/metadata.json")"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

cd "${PROJECT_DIR}"
npm run build

rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"
cp build/*.js "${TARGET_DIR}/"
cp metadata.json stylesheet.css "${TARGET_DIR}/"
cp -r schemas "${TARGET_DIR}/"
glib-compile-schemas "${TARGET_DIR}/schemas"

echo "installed ${UUID} -> ${TARGET_DIR}"
