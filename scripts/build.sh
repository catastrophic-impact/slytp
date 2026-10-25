#!/bin/bash
# Run inside slytp-box: builds release/SLYTP-<version>.AppImage (bundles standalone yt-dlp)
set -e
cd "$(dirname "$0")/.."
mkdir -p build
[ -f build/yt-dlp_linux ] || { curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o build/yt-dlp_linux; chmod +x build/yt-dlp_linux; }
[ -d node_modules ] || npm install
npm install --save-dev electron-builder
npm run dist
