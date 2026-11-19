#!/usr/bin/env bash
set -euo pipefail

# In an MSYS2 UCRT64 shell: bash build-windows.sh <archives-dir> <empty-working-dir>
if [[ ${MSYSTEM:-} != UCRT64 ]] || [[ $(gcc -dumpmachine) != x86_64-w64-mingw32 ]]; then
  echo 'Use the native x64 MSYS2 UCRT64 toolchain for Windows media builds.' >&2
  exit 1
fi

recipe=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
archives=$(cd "$1" && pwd -P)
mkdir -p "$2"
work=$(cd "$2" && pwd -P)
prefix="$work/prefix"
native_prefix=$(cygpath -m "$prefix")
jobs=${MOTIONCUT_BUILD_JOBS:-4}
mkdir -p "$work/src" "$work/obj" "$prefix" "$work/bin" "$work/notices"

zlib_file=zlib-1.3.2.tar.gz
zlib_url=https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz
zlib_hash=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
if [[ ! -f "$archives/$zlib_file" ]]; then
  curl -fL --retry 3 "$zlib_url" -o "$archives/$zlib_file.part"
  mv "$archives/$zlib_file.part" "$archives/$zlib_file"
fi
{
  awk -v zlib="$zlib_file" '$2 != zlib' "$recipe/SOURCE_SHA256SUMS"
  printf '%s  %s\n' "$zlib_hash" "$zlib_file"
} > "$work/SOURCE_SHA256SUMS"
(cd "$archives" && sha256sum -c "$work/SOURCE_SHA256SUMS")

while IFS=' ' read -r component archive; do
  mkdir "$work/src/$component"
  tar -xf "$archives/$archive" --strip-components=1 -C "$work/src/$component"
done <<'SOURCES'
ffmpeg ffmpeg-8.1.3.tar.xz
x264 x264-31e19f9.tar.gz
x265 x265-4.2.tar.gz
vpx libvpx-1.16.0.tar.gz
opus opus-1.6.1.tar.gz
freetype freetype-2.14.3.tar.xz
harfbuzz harfbuzz-12.1.0.tar.gz
fribidi fribidi-1.0.18.tar.xz
libass libass-0.17.5.tar.xz
zlib zlib-1.3.2.tar.gz
SOURCES

# The UCRT64 pkg-config is native Windows code, so its environment uses
# Windows paths and semicolon separators. Only our source-built libraries
# are visible as candidates.
export PKG_CONFIG_LIBDIR="$native_prefix/lib/pkgconfig;$native_prefix/share/pkgconfig"
unset PKG_CONFIG_PATH
export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1
export PKG_CONFIG_ALLOW_SYSTEM_LIBS=1

build_autoconf() (
  local component="$1"
  shift
  cd "$work/src/$component"
  ./configure --prefix="$prefix" "$@"
  make -j "$jobs"
  make install
)

build_cmake() {
  local component="$1" source="$2"
  shift 2
  cmake -S "$source" -B "$work/obj/$component" -G Ninja \
    -DCMAKE_INSTALL_PREFIX="$native_prefix" -DCMAKE_PREFIX_PATH="$native_prefix" \
    -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$work/obj/$component" --parallel "$jobs"
  cmake --install "$work/obj/$component"
}

build_cmake zlib "$work/src/zlib" -DZLIB_BUILD_SHARED=OFF -DZLIB_BUILD_STATIC=ON -DZLIB_BUILD_TESTING=OFF
build_autoconf x264 --host=x86_64-w64-mingw32 --enable-static --disable-cli --disable-opencl
build_cmake x265 "$work/src/x265/source" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=OFF
build_autoconf vpx --target=x86_64-win64-gcc --disable-examples \
  --disable-tools --disable-docs --disable-unit-tests
build_cmake opus "$work/src/opus" -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF
build_cmake freetype "$work/src/freetype" -DFT_DISABLE_BZIP2=TRUE -DFT_DISABLE_BROTLI=TRUE \
  -DFT_DISABLE_PNG=TRUE -DFT_DISABLE_ZLIB=TRUE -DFT_DISABLE_HARFBUZZ=TRUE
build_cmake harfbuzz "$work/src/harfbuzz" -DHB_HAVE_FREETYPE=ON -DHB_HAVE_ICU=OFF \
  -DHB_HAVE_GLIB=OFF -DHB_HAVE_GOBJECT=OFF -DHB_HAVE_GRAPHITE2=OFF -DHB_HAVE_DIRECTWRITE=OFF
meson setup "$work/obj/fribidi" "$work/src/fribidi" --prefix "$native_prefix" --libdir lib \
  --buildtype release --default-library static -Ddocs=false -Dtests=false -Dbin=false
meson compile -C "$work/obj/fribidi" -j "$jobs"
meson install -C "$work/obj/fribidi"
# The editor hands the renderer UTF-8 ASS and UTF-8 paths, so the optional
# iconv translation layer would only add a dependency from the host toolchain.
ac_cv_header_iconv_h=no build_autoconf libass --enable-static --disable-shared \
  --disable-fontconfig --disable-coretext --enable-directwrite --disable-libunibreak

(
  cd "$work/src/ffmpeg"
  ./configure --prefix="$prefix" --arch=x86_64 --target-os=mingw32 --cc=gcc --cxx=g++ \
    --extra-version=motioncut --disable-autodetect --enable-zlib --disable-shared --enable-static \
    --enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx --enable-libopus --enable-libass \
    --pkg-config-flags=--static --extra-cflags="-I$native_prefix/include" \
    --extra-ldflags="-L$native_prefix/lib -static -static-libgcc -static-libstdc++" --extra-libs=-lstdc++ \
    --disable-ffplay --disable-doc --disable-debug
  make -j "$jobs" ffmpeg.exe ffprobe.exe
  cp ffmpeg.exe ffprobe.exe "$work/bin/"
)

