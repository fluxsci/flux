// The verification manifest uses a small, path-oriented glob language: literal
// characters, * within one segment, ** across segments, and brace alternatives.
// Compile alternatives recursively so nested braces work without expanding a
// potentially large Cartesian product. Git supplies repository-relative / paths.
export function globToRegExp(glob) {
  const compile = (pattern) => {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "{") {
        let depth = 1, end = i + 1, start = end;
        const alternatives = [];
        for (; end < pattern.length && depth; end++) {
          if (pattern[end] === "{") depth++;
          else if (pattern[end] === "}") depth--;
          if (depth === 1 && pattern[end] === ",") {
            alternatives.push(pattern.slice(start, end));
            start = end + 1;
          } else if (depth === 0) alternatives.push(pattern.slice(start, end));
        }
        if (depth === 0 && alternatives.length > 1) {
          out += `(?:${alternatives.map(compile).join("|")})`;
          i = end - 1;
          continue;
        }
      }
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          i++;
          if (pattern[i + 1] === "/") {
            out += "(?:[^/]+/)*"; // **/ includes zero directory segments.
            i++;
          } else out += "[\\s\\S]*"; // Terminal ** also includes filenames.
        } else out += "[^/]*";
      } else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return out;
  };
  return new RegExp(`^${compile(glob)}$`);
}

// Entry order is intentional: each file contributes only its first match's run
// set. Unknown paths (or no diff) retain the pure tier as a safety floor.
export function collectChangedRuns(files, pathMap = []) {
  const entries = pathMap.map((entry) => ({ ...entry, re: globToRegExp(entry.glob) }));
  const wanted = new Set();
  let unmatched = files.length === 0;
  for (const file of files) {
    const hit = entries.find((entry) => entry.re.test(file));
    if (!hit) unmatched = true;
    else for (const run of hit.run) wanted.add(run === "self" ? `self:${file}` : run);
  }
  if (unmatched) wanted.add("tier:pure");
  return wanted;
}

// Literal filenames are used throughout the manifest alongside tier/group/self.
// Require literals to name registered scripts, keeping typos and path escapes
// visible instead of silently dropping the intended check.
export function resolveChangedRuns(wanted, manifest) {
  const knownScripts = new Set(Object.values(manifest.tiers).flat());
  const scripts = new Set(), diagnostics = [];
  const addScript = (name) => {
    if (knownScripts.has(name)) scripts.add(name);
    else diagnostics.push(`pathMap names unknown script "${name}" — skipped`);
  };
  for (const run of wanted) {
    if (run.startsWith("tier:") || run.startsWith("group:")) {
      const kind = run.startsWith("tier:") ? "tier" : "group";
      const name = run.slice(kind.length + 1);
      const list = (kind === "tier" ? manifest.tiers : manifest.groups)[name];
      if (list) list.forEach((script) => scripts.add(script));
      else diagnostics.push(`pathMap names unknown ${kind} "${name}" — skipped`);
    } else if (run.startsWith("self:")) {
      const file = run.slice(5);
      if (/^scripts\/(?:verify-|figenh-)[^/]+$/.test(file)) addScript(file.slice("scripts/".length));
      else diagnostics.push(`pathMap self target "${file}" is not a verify script — skipped`);
    } else addScript(run);
  }
  return { scripts: [...scripts], diagnostics };
}
