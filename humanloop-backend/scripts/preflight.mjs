import { execFileSync } from 'node:child_process';
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const expectedAccount = process.env.EXPECTED_AWS_ACCOUNT_ID || '389415889552';
const model = process.env.BEDROCK_MODEL_ID || 'amazon.nova-2-sonic-v1:0';
function aws(args) {
  return JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json', '--cli-connect-timeout', '5', '--cli-read-timeout', '5'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}
try {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== expectedAccount) throw new Error(`Wrong account: ${identity.Account}. Expected ${expectedAccount}.`);
  console.log(`Authenticated: ${identity.Account}\nRole: ${identity.Arn}\nRegion: ${region}`);
  if (!process.argv.includes('--identity-only')) {
    try {
      const details = aws(['bedrock', 'get-foundation-model', '--model-identifier', model]).modelDetails;
      console.log(`Model found: ${details.modelId}`);
    } catch { console.log('Model metadata lookup failed. Check Bedrock access and regional model availability.'); process.exitCode = 1; }
    console.log('This checks identity and model metadata only. A live voice session is required to verify streaming permissions and audio.');
  }
} catch (error) {
  console.error(error.message.startsWith('Wrong account:') ? error.message : 'AWS identity check failed. Check connectivity and refresh the credentials in this terminal.');
  console.error('Export fresh Workshop Studio CLI credentials in this same terminal. Exports in a different terminal do not carry over.');
  process.exitCode = 1;
}
