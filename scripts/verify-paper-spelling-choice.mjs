// October 27 acceptance: real Harper, native browser pointer/keys, persistent
// explicit correction learning, immediate dictionary invalidation and cursor UI.
import { APP_URL, launch, gotoApp, clickMode, waitFor, realErrors, shot } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h=harness('verify-paper-spelling-choice');
const {browser,page}=await launch({width:1440,height:950});
try {
 await page.evaluateOnNewDocument(()=>{
  const values=JSON.parse(localStorage.getItem('flux.settings')||'{}');
  localStorage.setItem('flux.settings',JSON.stringify({...values,paperLocalCorrections:true,paperCaretFeel:'smooth'}));
 });
 await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:1000});
 await clickMode(page,'Paper');
 await waitFor(page,()=>!!window.__fluxView,null,{timeout:15000,label:'Paper editor'});
 await page.evaluate(()=>{localStorage.removeItem('flux.paper.localLanguage.v2');window.dispatchEvent(new CustomEvent('flux:local-language-changed',{detail:{scope:'personal'}}));});
 const load=async text=>{await page.evaluate(text=>{const v=window.__fluxView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});v.focus();},text);};
 const flag=async word=>waitFor(page,word=>[...document.querySelectorAll('.cm-spelling-issue')].some(el=>el.textContent===word),word,{timeout:18000,label:`flag ${word}`});
 const hover=async word=>{const element=await page.evaluateHandle(word=>[...document.querySelectorAll('.cm-spelling-issue')].find(el=>el.textContent===word),word);await element.asElement().hover();await waitFor(page,()=>!!document.querySelector('.cm-spelling-menu'),null,{timeout:3000,label:'spelling menu'});};
 h.section('useful spelling suggestions');
 await load('The chamber enviroment remained stable.\n\nReady.');
 await flag('enviroment');await hover('enviroment');
 const suggestions=await page.$$eval('.cm-spelling-choices button',buttons=>buttons.map(button=>button.textContent));
 h.ok(suggestions.includes('environment')&&suggestions.length<=5,'the hover popup offers ranked selectable spellings');
 h.ok(await page.$('input[aria-label="Custom spelling correction"]'),'a custom spelling field follows the choices');
 await shot(page,'paper-spelling-choices');
 await page.click('[data-spelling-suggestion="environment"]');
 h.ok(await page.evaluate(()=>window.__fluxView.state.doc.toString().startsWith('The chamber environment')),'choosing a suggestion replaces the exact occurrence');
 h.ok(await page.evaluate(()=>document.activeElement===window.__fluxView.contentDOM),'focus returns to the editor');
 await load('');await page.keyboard.type('enviroment ');
 h.eq(await page.evaluate(()=>window.__fluxView.state.doc.toString()),'environment ','a chosen correction applies synchronously on the next delimiter');
 await load('');await page.keyboard.type('Enviroment ');
 h.eq(await page.evaluate(()=>window.__fluxView.state.doc.toString()),'Environment ','learned ordinary-word corrections preserve sentence capitalization');
 h.section('custom correction and durable learning');
 await load('The juddgemental comment was removed.\n\nReady.');await flag('juddgemental');await hover('juddgemental');
 await page.click('input[aria-label="Custom spelling correction"]');await page.keyboard.type('judgmental');await page.keyboard.press('Enter');
 h.ok(await page.evaluate(()=>window.__fluxView.state.doc.toString().startsWith('The judgmental comment')),'a custom spelling replaces the exact occurrence');
 const learned=await page.evaluate(()=>JSON.parse(localStorage.getItem('flux.paper.localLanguage.v2')).personal.aliases);
 h.ok(learned.some(alias=>alias.trigger==='juddgemental'&&alias.expansion==='judgmental'&&alias.learned),'custom corrections are persisted as explicit personal mappings');
 await page.reload({waitUntil:'networkidle0'});await clickMode(page,'Paper');await waitFor(page,()=>!!window.__fluxView,null,{timeout:15000,label:'reopened editor'});
 await load('');await page.keyboard.type('juddgemental ');
 h.eq(await page.evaluate(()=>window.__fluxView.state.doc.toString()),'judgmental ','custom correction learning survives a full browser reload');
 h.section('immediate personal dictionary refresh');
 await load('The flubbernex remained stable.\n\nThe flubbernex was isolated.\n\nReady.');await flag('flubbernex');await hover('flubbernex');
 await page.click('button[aria-label="Add flubbernex to personal dictionary"]');
 await waitFor(page,()=>![...document.querySelectorAll('.cm-spelling-issue')].some(el=>el.textContent==='flubbernex'),null,{timeout:1000,label:'all dictionary underlines removed'});
 h.ok(true,'adding a correct word removes its underlines immediately without reopening');
 h.eq(await page.$eval('.cm-content',el=>el.getAttribute('spellcheck')),'false','Chromium spelling cannot add a duplicate underline');
 const seed=await page.evaluate(async()=>{const{LocalCorrectionProfile}=await import('/src/shell/modes/paper/editing/localCorrectionProfile.ts');const profile=new LocalCorrectionProfile('probe');await profile.ready();return profile.words('personal');});
 for(const word of ['excitatory','renormalize','electrophysiological','subcellular','coexpressed','jRGECO1a','iGluSnFR4f','glutamate','electroencephalography','pupillometry','NREM','REM','SWA','desynchronized','autocorrelation','SLAP2','biosensing'])h.ok(seed.includes(word),`${word} is in the personal scientific vocabulary`);
 await page.click('button[aria-label="Settings"]');await waitFor(page,()=>!!document.querySelector('.modal[aria-label="Settings"]'),null,{label:'Settings'});
 const settings=await page.$eval('.modal[aria-label="Settings"]',el=>el.textContent);
 h.ok(!settings.includes('Sentence judgment')&&!settings.includes('Install local model')&&!settings.includes('Caret motion'),'retired model and cursor controls are absent');
 h.eq(realErrors(page),[],'no browser/worker/CSP errors');
} finally {await browser.close();}
await h.done();
