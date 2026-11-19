# Windows x64 media tools

This archive contains the corresponding source of the standalone FFmpeg 8.1.3
and ffprobe executables distributed with MotionCut for Windows, including the
exact component archives, checksums, license notices and build script.
The GPL license applies to the FFmpeg executables. MotionCut is independently
distributed under MIT. The compiler and system components carry their own
licenses, which the build collects from MSYS2.

Build on x64 Windows in an MSYS2 UCRT64 shell. Install the UCRT64 toolchain,
CMake, Ninja, Meson and NASM. The tools installed in the GitHub runner are:

```sh
pacman -S --needed base-devel mingw-w64-ucrt-x86_64-toolchain \
  mingw-w64-ucrt-x86_64-{cmake,ninja,meson,nasm,pkgconf} curl zip
```

Verify sources and build from the unpacked archive:

```sh
(cd archives && sha256sum -c ../SOURCE_SHA256SUMS)
bash build-windows.sh archives /tmp/motioncut-win-media-build
```

The two executables will be in the work directory's `bin` directory. They
are linked statically to the listed multimedia libraries and use Windows
DirectWrite to locate subtitle fonts. Replacements may be installed in the
MotionCut installation directory at `resources/bin`.
