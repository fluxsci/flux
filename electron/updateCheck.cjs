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

// Flux is installed and updated by ONE script (the curl line on the website). The single URL:
const INSTALL_SCRIPT_URL = "https://fluxsci.github.io/install.sh";

// The line a person pastes into a terminal (Linux updates: apt needs a password there).
function installLine({ update = false, url = INSTALL_SCRIPT_URL } = {}) {
  return `curl -fsSL ${url} | bash${update ? " -s -- --update" : ""}`;
}

// What "Update now" spawns on macOS: the same script, told to wait for this app's pid to exit,
// replace the installed app and reopen it. The URL is a constant and the pid an integer, so the
// shell string carries no caller-controlled text.
function updateSpawn({ pid, url = INSTALL_SCRIPT_URL } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("updateSpawn needs the running app's pid");
  if (!/^https:\/\/[\w.-]+\/[\w./-]*$/.test(url)) throw new Error("Unexpected install script URL");
  return { command: "/bin/bash", args: ["-c", `curl -fsSL '${url}' | bash -s -- --update --wait-pid ${pid} --relaunch`] };
}

module.exports = { versionIsNewer, pickRelease, INSTALL_SCRIPT_URL, installLine, updateSpawn };
