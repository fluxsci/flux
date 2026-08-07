# Add to FluxLib — browser extension

One click on a paper page saves the article **and its supplementary files** into
[FluxLib](../docs/integrations/web-capture.qmd).

It does the same job as Flux's bookmarklet, better, for one structural reason: a bookmarklet
runs in the page and is therefore subject to the page's Content-Security-Policy. An extension's
background worker fetches under **host permissions**, which page CSP does not apply to. That is
what makes capture work in **Firefox** (which enforces CSP on bookmarklets — [Mozilla
866522](https://bugzilla.mozilla.org/show_bug.cgi?id=866522), open since 2013) and on
strict-CSP publishers everywhere. It also means several files can be fetched per click, which
is what makes supplements possible at all.

## Build

```bash
node scripts/build-extension.mjs      # → extension/dist/
```

The build **copies** `electron/captureRules.js` and `electron/supplementRules.js` into
`dist/vendor/`. They are never edited by hand: the extension, Flux's download watcher, and the
bookmarklet must agree on what a capture file is and what a supplement URL looks like, and a
second hand-maintained copy is exactly how the supplement filter rotted once already.
`scripts/verify-extension.ts` asserts the copies are byte-identical to the originals.

## Load it (no signing needed)

**Chrome / Edge / Brave**

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick `extension/dist`

**Firefox**

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/dist/manifest.json`

⚠️ A temporary add-on in Firefox is **removed when the browser restarts**. That's a Firefox
policy, not a bug here. For a permanent install, upload the folder to
[AMO as *unlisted*](https://extensionworkshop.com/documentation/publish/self-distribution/) —
free, no public listing, no review queue — and install the signed `.xpi` it returns.

## Using it

Open a paper and click the **Flux** button in the toolbar. The badge tells you what happened:

| Badge | |
|---|---|
| `…` amber | working |
| a number, green | that many files captured (article + supplements) |
| `1` amber | no PDF was reachable; the paper's details were captured instead |
| `!` red | the page couldn't be read (an internal page, or a blocked injection) |

Captured files land in **`<downloads>/flux/`** — a subfolder, so one click that produces an
article plus eight supplements doesn't scatter nine files through your downloads. Flux moves them out within a
second or two — on startup, on window focus, and live while it's watching:

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

Transport is deliberately the same download folder the bookmarklet uses, so the receiver, the
filename contract and their gates are shared. Native messaging or a loopback POST would both
be viable here (extensions are exempt from Chrome's Local Network Access restrictions) and can
be added later as a pure upgrade.
