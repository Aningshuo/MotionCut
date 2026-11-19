#!/usr/bin/env bash
set -euo pipefail

# Usage: bash prepare-macos-x64-release.sh <archives-dir> <output-dir>
[[ "$(uname -s)" == Darwin && "$(uname -m)" == x86_64 && "$(sysctl -in sysctl.proc_translated)" != 1 ]]
recipe=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
archives=$(cd "$1" && pwd -P)
mkdir -p "$2"
output=$(cd "$2" && pwd -P)
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/motioncut-intel-media.XXXXXX")
trap 'rm -rf "$work"' EXIT

(cd "$archives" && shasum -a 256 -c "$recipe/SOURCE_SHA256SUMS")
MOTIONCUT_BUILD_JOBS="${MOTIONCUT_BUILD_JOBS:-4}" bash "$recipe/build-macos.sh" "$archives" "$work/build"

mkdir -p "$output/bin"
for executable in ffmpeg ffprobe; do
  binary="$work/build/bin/$executable"
  lipo "$binary" -verify_arch x86_64
  otool -L "$binary" | tee "$work/$executable-imports.txt"
  awk 'NR > 1 && $1 !~ /^\/(usr\/lib|System\/Library)\// { bad = 1 } END { exit bad }' "$work/$executable-imports.txt"
  vtool -show-build "$binary" > "$work/$executable-build.txt"
  cp "$binary" "$output/bin/"
done

source_name=MotionCut-FFmpeg-8.1.3-macos-x64-corresponding-source
source_root="$work/$source_name"
notices="$source_root/notices"
mkdir -p "$source_root/archives" "$notices"
while read -r _ archive; do
  cp "$archives/$archive" "$source_root/archives/"
done < "$recipe/SOURCE_SHA256SUMS"
cp "$recipe/"{SOURCE_SHA256SUMS,SOURCE_URLS.tsv,build-macos.sh} "$source_root/"
cp "$work/"{ffmpeg,ffprobe}-{imports,build}.txt "$source_root/"
"$output/bin/ffmpeg" -version > "$source_root/CONFIGURATION.txt"
{
  sw_vers
  xcodebuild -version
  clang --version
  cmake --version
  ninja --version
  meson --version
  nasm -v
} > "$source_root/TOOLCHAIN.txt"
cp "$work/build/src/ffmpeg/COPYING.GPLv2" "$notices/"
shopt -s nullglob
for component in ffmpeg pkgconf x264 x265 vpx opus freetype harfbuzz fribidi libass; do
  files=("$work/build/src/$component"/COPYING* "$work/build/src/$component"/LICENSE* "$work/build/src/$component"/PATENTS*)
  if [[ "$component" == freetype ]]; then
    files+=("$work/build/src/$component/docs/"{FTL,GPLv2}.TXT)
  fi
  mkdir "$notices/$component"
  cp "${files[@]}" "$notices/$component/"
done

cat > "$source_root/README.md" <<'DOC'
# MotionCut FFmpeg sources for macOS Intel

These exact source archives and build script produce the FFmpeg and ffprobe
executables included in the MotionCut 0.3.2-r2 Intel macOS disk image.
The build runs on an x86_64 Mac with the Xcode command-line tools, CMake,
Meson, Ninja and NASM. See TOOLCHAIN.txt and CONFIGURATION.txt for build details.

```sh
(cd archives && shasum -a 256 -c ../SOURCE_SHA256SUMS)
bash build-macos.sh archives build-intel
```

The two executables are in `build-intel/bin`. Original licensing notices are
in `notices/` and the upstream source archives.
DOC

cat > "$notices/MEDIA-NOTICE.md" <<'DOC'
# FFmpeg and ffprobe for MotionCut on Intel macOS

The disk image includes separate command-line executables FFmpeg and ffprobe
built from FFmpeg 8.1.3 with GPL components enabled. FFmpeg and ffprobe are
provided under GNU GPL version 2 or, at your option, any later version.
Linked libraries retain their respective copyright and license notices.
MotionCut launches these tools as separate processes and is licensed under MIT.

The exact corresponding source, original notices and build script are available at:
https://github.com/Aningshuo/MotionCut/releases/download/v0.3.2-r2/MotionCut-FFmpeg-8.1.3-macos-x64-corresponding-source.tar.gz
DOC

cp -R "$notices" "$output/notices"
tar -czf "$output/$source_name.tar.gz" -C "$work" "$source_name"
