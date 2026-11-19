# Windows x64 packaging

The [Windows release workflow](../../.github/workflows/windows-release.yml) runs on Windows x64. It builds and checks native FFmpeg and ffprobe from pinned sources, downloads the matching Electron and Playwright runtimes, and builds the per-user NSIS installer. End users do not need developer tools or a separate FFmpeg installation.

For a release, run the workflow from `main` with the publish option selected. The publish job uploads the installer, corresponding FFmpeg source archive and SHA-256 checksums to the existing release tag only after the installed copy starts and passes ordinary MP4 export, Chinese subtitle burn-in, complete video decoding and uninstall tests. The Actions artifacts retain the same checked files for diagnosis.

The source build is documented in [FFmpeg for Windows](../ffmpeg/windows-source-README.md). The installer uses the displayed publisher name `Aningshuo` and currently has no Authenticode signature.
