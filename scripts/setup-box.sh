#!/bin/bash
# Provisions slytp-box (run inside the box): node 20, yt-dlp, electron runtime libs
set -e
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates python3 xz-utils git \
  libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxtst6 libatspi2.0-0 libdrm2 libxkbcommon0 libnotify4 xdg-utils
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
node -v; npm -v; yt-dlp --version
echo HOME=$HOME
