# Build the bundled media tools on macOS

The packaged editor runs FFmpeg and ffprobe as separate executables. The tools combine FFmpeg 8.1.3 with x264, x265, libvpx, Opus and libass. The build enables GPL and uses FFmpeg's native AAC encoder. libass uses macOS Core Text for its fonts.

Run the build natively on Apple Silicon or Intel macOS. Development prerequisites are the Xcode command-line tools, CMake, Meson and Ninja. Intel also requires NASM. The script builds its own pkg-config implementation from the pinned pkgconf source.

```sh
archives=$(mktemp -d /tmp/motioncut-media-sources.XXXXXX)
work=$(mktemp -d /tmp/motioncut-media-build.XXXXXX)
source_lock="$PWD/scripts/ffmpeg/SOURCE_SHA256SUMS"
while IFS="$(printf '\t')" read -r file url; do
  curl -fL --retry 3 "$url" -o "$archives/$file" || exit 1
done < scripts/ffmpeg/SOURCE_URLS.tsv
(cd "$archives" && shasum -a 256 -c "$source_lock") || exit 1
bash scripts/ffmpeg/build-macos.sh "$archives" "$work"
```

The two executables are in `$work/bin`. The source archives, checksums and build script are the inputs to the corresponding-source asset published alongside any bundled installer. The original notices inside the upstream archives apply to the media tools.

## Intel macOS

Use a native Intel Mac or a runner such as `macos-15-intel` with x64 Node, Electron and Playwright. After building FFmpeg and ffprobe above, prepare the browser and create the Intel disk image:

```sh
pnpm install --frozen-lockfile
pnpm exec electron --version
pnpm exec playwright install chromium-headless-shell
OPENCUT_FFMPEG="$work/bin/ffmpeg" OPENCUT_FFPROBE="$work/bin/ffprobe" pnpm package:mac:x64
```

Run an installed-app smoke test, including subtitle burn-in, before publishing. Distribute the exact corresponding source next to the disk image.

## Windows

A Windows build needs native `ffmpeg.exe` and `ffprobe.exe` built with the matching corresponding source, Windows Chromium and a Windows x64 installer. Use a native runner such as `windows-2025`. Test both ordinary export and subtitle burn-in from an installed copy, including Unicode paths with spaces and a drive letter.
