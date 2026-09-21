// Hermetic behavioral coverage extracted from the live Cell Press probe.
const {hyphenatePii,isCellPressDoi,rewriteToProxyHost,rulesReady}=require('../electron/proxyFetch.cjs');
let checks=0,failed=0;
const ok=(condition,name)=>{checks++;if(!condition)failed++;console.log(`${condition?'✓':'✗'} ${name}`);};
async function main() {
  await rulesReady;
  ok(hyphenatePii('S0896627321004955')==='S0896-6273(21)00495-5','PII compact→hyphenated');
  ok(hyphenatePii('not-a-pii')===null,'non-PII → null');
  ok(isCellPressDoi('10.1016/j.neuron.2021.06.030'),'Neuron DOI classified Cell Press');
  ok(isCellPressDoi('10.1016/j.cell.2026.05.048'),'Cell DOI classified Cell Press');
  ok(isCellPressDoi('10.1016/j.tins.2020.01.001'),'Trends in Neurosciences classified Cell Press');
  ok(!isCellPressDoi('10.1016/j.neuroimage.2019.116081'),'plain Elsevier (NeuroImage) NOT Cell Press');
  ok(!isCellPressDoi('10.1038/s41586-020-2649-2'),'Nature DOI NOT Cell Press');
  ok(rewriteToProxyHost('https://www.cell.com/action/showPdf?pii=X','ezproxy.library.wisc.edu')==='https://www-cell-com.ezproxy.library.wisc.edu/action/showPdf?pii=X','host rewrite → proxied cell.com host');
  console.log('##VERIFY## '+JSON.stringify({script:'verify-cellpress-helpers',ok:failed===0,checks,failed}));
  process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
