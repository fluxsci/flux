/** Project-owned stored assets use relative paths; external source links have a
 * separate explicit capability. Nested and legacy directory layouts are valid. */
export function storedAssetPath(rel: unknown): string {
  if (typeof rel !== 'string' || !rel || /[\\\x00]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel)) throw new Error(`Invalid stored asset path: ${String(rel)}`);
  const segments: string[]=[];
  for (const part of rel.split('/')) {
    if (!part || part==='.') continue;
    if (part==='..') { if (!segments.length) throw new Error(`Asset escapes project root: ${rel}`); segments.pop(); }
    else segments.push(part);
  }
  if (!segments.length) throw new Error(`Invalid stored asset path: ${rel}`);
  return segments.join('/');
}
