// Zotero PDF attachments on import (2.4). Better-BibTeX writes a `file` field on each
// entry pointing at the attached PDF(s); parsing it lets a .bib import pull the actual
// papers in — not just the metadata. Pure (no I/O): extract the field, split its
// (possibly multi-attachment, escaped) value into {desc, path, mime}. The importer
// resolves the paths against the user-picked Zotero folder and copies the PDFs.

export interface ZoteroFile {
  desc: string; // human label ("Full Text PDF") — often empty
  path: string; // filesystem path (absolute, or relative to the Zotero data dir)
  mime: string; // e.g. "application/pdf" — often empty
}

// Split on an UNescaped delimiter, honoring Better-BibTeX escapes. It escapes only the
// three meaningful chars — `:` `;` `\` — as `\:` `\;` `\\`; a backslash before anything
// else is a literal Windows path separator and MUST be kept. Handling only those three
// as escapes de-ambiguates both export conventions (single-backslash `C\:\Users` and
// doubled-backslash `C\:\\Users`) to the same real path.
const ESCAPABLE = new Set([":", ";", "\\"]);
function splitUnescaped(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      cur += s[i + 1]; // drop the backslash, keep the escaped char
      i++;
    } else if (c === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Parse a Better-BibTeX `file` field VALUE (the text inside `file = {…}`) into its
 *  attachments. Handles the `desc:path:mime` triple, bare `path`, multi-attachment
 *  `a;b;c`, and `\:`/`\;`/`\\` escapes. Non-PDF-looking entries are kept (the caller
 *  filters by mime/extension). */
export function parseZoteroFileField(value: string): ZoteroFile[] {
  const out: ZoteroFile[] = [];
  for (const chunk of splitUnescaped(value, ";")) {
    if (!chunk.trim()) continue;
    const parts = splitUnescaped(chunk, ":").map((p) => p.trim());
    let desc = "";
    let path = "";
    let mime = "";
    if (parts.length >= 3) {
      // desc : path : mime — but a Windows path like "C:\..." can itself contain a
      // colon that survived un-escaped in older exports; the mime is always the LAST
      // part and the desc the FIRST, so treat everything between as the path.
      desc = parts[0];
      mime = parts[parts.length - 1];
      path = parts.slice(1, -1).join(":");
    } else if (parts.length === 2) {
      // Ambiguous 2-part: "path:mime" (has a mime) or "desc:path". Decide by which side
      // looks like a path (has a separator or a file extension).
      const looksPath = (p: string) => /[\\/]/.test(p) || /\.[a-z0-9]{2,4}$/i.test(p);
      if (looksPath(parts[0]) && !looksPath(parts[1])) {
        path = parts[0];
        mime = parts[1];
      } else {
        desc = parts[0];
        path = parts[1];
      }
    } else {
      path = parts[0];
    }
    if (path) out.push({ desc, path, mime });
  }
  return out;
}

/** Extract a single field's raw value from one BibTeX entry block. Handles brace-
 *  wrapped `{…}` (balanced), quote-wrapped `"…"`, and bare values. Returns null if the
 *  field is absent. Case-insensitive on the field name; `file` won't match `profile`. */
export function extractBibField(raw: string, field: string): string | null {
  const re = new RegExp(`(?:^|[\\s,{])${field}\\s*=\\s*`, "i");
  const m = re.exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  const open = raw[i];
  if (open === "{") {
    let depth = 0;
    const start = i + 1;
    for (; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}" && --depth === 0) return raw.slice(start, i);
    }
    return null; // unbalanced
  }
  if (open === '"') {
    const end = raw.indexOf('"', i + 1);
    return end < 0 ? null : raw.slice(i + 1, end);
  }
  const rest = raw.slice(i);
  const end = rest.search(/[,\n}]/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** The PDF attachments declared on a raw BibTeX entry (empty when it has no `file`
 *  field or none of them look like PDFs). */
export function bibPdfAttachments(raw: string): ZoteroFile[] {
  const value = extractBibField(raw, "file");
  if (!value) return [];
  return parseZoteroFileField(value).filter(
    (f) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.path),
  );
}
