/** Lossless source-span scanner. It never rewrites input and never treats a
 * nested field-like string, comment email or structural record as a paper. */
export interface BibFieldSpan { name: string; start: number; end: number; valueStart: number; valueEnd: number; value: string; terms: {value: string; macro: boolean}[] }
export interface BibRecord { kind: "entry" | "string" | "comment" | "preamble"; type: string; start: number; end: number; key: string | null; keyStart: number; keyEnd: number; fields: BibFieldSpan[] }
export interface BibDiagnostic { offset: number; line: number; message: string }
export interface BibScan { records: BibRecord[]; diagnostics: BibDiagnostic[] }
export function scanBib(text: string): BibScan {
  const records: BibRecord[] = [], diagnostics: BibDiagnostic[] = [];
  const fail = (offset: number, message: string) => diagnostics.push({ offset, line: text.slice(0, offset).split("\n").length, message });
  const skip = (at: number, limit: number) => {
    while (at < limit) {
      if (/\s/.test(text[at])) { at++; continue; }
      if (text[at] === "%") { const end = text.indexOf("\n", at); at = end < 0 ? limit : end + 1; continue; }
      break;
    }
    return at;
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "%") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end + 1; continue; }
    if (text[i] !== "@") { i++; continue; }
    const head = /^@([a-zA-Z][\w-]*)\s*([{(])/.exec(text.slice(i));
    if (!head) { i++; continue; }
    const start = i, type = head[1].toLowerCase(), open = i + head[0].length - 1, close = head[2] === "{" ? "}" : ")";
    let depth = 0, quoted = false, end = open + 1;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "\\") { end++; continue; }
      if (!quoted && c === "%" && depth === 0) { const line = text.indexOf("\n", end); if (line < 0) { end = text.length; break; } end = line; continue; }
      if (c === '"' && depth === 0) { quoted = !quoted; continue; }
      if (c === "{") depth++;
      else if (c === "}" && depth > 0) depth--;
      else if (c === close && !quoted && depth === 0) break;
    }
    if (end >= text.length) { fail(start, `Unterminated @${type} record`); break; }
    const kind = ["string", "comment", "preamble"].includes(type) ? type as "string" | "comment" | "preamble" : "entry";
    const record: BibRecord = { kind, type, start, end: end + 1, key: null, keyStart: -1, keyEnd: -1, fields: [] };
    let p = skip(open + 1, end);
    if (kind === "entry") {
      record.keyStart = p;
      while (p < end && text[p] !== "," && !/\s/.test(text[p])) p++;
      record.keyEnd = p; record.key = text.slice(record.keyStart, p);
      if (!record.key) fail(start, "Empty BibTeX key");
      p = skip(p, end);
      if (p < end && text[p] !== ",") fail(p, "Expected comma after citekey");
      if (text[p] === ",") p++;
    }
    if (kind === "entry" || kind === "string") {
      while ((p = skip(p, end)) < end) {
        if (text[p] === ",") { p++; continue; }
        const fieldStart = p;
        const name = /^[\w:-]+/.exec(text.slice(p, end));
        if (!name) { fail(p, "Expected field name"); break; }
        p += name[0].length; p = skip(p, end);
        if (text[p] !== "=") { fail(p, "Expected = after field name"); break; }
        p = skip(p + 1, end); const valueStart = p;
        const terms: {value: string; macro: boolean}[] = [];
        while (p < end) {
          p = skip(p, end);
          if (text[p] === "{" || text[p] === '"') {
            const termOpen = text[p++], termStart = p; let nested = 0;
            for (; p < end; p++) {
              const c = text[p];
              if (c === "\\") { p++; continue; }
              if (c === "{") nested++;
              else if (c === "}" && nested > 0) nested--;
              else if (nested === 0 && c === (termOpen === "{" ? "}" : '"')) break;
            }
            terms.push({value: text.slice(termStart, p), macro: false}); p++;
          } else {
            const termStart = p;
            while (p < end && !/[#,\s]/.test(text[p])) p++;
            if (p === termStart) { fail(p, "Expected field value"); break; }
            terms.push({value: text.slice(termStart, p), macro: true});
          }
          p = skip(p, end);
          if (text[p] !== "#") break;
          p++;
        }
        const valueEnd = p;
        record.fields.push({ name: name[0].toLowerCase(), start: fieldStart, end: p, valueStart, valueEnd, value: terms.map(t => t.value).join(""), terms });
        if (p < end && text[p] !== ",") { fail(p, "Expected comma between fields"); break; }
        p++;
      }
    }
    records.push(record); i = end + 1;
  }
  return { records, diagnostics };
}
export function assertBibValid(text: string): BibScan {
  const result = scanBib(text);
  if (result.diagnostics.length) { const d = result.diagnostics[0]; throw new Error(`Malformed BibTeX at line ${d.line}, offset ${d.offset}: ${d.message}. Original text preserved.`); }
  return result;
}
export function rawBibField(raw: string, name: string): string | null {
  const record = scanBib(raw).records.find(r => r.kind === "entry");
  return record?.fields.find(f => f.name === name.toLowerCase())?.value ?? null;
}

/** Resolve macros only for projection; raw canonical spans remain untouched. */
export function bibMacroMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of scanBib(text).records) if (record.kind === "string") for (const field of record.fields) {
    map.set(field.name, projectBibValue(field, map));
  }
  return map;
}
export function projectBibValue(field: BibFieldSpan, macros: Map<string, string>): string {
  return field.terms.map(term => term.macro ? macros.get(term.value.toLowerCase()) ?? term.value : term.value).join("");
}
