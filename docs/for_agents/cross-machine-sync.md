# Continuous folder sync between two personal machines

**A runbook, not an essay.** It builds one always-on synced folder between two computers you
own, over a private mesh VPN, with no cloud service in the path. Written to be executed by an
agent on the user's behalf: every decision that was already argued out is recorded as a
decision, so it doesn't get re-litigated, and every failure that cost a round trip is recorded
as a trap with its exact symptom.

Built and verified with **Syncthing v2.1.3 over Tailscale**, Linux ↔ macOS, on an 8.4 GB
folder of ~4600 files. Reproduce it in about 30 minutes of hands-on time plus the initial
seed transfer.

---

## 0. What this is for, and when not to use it

Use this when a folder is **the same working state on two machines** — a reference library, an
app's config and data directory, a set of working projects. You want to sit down at either
machine and just start, with no push/pull ritual and nothing to remember.

Do **not** use this when:

- You want *history* and deliberate checkpoints — that's git. (You can have both: `git init`
  inside a folder that also syncs. See §11.)
- More than one machine will edit the same files *at the same time*. This design assumes
  **one machine at a time**. It survives violations (that's what §9 is for), but it isn't a
  collaboration system.
- The data must be shared with someone else, or reachable from a machine you don't control.

### Decisions already made — don't re-derive these

| Decision | Why |
|---|---|
| **Syncthing**, not a cloud drive | No third party holds the data; no per-GB cost; handles big binary files and huge trees natively; block-level dedup means duplicate files cross the wire once. |
| **Over a mesh VPN** (Tailscale, or WireGuard / ZeroTier) | Gives every machine a stable address that works from anywhere with no port forwarding, no dynamic-DNS, and no firewall holes. |
| **Discovery and relays OFF** | Peers are reached by explicit VPN address only. Nothing about this setup touches the public internet or a stranger's relay. |
| **Staggered file versioning ON, stored OUTSIDE the folder** | It's the undo. Storing it outside keeps a `.stversions` tree from appearing inside the synced folder, where the application's own file watchers would walk it. |
| **`sendreceive` on both sides** | Either machine may be the one you're working on. |
| **Ignore list decided BEFORE the first sync** | Cheap now; painful to unwind after a machine-specific file has propagated. |

---

## 1. Parameters

Fill these in once; everything below refers to them.

```
FOLDER_PATH   the directory to sync, same relative location on both machines (e.g. ~/Data)
FOLDER_ID     a short stable slug, IDENTICAL on both machines (e.g. my-data)
              — this is the join key; a mismatch means two folders that never pair
MACHINE_A     the machine that already has the good data (the seed)
MACHINE_B     the machine that will receive it
PEER_ADDR_A   MACHINE_A's VPN address, e.g. tcp://100.x.y.z:22000
PEER_ADDR_B   MACHINE_B's VPN address
VERSIONS_PATH somewhere OUTSIDE FOLDER_PATH, e.g. ~/.local/state/syncthing-versions/<FOLDER_ID>
```

**Which machine is A matters.** Syncing into a non-empty folder on B *merges* both sides by
newest-modified-time, which can push B's stale copies over A's current data. Either make B's
folder empty first (`mv <FOLDER_PATH> <FOLDER_PATH>.premerge`) or accept the merge knowingly.

---

## 2. Prerequisites

1. **The mesh VPN is up on both machines and they can reach each other.** Verify with a ping
   over the VPN address, not a hostname.
2. **Note the VPN addresses.** Use the address, not a magic-DNS name — it's one less
   resolver in the path when you're debugging.
3. **Know whether you have root on each machine.** You don't need it (§3.1 installs
   user-local), but it changes the install route.

> **Trap — the VPN CLI may not exist on a machine that's running the VPN.** On macOS the
> Tailscale GUI app ships its binary inside the app bundle
> (`/Applications/Tailscale.app/Contents/MacOS/`), so `tailscale` is not on `PATH`. Never
> write a setup script that shells out to the VPN CLI. Detect and warn; don't depend.

---

## 3. Install (do on both machines)

### 3.1 Linux, no root — user-local tarball

Preferred even when you *do* have root: a tarball install keeps Syncthing's **built-in
auto-upgrade**, which distro packages disable.

