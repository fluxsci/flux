"use strict";
// flux:// protocol URL parsing for web capture, factored out of main.cjs so it can
// be unit-tested without Electron. Pure string work.

/** Parse a flux://add?doi=…|url=… URL into a capture payload, or null if it's not a
 *  recognized capture URL. (host is "add" on most platforms; some put it in path.) */
function parseFluxUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "flux:") return null;
  const action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action && action !== "add") return null;
  const doi = (u.searchParams.get("doi") || "").trim();
  if (doi) return { doi };
  const url = (u.searchParams.get("url") || "").trim();
  if (url) return { url };
  return null;
}

/** Find a flux:// URL in a process argv array (Windows/Linux deliver the protocol
 *  URL as a launch argument rather than via the macOS open-url event). */
function fluxUrlFromArgv(argv) {
  return (argv || []).find((a) => /^flux:\/\//i.test(String(a))) || null;
}

module.exports = { parseFluxUrl, fluxUrlFromArgv };
