#!/usr/bin/env bash
set -euo pipefail

# Usage: bash build-macos.sh <archives-dir> <empty-working-dir>
# On macOS, install the Xcode command-line tools, cmake, meson, ninja and
# pkg-config; Intel builds additionally use nasm for SIMD assembly.
archives=$(cd "$1" && pwd -P)
mkdir -p "$2"
work=$(cd "$2" && pwd -P)
arch=$(uname -m)
case "$arch" in
  arm64|x86_64) ;;
  *) echo "Unsupported macOS build architecture: $arch" >&2; exit 1 ;;
esac
export MACOSX_DEPLOYMENT_TARGET=13.0
prefix="$work/prefix"
jobs=${MOTIONCUT_BUILD_JOBS:-6}
mkdir -p "$work/src" "$work/obj" "$prefix"
export PATH="$prefix/bin:$PATH"

unpack() {
  local name="$1" archive="$2"
  mkdir "$work/src/$name"
  tar -xf "$archives/$archive" --strip-components=1 -C "$work/src/$name"
}

unpack pkgconf pkgconf-2.5.1.tar.xz
unpack ffmpeg ffmpeg-8.1.3.tar.xz
unpack x264 x264-31e19f9.tar.gz
unpack x265 x265-4.2.tar.gz
unpack vpx libvpx-1.16.0.tar.gz
unpack opus opus-1.6.1.tar.gz
unpack freetype freetype-2.14.3.tar.xz
unpack harfbuzz harfbuzz-12.1.0.tar.gz
unpack fribidi fribidi-1.0.18.tar.xz
unpack libass libass-0.17.5.tar.xz

build_autoconf() (
  local name="$1"
  shift
  cd "$work/src/$name"
  ./configure --prefix="$prefix" "$@"
  make -j "$jobs"
  make install
)
build_cmake() {
  local name="$1" source="$2"
  shift 2
  cmake -S "$source" -B "$work/obj/$name" -G Ninja \
    -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_PREFIX_PATH="$prefix" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$work/obj/$name" --parallel "$jobs"
  cmake --install "$work/obj/$name"
}

build_autoconf pkgconf --disable-shared --enable-static
ln -sf pkgconf "$prefix/bin/pkg-config"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
unset PKG_CONFIG_PATH

build_autoconf x264 --enable-static --enable-pic --disable-cli --disable-opencl
build_cmake x265 "$work/src/x265/source" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=OFF
build_autoconf vpx --target="$arch-darwin22-gcc" --disable-examples \
  --disable-tools --disable-docs --disable-unit-tests --enable-pic
build_cmake opus "$work/src/opus" -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF
build_cmake freetype "$work/src/freetype" -DFT_DISABLE_BZIP2=TRUE -DFT_DISABLE_BROTLI=TRUE \
  -DFT_DISABLE_PNG=TRUE -DFT_DISABLE_ZLIB=TRUE -DFT_DISABLE_HARFBUZZ=TRUE
build_cmake harfbuzz "$work/src/harfbuzz" -DHB_HAVE_FREETYPE=ON -DHB_HAVE_ICU=OFF \
  -DHB_HAVE_GLIB=OFF -DHB_HAVE_GOBJECT=OFF -DHB_HAVE_GRAPHITE2=OFF -DHB_HAVE_CORETEXT=OFF
meson setup "$work/obj/fribidi" "$work/src/fribidi" --prefix "$prefix" \
  --buildtype release --default-library static -Ddocs=false -Dtests=false -Dbin=false
meson compile -C "$work/obj/fribidi" -j "$jobs"
meson install -C "$work/obj/fribidi"
build_autoconf libass --enable-static --disable-shared --disable-fontconfig --enable-coretext --disable-libunibreak

(
  cd "$work/src/ffmpeg"
  ./configure --prefix="$prefix" --extra-version=motioncut \
    --disable-autodetect --enable-zlib --disable-shared --enable-static --enable-gpl \
    --enable-libx264 --enable-libx265 --enable-libvpx --enable-libopus --enable-libass \
    --pkg-config-flags=--static --extra-cflags="-I$prefix/include" \
    --extra-ldflags="-L$prefix/lib" --extra-libs=-lc++ \
    --disable-ffplay --disable-doc --disable-debug
  make -j "$jobs" ffmpeg ffprobe
  mkdir -p "$work/bin"
  cp ffmpeg ffprobe "$work/bin/"
  cp ffbuild/config.log ffbuild/config.mak "$work/"
)
