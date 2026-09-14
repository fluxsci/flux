# Deterministic slide video fixture

`moving-box.mp4` is an original 160 × 90, 30 fps, 1.2 second H.264/AAC clip.
A 20 × 20 red square moves horizontally across white at 80 pixels/second;
the audio is a 440 Hz sine wave. `poster.png` is its first decoded frame.
No third-party media is used.

Generated with the pinned video encoder:

```sh
ffmpeg -f lavfi -i 'color=white:s=160x90:r=30:d=1.2' \
  -f lavfi -i 'color=red:s=20x20:r=30:d=1.2' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=1.2' \
  -filter_complex '[0:v][1:v]overlay=x=20+80*t:y=30:shortest=1[v]' \
  -map '[v]' -map 2:a -c:v libx264 -preset fast -crf 16 \
  -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart moving-box.mp4
ffmpeg -i moving-box.mp4 -frames:v 1 poster.png
```
