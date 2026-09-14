# Slide video encoder

Flux invokes an unmodified FFmpeg executable as a separate command-line program.
The encoder and its dependencies retain their upstream licenses; Flux's MIT
license does not replace those licenses. The upstream `LICENSE` and `README`
files are shipped beside the executable, along with its verification manifest.

Pinned binaries and accompanying notices:
https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1

Upstream build and source information:
https://github.com/eugeneware/ffmpeg-static
https://ffmpeg.org/download.html
https://github.com/FFmpeg/FFmpeg/tree/n6.1.1

The platform README includes additional build/dependency information where the
binary provider supplies it. `ffmpeg -version` lists the actual build configuration.
The download manifest in Flux (`build/video-encoder.json`) pins every downloaded
binary archive and upstream notice by SHA-256 and byte size. No patches are made
to the executable. It is used to encode H.264 MP4 files with libx264 and optional AAC audio.

FFmpeg incorporates work of the Independent JPEG Group. Flux makes no changes to
the IJG-derived files in FFmpeg.
