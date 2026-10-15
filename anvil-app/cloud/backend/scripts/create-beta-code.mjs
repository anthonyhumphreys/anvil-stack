import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'redeem-until': { type: 'string' },
  'access-until': { type: 'string' },
} });
const redeemUntil = Date.parse(values['redeem-until'] ?? '');
const accessUntil = Date.parse(values['access-until'] ?? '');
const now = Date.now();
if (!Number.isSafeInteger(redeemUntil) || !Number.isSafeInteger(accessUntil) ||
  redeemUntil <= now || accessUntil < redeemUntil) {
  throw new Error('Pass future ISO dates with --redeem-until and --access-until. Access must end on or after redemption closes.');
}
const code = `anvil_beta_${randomBytes(16).toString('hex')}`;
const hash = createHash('sha256').update(`anvil/beta-code/v1:${code}`).digest('hex');
process.stdout.write(JSON.stringify({
  code,
  sql: `INSERT INTO hosted_beta_codes (code_hash, redeem_until, access_until, created_at) VALUES ('${hash}', ${redeemUntil}, ${accessUntil}, ${now});`,
}, null, 2) + '\n');