```bash
mkdir -p ~/.local/bin && cd "$(mktemp -d)"
# fetch the current release tarball + checksums for your arch from
#   https://github.com/syncthing/syncthing/releases
curl -fLO https://github.com/syncthing/syncthing/releases/download/v<VER>/syncthing-linux-amd64-v<VER>.tar.gz
curl -fLO https://github.com/syncthing/syncthing/releases/download/v<VER>/sha256sum.txt.asc
grep "syncthing-linux-amd64-v<VER>.tar.gz" sha256sum.txt.asc | sha256sum -c -   # MUST print OK
tar xf syncthing-linux-amd64-v<VER>.tar.gz
install -m755 syncthing-linux-amd64-v<VER>/syncthing ~/.local/bin/syncthing
syncthing version
```

### 3.2 macOS

```bash
brew install syncthing
```

Install only. **Do not `brew services start syncthing`** — see §5.2 for why, and what to do
instead.

### 3.3 Windows

Not exercised in this build. The equivalent shape: install the official Windows package (or
SyncTrayzor), and make it persistent with a Scheduled Task at logon rather than a console
window. Everything in §4 and §6–§11 applies unchanged — the REST API is identical.

### 3.4 Generate identity

```bash
syncthing generate          # creates config.xml + device key; safe if one already exists
syncthing device-id         # this machine's device ID — you will need it on the other machine
```

> **Never hardcode config paths.** Syncthing v2 moved off `~/.config`; on Linux it now lives
> in `~/.local/state/syncthing/`. Always ask:
> ```bash
> CONF="$(syncthing paths | awk '/Configuration file:/{getline;gsub(/^[ \t]+/,"");print;exit}')"
> API="$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$CONF" | head -1)"
> GUI="$(sed -n '/<gui /,/<\/gui>/p' "$CONF" | sed -n 's:.*<address>\(.*\)</address>.*:\1:p' | head -1)"
> : "${GUI:=127.0.0.1:8384}"
> ```
> The value follows the label on the *next* line — hence the `getline`. Reading the GUI
> address out of config instead of assuming `8384` removes a whole class of false "the API
> never came up" reports.

---

## 4. Configure via the REST API (do on both machines)

The web UI works, but the API is scriptable, idempotent, and reviewable. All calls take
`-H "X-API-Key: $API"` against `http://$GUI`.

Use this helper — it prints the status code and, **on failure, the response body**:

```bash
req() { # req METHOD PATH [BODY]
  local m="$1" p="$2" b="${3:-}" out code
  if [ -n "$b" ]; then
    out="$(curl -sS -X "$m" -H "X-API-Key: $API" -H "Content-Type: application/json" \
           "http://$GUI$p" --data-binary "$b" -w $'\n%{http_code}')"
  else
    out="$(curl -sS -X "$m" -H "X-API-Key: $API" "http://$GUI$p" -w $'\n%{http_code}')"
  fi
  code="$(printf '%s' "$out" | tail -1)"
  printf '  HTTP %s\n' "$code"
  case "$code" in 2*) return 0 ;;
    *) printf '  response body:\n'; printf '%s' "$out" | sed '$d' | sed 's/^/    /'; return 1 ;;
  esac
}
```

> **Trap that cost a full round trip.** Escaped `\"` inside `$( )` nested in a double-quoted
> string reaches curl as *literal backslashes* → invalid JSON → **HTTP 400**, while a
> single-quoted body in the same script succeeds. Build every JSON body with an **unquoted
> heredoc** (below) or single quotes. And never `-o /dev/null` a request whose error body you
> might need — that's what turned a one-line JSON bug into a round trip.

### 4.1 Lock networking to the VPN

```bash
req PATCH /rest/config/options '{
  "globalAnnounceEnabled": false,
  "localAnnounceEnabled":  false,
  "relaysEnabled":         false,
  "natEnabled":            false,
  "startBrowser":          false,
  "crashReportingEnabled": false,
  "urAccepted":            -1,
  "listenAddresses": ["tcp://0.0.0.0:22000", "quic://0.0.0.0:22000"]
}'
```

Identical on both machines. Discovery off + relays off means the *only* way these two find
each other is the explicit address in §4.2 — which is exactly the intent.

### 4.2 Add the peer

```bash
DEVICE_JSON="$(cat <<JSON
{
  "deviceID": "$PEER_DEVICE_ID",
  "name": "$PEER_NAME",
  "addresses": ["$PEER_ADDR"],
  "compression": "metadata"
}
JSON
)"
req POST /rest/config/devices "$DEVICE_JSON"
```

