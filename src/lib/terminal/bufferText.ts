// Serialize an xterm screen buffer (scrollback + screen) to plain text — the
// transcript-capture core shared by the in-app Agent drawer (@xterm/xterm) and
// the `flux principal` PTY wrapper (@xterm/headless). Pure: structural typing
// only, no imports, so both packages' Terminal instances satisfy it.

export interface TerminalBufferLike {
  buffer: {
    normal: {
      length: number;
      getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** The rendered buffer as trimmed plain-text lines (trailing blank run dropped). */
export function serializeTerminalBuffer(term: TerminalBufferLike): string {
  const buf = term.buffer.normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

/** The on-disk transcript document shape (one per session). */
export function transcriptDoc(startedAtIso: string, body: string): string {
  return `# Principal session — ${startedAtIso}\n\n\`\`\`text\n${body}\n\`\`\`\n`;
}

/** Timestamp used in transcript filenames (local time, filesystem-safe). */
export function transcriptStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
