// WS-5.1: renderer-side quarantine for corrupt derived files. The FileBridge
// has no rename, so this is a COPY-out (`<file>.corrupt-<ts>`) — the user's
// bytes survive even though the next save may rewrite the original (same
// contract as flux-core's quarantineCorrupt, minus the move).

import type { FileBridge } from "./types";

export async function quarantineCopy(fb: FileBridge, path: string, text: string): Promise<string | null> {
  const dest = `${path}.corrupt-${Date.now()}`;
  try {
    await fb.writeText(dest, text);
    return dest;
  } catch {
    return null;
  }
}
