# SLYTP: Simple Local YouTube Player

A sign-in-free YouTube front end for Linux. Follow your favorite channels, search, save videos to playlists and pick a quality, then play in [MPV](https://mpv.io/). No account, no ads, no browser tab.

SLYTP is an Electron app. It lists videos with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and hands playback to MPV, so video decoding is hardware-accelerated and light on the CPU.

## Features

- **Favorite channels.** Star a channel and it appears in the sidebar. The Home page merges the newest uploads from all your favorites.
- **Endless scrolling.** Home, channel pages and search results all load more as you scroll.
- **Search and paste.** Type a search, an `@handle`, or paste a video or channel URL.
- **Quality choice.** Play at 2160p, 1440p, 1080p, 720p, 480p, 360p, 240p or Best. It uses real YouTube streams at that resolution (no re-scaling), preferring formats your device can decode smoothly.
- **Audio-only mode.** Streams only the audio (no video data downloaded) and shows the video's thumbnail in MPV. Good for music and for saving bandwidth.
- **Playlists.** Bookmark any video into your own playlists, then use **Play all** to queue a whole playlist in one MPV window (skip with `<` and `>`). Videos with different available resolutions are handled with a quality cap, so each plays at the best quality up to your choice.
- **Downloads.** Save audio (original quality, or converted to MP3, OGG, Opus, M4A, FLAC or WAV) or video (MP4, MKV or WebM).
- **Adaptive playback.** If a video stutters, SLYTP automatically uses safer settings next time.
- **Self-updating yt-dlp.** The yt-dlp copy SLYTP uses updates itself, with checksum verification, so playback keeps working when YouTube changes.

## Requirements

- Linux (x86_64)
- **MPV**, either the Flatpak (`flatpak install flathub io.mpv.Mpv`) or a native install (`sudo apt install mpv`, `sudo pacman -S mpv`, `sudo dnf install mpv`). SLYTP tells you if it can't find either.
- **ffmpeg** is only needed for converting audio formats and merging downloaded video. SLYTP can download a copy for you the first time you need it. It is never used for playback.

## Install (AppImage)

Download `SLYTP-0.1.0.AppImage`, then:

```
chmod +x SLYTP-0.1.0.AppImage
./SLYTP-0.1.0.AppImage
```

The AppImage is fully portable. All of its data (favorites, playlists, settings, helper binaries) lives in a `config` folder next to the AppImage. It never writes to `~/.config` or anywhere else in your home directory. Delete the folder to reset everything.

## Run from source

```
npm install
npm start
```

`npm start` runs `electron . --no-sandbox`. The `--no-sandbox` flag is needed where Chromium's sandbox helper isn't set up with the right permissions (the AppImage launcher passes it automatically). In development, data is stored in `config/` inside the project.

## Build the AppImage

```
bash scripts/build.sh
```

This downloads the standalone yt-dlp, installs dependencies, and writes `release/SLYTP-<version>.AppImage`. The project is developed inside an Ubuntu 22.04 [distrobox](https://github.com/89luca89/distrobox) so the build runs on a wide range of distributions. `scripts/setup-box.sh` provisions that box (Node 20, yt-dlp and the Electron runtime libraries).

```
distrobox create --name slytp-box --image docker.io/library/ubuntu:22.04 --home ~/boxes/slytp
distrobox enter slytp-box -- bash scripts/setup-box.sh
distrobox enter slytp-box -- bash scripts/build.sh
```

## How it works

| Piece | Role |
| --- | --- |
| `src/main.js` | Electron main process: yt-dlp calls, RSS feeds, caching, MPV launching, downloads, playlists and favorites storage |
| `src/preload.js` | Safe bridge (`window.api`) between the UI and the main process |
| `src/renderer/` | The UI: plain HTML, CSS and JavaScript, with a bundled font and inline icons |
| `src/deps.js` | Keeps yt-dlp (and optionally ffmpeg) up to date inside the `config/bin` folder |
| `scripts/` | Build, packaging and dev-environment scripts |

Home uses each channel's public RSS feed for exact, fresh results and falls back to yt-dlp when you scroll further back, where upload dates are approximate. Lists are cached only for the current session. The cache is cleared every time the app starts.

More detail and project history is in [devnotes.txt](devnotes.txt).

## Notes and limitations

- SLYTP does not sign in, so age-restricted and members-only videos aren't available.
- YouTube changes often. If playback or listing breaks, the built-in yt-dlp update check (the status button at the bottom of the sidebar) is the first thing to try.
- When using the **MPV Flatpak**, MPV uses its own bundled yt-dlp, which is updated through `flatpak update`.

## Disclaimer

SLYTP is an independent project and is not affiliated with or endorsed by YouTube or Google. Use it in line with YouTube's terms of service and the laws where you live.

## License

MIT (see `package.json`).
