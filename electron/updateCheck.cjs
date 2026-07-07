// Pure update-decision helpers, split out of main.cjs so they're unit-testable
// without booting Electron (scripts/verify-update-check.ts requires this directly).
// The IPC handler in main owns the side effects (packaged-only guard, ≤1/day
// throttle, the GitHub fetch); everything that decides *what* to offer lives here.

// True iff dotted-numeric `latest` > `current` (major.minor.patch). Any
// `-prerelease` suffix and a leading `v` are ignored; malformed parts read as 0,
// and each component is compared numerically (so 0.1.10 > 0.1.9).
function versionIsNewer(latest, current) {
  const parse = (v) =>
    String(v)
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Given a GitHub `releases/latest` payload and the running version, return the
// update to offer as { version, url } — or null when the payload is unusable or
// the latest release isn't newer than what's running.
function pickRelease(json, currentVersion, fallbackUrl) {
  const tag = String((json && (json.tag_name || json.name)) || "").trim();
  if (!tag) return null;
  const version = tag.replace(/^v/i, "");
  if (!versionIsNewer(version, currentVersion)) return null;
  return { version, url: String((json && json.html_url) || fallbackUrl || "") };
}

module.exports = { versionIsNewer, pickRelease };