Each machine gets the *other* one's device ID and VPN address. Pairing is mutual — nothing
transfers until both sides have named each other.

### 4.3 Add the folder

```bash
mkdir -p "$FOLDER_PATH" "$VERSIONS_PATH"
FOLDER_JSON="$(cat <<JSON
{
  "id": "$FOLDER_ID",
  "label": "$FOLDER_LABEL",
  "path": "$FOLDER_PATH",
  "type": "sendreceive",
  "devices": [{"deviceID": "$MY_DEVICE_ID"}, {"deviceID": "$PEER_DEVICE_ID"}],
  "rescanIntervalS": 3600,
  "fsWatcherEnabled": true,
  "fsWatcherDelayS": 10,
  "versioning": {
    "type": "staggered",
    "params": {"cleanInterval": "3600", "maxAge": "2592000"},
    "cleanupIntervalS": 3600,
    "fsPath": "$VERSIONS_PATH",
    "fsType": "basic"
  }
}
JSON
)"
req POST /rest/config/folders "$FOLDER_JSON"
```

`fsWatcher` gives near-instant propagation; the hourly rescan is the backstop for anything the
watcher misses. `maxAge: 2592000` is a 30-day version history. Note `fsPath` is **outside**
`FOLDER_PATH` — see §0.

Verify what landed:

```bash
curl -fsS -H "X-API-Key: $API" "http://$GUI/rest/config/devices" \
  | tr '{' '\n' | sed -n 's/.*"deviceID":"\([A-Z0-9-]*\)".*"name":"\([^"]*\)".*/    \2  \1/p'
curl -fsS -H "X-API-Key: $API" "http://$GUI/rest/config/folders" \
  | tr '{' '\n' | sed -n 's/.*"id":"\([^"]*\)".*"path":"\([^"]*\)".*/    \1 -> \2/p'
```

---

## 5. Make it persistent

A sync daemon that doesn't survive logout is worse than no sync, because you'll trust it.

### 5.1 Linux — systemd **user** service + linger

`~/.config/systemd/user/syncthing.service`:

```ini
[Unit]
Description=Syncthing - Continuous File Synchronization
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=4

[Service]
ExecStart=%h/.local/bin/syncthing serve --no-browser --no-restart --logflags=0
Restart=on-failure
RestartSec=5
SuccessExitStatus=3 4
RestartForceExitStatus=3 4
ProtectSystem=full
PrivateTmp=true
SystemCallArchitectures=native
MemoryDenyWriteExecute=true
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now syncthing
loginctl enable-linger "$USER"     # ← without this it dies at logout
```

`--no-restart` hands restart duty to systemd; `SuccessExitStatus=3 4` lets Syncthing's own
upgrade/restart exit codes be handled correctly rather than looking like crashes.

### 5.2 macOS — your own LaunchAgent, not `brew services`

> **Trap.** `brew services start syncthing` reported success while its LaunchAgent **never
> ran**: `brew services list` showed status `other`, `launchctl print` showed
> `state = not running` with no process and no exit code, and it never wrote its log file.
> Syncthing itself was fine — launched by hand the API was up in ~1 s. Diagnosing this from
> "sync isn't working" is expensive; skip it and own the agent.

