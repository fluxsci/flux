# Add to FluxLib — browser extension

One click on a paper page saves the article **and its supplementary files** into
[FluxLib](../docs/integrations/web-capture.qmd).

This replaced an in-page bookmarklet, for one structural reason worth recording: a script
running in the page is subject to that page's Content-Security-Policy. An extension's
background worker fetches under **host permissions**, which page CSP does not govern. That is
what makes capture work in **Firefox** (which enforces CSP on page scripts where Chrome does
not — [Mozilla 866522](https://bugzilla.mozilla.org/show_bug.cgi?id=866522), open since 2013)
and on strict-CSP publishers everywhere. It also allows several files per click, which is what
makes supplements possible at all.

## Build

```bash
node scripts/build-extension.mjs      # → extension/dist/
```

The build **copies** `electron/captureRules.js` and `electron/supplementRules.js` into
`dist/vendor/`. They are never edited by hand: the extension and Flux's download watcher must
agree on what a capture file is and what a supplement URL looks like, and a second
hand-maintained copy is exactly how the supplement filter rotted once already.
`scripts/verify-extension.ts` asserts the copies are byte-identical to the originals.

## Install, and updating after a `git pull`

Everything you need is in the checkout: `npm run build` produces `extension/dist/`, and the
signed `.xpi` is committed. Flux's **Library → Web capture → Set up…** panel drives both. By
hand:

**Chrome / Edge / Brave** — `chrome://extensions` → **Developer mode** → **Load unpacked** →
pick `extension/dist`. To update: `npm run build`, then press **Reload** on the card.

**Firefox** — `about:addons` → the **gear** → **Install Add-on From File…** → pick
`extension/signed/*.xpi`. To update: install the new `.xpi` over it. The add-on id never
changes, so it upgrades in place — don't remove the old one first.

**A pull alone never updates your browser.** The extension lives in the browser profile, not
the checkout, so every update is: pull → build → reload/reinstall in the browser. There is no
`update_url`, so Firefox will not do it for you.

## Signing (maintainers)

Firefox only installs a signed add-on permanently. Signing is UNLISTED — Mozilla signs the file
but never lists it publicly; free, no review queue, and we distribute it with the app.

```bash
export WEB_EXT_API_KEY='user:12345678:123'   # from addons.mozilla.org/developers/addon/api/key/
export WEB_EXT_API_SECRET='…'
npm run sign:extension
```

The script bumps the version (AMO rejects a repeat), rebuilds, signs, writes
`extension/signed/*.xpi`, and deletes the one it supersedes. **Commit both the version bump and
the `.xpi`.**

The `.xpi` is committed on purpose: only you hold the credentials, and Firefox will not
permanently install an unsigned add-on, so a checkout is the only way anyone else can get one.
That makes it your job to re-sign whenever `background.js`, `page.js` or a vendored rule module
changes — otherwise every Firefox user silently runs old code. `verify-extension.ts` reads the
committed archive and fails if its contents don't match the source beside it, so you find out
at the gate rather than from a bug report. **You sign once per change — users never sign
anything.**

## Using it

Open a paper and click the **Flux** button in the toolbar. The badge tells you what happened:

| Badge | |
|---|---|
| `…` amber | working |
| a number, green | that many files captured (article + supplements) |
| `1` amber | no PDF was reachable; the paper's details were captured instead |
| `!` red | the page couldn't be read (an internal page, or a blocked injection) |

Captured files land in **`<downloads>/flux/`** — a subfolder, so one click that produces an
article plus eight supplements doesn't scatter nine files through your downloads. Flux brings
them in when it starts, or when you press **Assign PDFs** in Library mode (its count includes
whatever is still waiting in your downloads); nothing moves on its own in between:

| File | Becomes |
|---|---|
| `flux-<doi>.pdf` | the article → `pdfs_to_assign/` → matched to a reference by its own content |
| `flux-supp-<doi>@@<name>` | a supplementary file → `items/<citekey>/supplements/` |
| `flux-<doi>.fluxcap` | metadata only, when no PDF was reachable → resolved by DOI |

Supplements wait until their article has been identified, then file themselves against it — so
a supplement captured for a paper you don't have yet is picked up once the paper arrives.

## Architecture

| | |
|---|---|
| `page.js` | injected into the tab; **reads only** — DOI, title, PDF url, supplement urls. Serialized by `executeScript`, so it closes over nothing and takes its rules as an argument. |
| `background.js` | fetches and downloads under host permissions. This is the CSP-immune half. |
| `vendor/` | copies of Flux's own rule modules (see Build). |

Transport is the download folder: files land in `<downloads>/flux/` and Flux's watcher files
them. It's the only channel that also works when Flux ISN'T running — captures simply wait.
Native messaging or a loopback POST would both be viable (extensions are exempt from Chrome's
Local Network Access restrictions) and can be added later as a pure upgrade for the
Flux-is-running case.
