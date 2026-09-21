/** XML text/attribute syntax. Resource/paint policies are enforced separately. */
export function xmlEscape(value: unknown): string {
  return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
