/** Offline host defense in depth. Passive SVG/resource policy is applied upstream. */
export async function offlineHtmlPolicy(scripts: readonly string[]): Promise<string> {
  const hashes = await Promise.all(scripts.map(async script => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)));
    return `'sha256-${btoa(String.fromCharCode(...bytes))}'`;
  }));
  return `default-src 'none'; script-src ${hashes.length ? hashes.join(" ") : "'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
}
