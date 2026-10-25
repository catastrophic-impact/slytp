#!/bin/bash
# Run from the host: installs deps (first time) and launches the app inside slytp-box.
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install
exec npm start
