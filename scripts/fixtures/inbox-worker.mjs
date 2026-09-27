import { claimItem, appendAnnotationEvent } from '../../flux-core/annotations.ts';
import { waitForInbox } from '../../flux-core/inboxWait.ts';
const [root, action, json] = process.argv.slice(2), args = JSON.parse(json);
process.stdin.on('end', () => process.exit(1));
const session = args.session ?? { id: `child-${process.pid}`, name: `child-${process.pid}`, client: 'test' };
if (action === 'wait') {
  const result = await waitForInbox(root, { ...args, onReady: () => console.log('READY') }, { session });
  console.log(JSON.stringify(result));
} else {
  console.log('READY');
  await new Promise(resolve => process.stdin.once('data', resolve));
  const result = action === 'claim' ? await claimItem(root, args.id, args.options ?? {}, { session }) : await appendAnnotationEvent(root, args.event);
  console.log(JSON.stringify(result ?? { appended: true, at: Date.now() }));
}
process.exit(0);