# objdump sees imports without relying on PATH in the packaging environment.
# Keep compiler/runtime DLLs and MSYS2 out of the installer.
windows_root=$(cygpath -u "${SYSTEMROOT:-${SystemRoot:-C:/Windows}}")
for tool in ffmpeg ffprobe; do
  binary="$work/bin/$tool.exe"
  objdump -f "$binary" | grep 'file format pei-x86-64'
  objdump -p "$binary" | awk '/DLL Name:/ { print tolower($3) }' | sort -u > "$work/$tool-imports.txt"
  while IFS= read -r dll; do
    case "$dll" in
      api-ms-win-*.dll|ext-ms-win-*.dll) ;;
      *) if [[ ! -f "$windows_root/System32/$dll" ]]; then
           echo "Unexpected non-system dependency for $tool.exe: $dll" >&2
           exit 1
         fi ;;
    esac
  done < "$work/$tool-imports.txt"
done

"$work/bin/ffmpeg.exe" -buildconf > "$work/ffmpeg-configuration.txt" 2>&1
grep -- '--enable-gpl' "$work/ffmpeg-configuration.txt"
if grep -q -- '--enable-nonfree' "$work/ffmpeg-configuration.txt"; then
  echo 'Nonredistributable FFmpeg configuration.' >&2
  exit 1
fi
"$work/bin/ffmpeg.exe" -hide_banner -encoders > "$work/ffmpeg-encoders.txt"
"$work/bin/ffmpeg.exe" -hide_banner -decoders > "$work/ffmpeg-decoders.txt"
"$work/bin/ffmpeg.exe" -hide_banner -filters > "$work/ffmpeg-filters.txt"
for encoder in libx264 libx265 libvpx-vp9 libopus prores_ks aac; do
  grep -E "[[:space:]]$encoder[[:space:]]" "$work/ffmpeg-encoders.txt"
done
grep -E '[[:space:]]png[[:space:]]' "$work/ffmpeg-decoders.txt"
grep -E '[[:space:]]subtitles[[:space:]]' "$work/ffmpeg-filters.txt"
"$work/bin/ffprobe.exe" -version

cp "$work/src/ffmpeg/COPYING.GPLv2" "$work/notices/"
shopt -s nullglob
for component in ffmpeg x264 x265 vpx opus freetype harfbuzz fribidi libass zlib; do
  files=("$work/src/$component"/COPYING* "$work/src/$component"/LICENSE* "$work/src/$component"/PATENTS*)
  if [[ $component == freetype ]]; then
    files+=("$work/src/$component/docs/"{FTL,GPLv2}.TXT)
  fi
  mkdir "$work/notices/$component"
  cp "${files[@]}" "$work/notices/$component/"
done

# Link-time CRT/thread/compiler runtime material keeps its own license.
# Capture the license files shipped with the exact packages on this runner.
for pkg in gcc gcc-libs crt-git headers-git libwinpthread-git winpthreads-git; do
  package="mingw-w64-ucrt-x86_64-$pkg"
  if pacman -Q "$package" >> "$work/toolchain-versions.txt" 2>/dev/null; then
    while IFS= read -r license; do
      if [[ -f "$license" ]]; then
        mkdir -p "$work/notices/toolchain/$pkg"
        cp "$license" "$work/notices/toolchain/$pkg/"
      fi
    done < <(pacman -Qlq "$package" | grep '/share/licenses/' || true)
  fi
done

cat > "$work/notices/MEDIA-NOTICE.md" <<'NOTICE'
# FFmpeg and ffprobe for MotionCut on Windows

This installer includes the independently executable FFmpeg and ffprobe
command-line tools, built from FFmpeg 8.1.3 and linked to x264, x265, libvpx,
Opus, libass, FreeType, HarfBuzz, FriBidi and zlib. The GPL-enabled FFmpeg and
ffprobe executables are offered under version 2 of the GNU General Public
License, or at your option any later version. The bundled libraries retain
their respective copyright and license notices. MotionCut is independently
licensed under MIT and launches these tools as separate processes.

Download the exact corresponding sources and build script at:
https://github.com/Aningshuo/MotionCut/releases/download/v0.3.2-r2/MotionCut-FFmpeg-8.1.3-windows-x64-corresponding-source.zip
NOTICE

source_name=MotionCut-FFmpeg-8.1.3-windows-x64-corresponding-source
source_root="$work/$source_name"
mkdir -p "$source_root/archives"
while read -r _ archive; do
  cp "$archives/$archive" "$source_root/archives/"
done < "$work/SOURCE_SHA256SUMS"
cp "$recipe/"{build-windows.sh,windows-source-README.md} "$source_root/"
cp "$work/"{SOURCE_SHA256SUMS,ffmpeg-configuration.txt,ffmpeg-imports.txt,ffprobe-imports.txt,toolchain-versions.txt} "$source_root/"
cp -r "$work/notices" "$source_root/"
{
  awk -v zlib="$zlib_file" '$1 != zlib' "$recipe/SOURCE_URLS.tsv"
  printf '%s\t%s\n' "$zlib_file" "$zlib_url"
} > "$source_root/SOURCE_URLS.tsv"
(cd "$work" && zip -q -0 -r "$source_name.zip" "$source_name")
