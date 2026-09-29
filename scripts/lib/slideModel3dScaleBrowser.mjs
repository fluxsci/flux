import { mkdir, writeFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';
import { waitFor } from './driver.mjs';
import { runSlideModelScaleCohort } from './slideModel3dScaleCohort.mjs';
export async function browserSlideModelScale(page) {
  const { slideModel3dScaleFixture } = await tsImport('./slideModel3dScaleFixture.ts', import.meta.url);
  const id = await page.evaluate(() => window.__flux.slide.currentDeck().id);
  const fixture = await slideModel3dScaleFixture(id);
  await page.evaluate(async fixture => {
    const F = window.__flux, root = F.get(F.shell.projectModel).root;
    await F.lifecycle.flushById('slide');
    for (const file of fixture.files) {
      const path = `${root}/slides/${fixture.deck.id}/${file.path}`;
      if (file.base64) await window.fig.writeFile(path, Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)));
      else await window.fig.writeText(path, file.text);
    }
    await window.fig.writeText(`${root}/slides/${fixture.deck.id}/deck.json`, JSON.stringify(fixture.deck));
    await F.slideBridge.loadDeckInto(root, fixture.deck.id);
    F.slide.selectSlide('scale-single');
  }, fixture);
  const out = 'test-results/model3d/slides-scale/browser'; await mkdir(out, { recursive: true });
  const wait = async (fn, label, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); }
    throw Error('Timeout: ' + label);
  };
  const receipt = await runSlideModelScaleCohort({
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    press: key => page.keyboard.press(key), wait,
    present: async () => {
      await waitFor(page, () => !!document.querySelector('.deckbar button') && !!window.__flux?.slide.currentDeck(), null, { label: 'scale deck ready' });
      const button = await page.evaluateHandle(() => [...document.querySelectorAll('.deckbar button')].find(n => n.textContent.trim().startsWith('Present')));
      if (!button.asElement()) throw Error('Present button missing');
      await button.asElement().click(); await button.dispose();
    },
    screenshot: name => page.screenshot({ path: `${out}/${name}.png` }),
  }, fixture);
  receipt.qualification = 'Functional browser cohort. Raw frame timings are retained; only the separate focused production-native hardware gate qualifies the ≤17ms GPU budget.';
  await writeFile(`${out}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  if (!receipt.ok) await page.screenshot({ path: `${out}/failure.png` });
  return receipt;
}
