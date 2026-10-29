#!/usr/bin/env bash
# Builds a zip that `gnome-extensions install` (or extensions.gnome.org) accepts.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="${PROJECT_DIR}/build-pack"

cd "${PROJECT_DIR}"
npm run build

rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}" dist
cp -r build/. "${STAGE_DIR}/"
cp metadata.json stylesheet.css "${STAGE_DIR}/"

extra_sources=()
for file in "${STAGE_DIR}"/*; do
    case "$(basename "${file}")" in
        extension.js|prefs.js|metadata.json|stylesheet.css) ;;
        *) extra_sources+=("--extra-source=$(basename "${file}")") ;;
    esac
done

gnome-extensions pack "${STAGE_DIR}" \
    --schema="${PROJECT_DIR}/schemas/org.gnome.shell.extensions.voxtype-osd.gschema.xml" \
    "${extra_sources[@]}" \
    --out-dir=dist --force

rm -rf "${STAGE_DIR}"
ls -1 dist/*.zip