`~/Library/LaunchAgents/local.syncthing.plist` (substitute the real binary path and `$HOME`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>local.syncthing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/syncthing</string>
        <string>serve</string>
        <string>--no-browser</string>
        <string>--no-restart</string>
        <string>--logflags=3</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityIO</key><true/>
    <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/syncthing.log</string>
    <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/syncthing.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>/Users/YOU</string>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
```

```bash
plutil -lint ~/Library/LaunchAgents/local.syncthing.plist
brew services stop syncthing 2>/dev/null; launchctl bootout "gui/$(id -u)/homebrew.mxcl.syncthing" 2>/dev/null
pkill -f 'syncthing serve'; sleep 3
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.syncthing.plist
launchctl kickstart  "gui/$(id -u)/local.syncthing"
launchctl print      "gui/$(id -u)/local.syncthing" | grep -iE '^\s*(state|pid) '
```

**Then never run `brew services start syncthing` on that machine** — two supervisors fighting
over one daemon is a bad afternoon.

Startup is not instant on a large folder: allow up to ~120 s for the API on first launch while
it opens the index. A 45-second timeout will lie to you.

---

## 6. The ignore list — design it before the first sync

Write `<FOLDER_PATH>/.stignore` **identically on both machines**. Syncthing does not propagate
it for you; `.stignore`, `.stfolder` and `.stversions` are never synced.

Syntax notes that matter: a leading `/` anchors to the folder root; `(?d)` means "delete this
if it's the only thing left in a directory"; and **Syncthing never descends into a
fully-ignored directory**, so a negation (`!`) underneath a directory-level ignore is dead —
you must ignore at the child level (`/dir/*`) for negations above it to work.

Sort every path into four buckets. The middle two are where the real damage lives.

**1. Machine-specific — must never sync.** Anything holding absolute paths for *this* install,
or secrets sealed to *this* machine. Encrypted-with-the-OS-keychain files are the sharp case:
they sync fine and are undecryptable on the other side, so you get a working-looking file that
fails at use.

**2. Watched inboxes and anything that TRIGGERS AN ACTION on arrival.** The most dangerous
category, and the least obvious. If an application watches a directory and *acts* on new files
— moves them, renames them, files them somewhere — then syncing that directory means **both
machines start the same job on the same file**. Any lock the app holds is almost certainly
per-machine and will not save you. Exclude the inbox; the *result* directory syncs fine.

**3. Derived caches.** Rebuildable per machine, often large, and they churn. Exclude by
default. The exception worth thinking about is a cache that is expensive in a way rebuilding
can't fix — one built from thousands of *network* fetches, say. Sync that one selectively, at
the child level, and leave its big volatile siblings out.

**4. Re-downloadable assets.** Model weights, runtimes, installers. Excluding these is often
the single biggest win: one such directory took the seed from 11 GB to 8.4 GB here.

Also exclude transient junk: the app's own atomic-write temp pattern, backup tarballs,
`(?d).DS_Store`, `(?d)Thumbs.db`.

Template:

```
// Ignore list — set IDENTICALLY on both machines.

// ── machine-specific: must never sync ────────────────────────────────
/config-with-absolute-paths.json
/secret-sealed-to-this-keychain.json

// ── watched inboxes: each machine keeps its own ──────────────────────
// arrival here starts a job that MOVES files; two synced inboxes = two
// engines racing. The result directory does sync.
/inbox

// ── derived caches: rebuilt per machine ──────────────────────────────
/.cache
// to keep ONE expensive child, use the child-level form instead:
//   !/.cache/expensive.json
//   /.cache/*

// ── re-downloadable assets ───────────────────────────────────────────
/Models

// ── transient ────────────────────────────────────────────────────────
*-backup-*.tar.gz
.*.tmp-*-*
(?d).DS_Store
(?d)Thumbs.db
```

Confirm Syncthing actually parsed it (an unparsed pattern is silent):

```bash
curl -fsS -H "X-API-Key: $API" "http://$GUI/rest/db/ignores?folder=$FOLDER_ID"
```

---

## 7. Verify — from the *other* machine

The local web UI saying "Up to Date" only means *this* machine has nothing left to do. Check
the peer's completion **from the opposite machine**:

```bash
# is the peer connected, and how? (want a direct tcp-client/tcp-server, not "relay")
curl -fsS -H "X-API-Key: $API" "http://$GUI/rest/system/connections" \
  | tr ',' '\n' | grep -E '"(connected|type|address|crypto)"'

# does the peer have everything?  want completion 100, needBytes 0, needItems 0
curl -fsS -H "X-API-Key: $API" \
  "http://$GUI/rest/db/completion?device=$PEER_DEVICE_ID&folder=$FOLDER_ID"

# local folder state — want state "idle", errors 0
curl -fsS -H "X-API-Key: $API" "http://$GUI/rest/db/status?folder=$FOLDER_ID" \
  | tr ',' '\n' | grep -E '"(state|globalFiles|localFiles|needBytes|errors)"'
```

Expect the transferred volume to be **less** than the folder size — block-level dedup means
duplicate files cross once. (8.44 GB folder, 6.44 GB on the wire, here.)

> **Trap — "the API never came up" is ambiguous.** It means either a dead daemon or a probe
> against the wrong port. One signal can't tell you which. Pair it with a probe of the sync
> port *from the other machine*:
> ```bash
> nc -zv <peer-vpn-address> 22000
> ```
> Refused → the daemon is dead. Open → your local API probe is looking in the wrong place.
> Two independent signals settle in one step what one signal argues about for a round trip.

---

## 8. A status command, on both machines

One command that answers "is it safe to walk away / safe to start?". Save as
`~/.local/bin/syncstatus` (`chmod +x`), identical on both machines — it finds its own config.

```bash
#!/bin/bash
set -uo pipefail
FOLDER_ID="my-data"; FOLDER_PATH="$HOME/Data"

CONF="$(syncthing paths 2>/dev/null | awk '/Configuration file:/{getline;gsub(/^[ \t]+/,"");print;exit}')"
[ -f "$CONF" ] || { echo "✗ Syncthing config not found — is it installed?"; exit 1; }
API="$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$CONF" | head -1)"
G="$(sed -n '/<gui /,/<\/gui>/p' "$CONF" | sed -n 's:.*<address>\(.*\)</address>.*:\1:p' | head -1)"
: "${G:=127.0.0.1:8384}"
get() { curl -fsS -H "X-API-Key: $API" "http://$G$1" 2>/dev/null; }

get /rest/system/ping >/dev/null || { echo "✗ Syncthing is NOT RUNNING — nothing is syncing."; exit 1; }

ST="$(get "/rest/db/status?folder=$FOLDER_ID")"
STATE="$(printf '%s' "$ST" | grep -o '"state": *"[a-z-]*"' | head -1 | sed 's/.*"\([a-z-]*\)"$/\1/')"
NEED="$(printf '%s' "$ST" | grep -o '"needBytes": *[0-9]*' | head -1 | grep -o '[0-9]*')"
ERRS="$(printf '%s' "$ST" | grep -o '"errors": *[0-9]*'    | head -1 | grep -o '[0-9]*')"
PEERS="$(get /rest/system/connections | grep -o '"connected": *true' | wc -l | tr -d ' ')"
: "${NEED:=0}" "${ERRS:=0}"

[ "$PEERS" -gt 0 ] && PEER="peer connected" || PEER="⚠ PEER OFFLINE (will sync when it's back)"
if   [ "$NEED" -gt 0 ];      then printf '⏳ SYNCING — %s MB to go · %s\n' "$((NEED/1000000))" "$PEER"
elif [ "$STATE" = "idle" ];  then printf '✔ UP TO DATE · %s\n' "$PEER"
else                              printf '… %s (settling) · %s\n' "$STATE" "$PEER"; fi
[ "$ERRS" -gt 0 ] && printf '⚠ %s folder error(s) — open http://%s\n' "$ERRS" "$G"

C="$(find "$FOLDER_PATH" -name '*sync-conflict*' 2>/dev/null | head -5)"
[ -n "$C" ] && { echo "⚠ conflict copies:"; printf '   %s\n' $C; }
exit 0
```

### The daily rhythm

**Stopping work:** close the app so it flushes, then `syncstatus` → wait for `✔ UP TO DATE`.
If it says the peer is offline, that's fine — changes queue and go when the peer wakes.

**Starting work:** `syncstatus` → `✔ UP TO DATE` before you open anything. If it says
`⏳ SYNCING`, wait; opening a half-synced project is how you edit a stale file.

**The one habit that makes all of this boring:** one machine at a time, and let the
application finish writing (a second of idle) before you walk away.

---

## 9. Conflicts

When both sides change a file between syncs, Syncthing keeps yours and writes theirs beside it:

```
<base>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<7-CHAR-DEVICE-PREFIX>.<ext>
```

In-flight transfers appear as `.syncthing.<name>.tmp` and vanish on their own — those are not
conflicts and should be ignored silently by anything watching the tree.

**The doctrine worth adopting:** a conflict is a *condition to be resolved*, not a stray file.
The user must be told it happened, and must not be able to leave a stale copy lying around —
"we have to resolve this before moving on," even when resolving is one click. Stale conflict
copies are worse than the conflict: months later you can't tell which side was real.

Resolving, in practice: compare bytes first — **most conflicts are identical on both sides**
(both machines saved the same content), so the common case is a one-click discard. Otherwise
keep one side, or for append-only line-based files (logs, ledgers, `.ndjson`) union the lines.
Always finish by **deleting the conflict copy**.

Prevention: the one-machine-at-a-time habit, plus `syncstatus` before you start.

---

## 10. Make the *application* tolerate sync

The sync layer is the easy half. Three classes of application bug only show up once a folder
lives on two machines — all three were real here, and all three are silent until they aren't.

**1. Absolute paths stored in data files.** Anything that records `/home/you/...` or
`/Users/you/...` inside a project file breaks the moment that file opens on the other machine
— different home, often a different username. Fix shape: store **project-relative** paths on
write; **heal** stored paths on load (idempotent, string-only, no I/O); and at every *read*,
resolve through an ordered **candidate list** rather than one path, so old files keep working.
Put all of it in **one module** that owns the question — the second copy of a path rule is
where the rot starts.
*Trap:* any API that derives a directory from your path (`dirname`) needs a **real absolute
path** — resolve before you call it, or you'll silently operate on the wrong directory.

**2. File watchers and directory scans that don't know about sync artifacts.** Two distinct
bugs: (a) in-flight `.syncthing.*.tmp` files reach the reload chain as if they were edits;
(b) `*.sync-conflict-*` copies show up in any code that *lists documents by scanning a
directory* — so the user sees, and can edit, a twin of their own file. Classify both centrally
(one shared rules module), silence the temps, and surface the conflicts per §9.

**3. Ignore lists that miss machine-local state.** Whatever generates a `.gitignore` (or any
per-project ignore file) must exclude per-machine scratch, agent state, and `.bak` siblings.
Cheap to fix, and it stops machine-local noise from becoming a conflict generator.

---

## 11. Wanting history too

If you want deliberate checkpoints for one folder inside the synced tree, `git init` it. The
`.git` directory syncs like any other data, so you get history with **no remote and no
push/pull** — safe under one-machine-at-a-time. Don't run git commands while an active
two-sided conflict is being resolved; mid-operation `.git` internals are the one thing the
one-machine habit genuinely protects.

For append-only ledgers, a `.gitattributes` line removes the only routine conflict:

```
*.ndjson merge=union
```

---

## 12. Failure quick-reference

| Symptom | Cause | Fix |
|---|---|---|
| `HTTP 400` on device/folder POST | escaped `\"` inside `$( )` inside a double-quoted string → literal backslashes → invalid JSON | build bodies with unquoted heredocs; print the response body |
| "API never came up" | dead daemon **or** probing the wrong port | read the GUI address from `config.xml`; confirm with `nc -zv <peer> 22000` from the other machine |
| macOS: service "started" but nothing runs | Homebrew's LaunchAgent silently never executes | retire it; install your own `local.syncthing.plist` (§5.2) |
| Sync stops after logout (Linux) | user service without linger | `loginctl enable-linger "$USER"` |
| Config file not where expected | Syncthing v2 moved off `~/.config` | never hardcode; parse `syncthing paths` |
| A `!` negation in `.stignore` does nothing | Syncthing never descends into a fully-ignored directory | ignore at the child level (`/dir/*`) |
| Connection shows `relay` | discovery/relay settings differ between machines | apply §4.1 on **both**; confirm the peer address is the VPN one |
| Peer's UI says "Up to Date" but files are missing | local-only view | check `/rest/db/completion` from the **other** machine |
| A file syncs but fails at use | secret sealed to the OS keychain | ignore it per-machine (§6 bucket 1) |
| Two machines fight over the same incoming file | a watched inbox that triggers work is being synced | ignore the inbox (§6 bucket 2) |

---

## 13. Order of operations, condensed

1. VPN up on both; note both addresses. Confirm reachability.
2. Decide the ignore list (§6) — **before** anything transfers.
3. Machine A: install → `generate` → note device ID → options (§4.1) → folder (§4.3) →
   `.stignore` → persistence (§5).
4. Machine B: ensure `FOLDER_PATH` is empty or knowingly merging → install → `generate` →
   note device ID → options → folder → identical `.stignore` → persistence.
5. Add each machine to the other as a device (§4.2). Nothing moves until both have.
6. Watch the seed transfer. Verify **from the opposite machine** (§7).
7. Install `syncstatus` on both (§8). Reboot each machine once and confirm it comes back by
   itself — persistence you haven't tested isn't persistence.
8. Audit the application for the three portability classes in §10.
