#!/usr/bin/env bash
# FigForge dev launcher.
#
#   ./dev.sh             native Wayland, accelerated compositing forced
#   RENDER=x11 ./dev.sh  run the webview under XWayland
#
# WEBKIT_DISABLE_DMABUF_RENDERER=1 crashes on this Blackwell GPU, so it is NOT set.
source "$HOME/.cargo/env" 2>/dev/null

# Force WebKit to use accelerated (GPU) compositing for layers.
export WEBKIT_FORCE_COMPOSITING_MODE=1

if [ "$RENDER" = "x11" ]; then
  export GDK_BACKEND=x11
fi

cd "$(dirname "$0")"
exec npm run tauri dev
