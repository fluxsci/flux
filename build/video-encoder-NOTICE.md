# Slide video encoder

Flux invokes an unmodified FFmpeg executable as a separate command-line program.
The encoder and its dependencies retain their upstream licenses; Flux's MIT
license does not replace those licenses. The upstream `LICENSE` and `README`
files are shipped beside the executable, along with its verification manifest.

One FFmpeg version on every platform: **9.0.2** (tag `n9.0.2`), so the media
Flux writes — including HDR tone mapping to SDR — is the same wherever it runs.
The earlier pin repackaged three builders at three versions (7.0.2 on Linux,
6.1.1 on Windows, 6.0 on macOS) and the HDR calibration gate caught the
difference on Windows; see the engineering guide, 2026-09-25.

Pinned binaries and accompanying notices:

- Linux x64 / arm64 and Windows x64: BtbN FFmpeg static auto-builds, release
  `autobuild-2026-09-25-15-37`, build `n9.0.2-8-gb135b25c19`, GPL variant.
  https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-25-15-37
  The archive's `LICENSE.txt` (GNU GPL v3) ships as `LICENSE`; the builder's
  README at the commit current when the release was published ships as `README`.
- macOS arm64 / x64: static builds by Martin Riedl (`--enable-gpl
  --enable-version3`, so GNU GPL v3), builds `1789931890_9.0.2` and
  `1789931006_9.0.2`. https://ffmpeg.martin-riedl.de/
  The archive holds the executable only; FFmpeg's own `LICENSE.md` at tag
  `n9.0.2` ships as `LICENSE`, and the build's `versions.txt` (configuration
  and library versions) ships as `README`.

Upstream source: https://github.com/FFmpeg/FFmpeg/tree/n9.0.2 and
https://ffmpeg.org/download.html. `ffmpeg -version` lists the actual build
configuration. The download manifest in Flux (`build/video-encoder.json`) pins
every archive and every notice by SHA-256 and byte size, and names the
executable's path inside the archive. No patches are made to the executable. It
is used to probe media, to encode H.264 MP4 files with libx264 and optional AAC
audio, and to normalize HDR sources to SDR.

FFmpeg incorporates work of the Independent JPEG Group. Flux makes no changes to
the IJG-derived files in FFmpeg.
