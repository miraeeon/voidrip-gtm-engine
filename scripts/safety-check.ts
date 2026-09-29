/**
 * Live negative test: try to enroll a real prospect into a bot-created campaign.
 * In SEND_MODE=locked the SendGuard must throw BEFORE any network call.
 * Usage: npx tsx scripts/safety-check.ts
 */
import { OverloopClient } from '../src/clients/overloop.js';
import { auditSink, one } from '../src/db/db.js';
import { SafetyError } from '../src/safety/guard.js';

const push = one<any>('SELECT * FROM pushes WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1');
if (!push) {
  console.log('No pushed campaign to test against — run `gtm push` first.');
  process.exit(0);
}
let networkCalls = 0;
const client = new OverloopClient({
  audit: auditSink,
  fetchImpl: async (url, init) => {
    networkCalls++;
    return fetch(url, init);
  },
});

const attempts: [string, () => Promise<unknown>][] = [
  ['enroll prospect', () => client.createEnrollment(push.ovl_campaign_id, push.ovl_prospect_id, { allowSend: true })],
  ['activate campaign', () => client.updateCampaign(push.ovl_campaign_id, { status: 'on' }, { allowSend: true })],
  ['enable auto-send', () => client.updateCampaign(push.ovl_campaign_id, { automatically_send_messages: true })],
];
let ok = true;
for (const [label, fn] of attempts) {
  try {
    await fn();
    console.log(`✖ ${label}: NOT blocked`);
    ok = false;
  } catch (e) {
    console.log(`${e instanceof SafetyError ? '✔' : '✖'} ${label}: ${(e as Error).message}`);
    if (!(e instanceof SafetyError)) ok = false;
  }
}
console.log(`network calls made: ${networkCalls} (must be 0)`);
console.log(ok && networkCalls === 0 ? 'SAFETY CHECK PASSED' : 'SAFETY CHECK FAILED');
process.exit(ok && networkCalls === 0 ? 0 : 1);
