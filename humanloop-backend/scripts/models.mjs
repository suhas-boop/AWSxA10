import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const expected = process.env.EXPECTED_AWS_ACCOUNT_ID || '389415889552';

function describeFailure(error) {
  const stderr = String(error.stderr || '');
  if (/Could not connect|ENOTFOUND|getaddrinfo/.test(stderr)) return 'AWS endpoint could not be reached';
  if (/Unable to locate credentials|ExpiredToken|InvalidClientTokenId/.test(stderr)) return 'AWS credentials are missing, expired, or invalid';
  const code = stderr.match(/\((\w+(?:Exception|Error))\)/)?.[1];
  return code || (error.killed ? 'AWS request timed out' : 'AWS request failed');
}

async function aws(args) {
  const { stdout } = await exec('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '10'], {
    env: { ...process.env, AWS_MAX_ATTEMPTS: '2', AWS_PAGER: '' }, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

try {
  const identity = await aws(['sts', 'get-caller-identity']);
  if (identity.Account !== expected) {
    console.error(`Wrong account: ${identity.Account}. Expected ${expected}. Export the workshop credentials in this terminal and rerun.`);
    process.exitCode = 1;
  } else {
    console.log(`Checking account ${identity.Account} in ${region} using ${identity.Arn}`);
    const catalog = await aws(['bedrock', 'list-foundation-models']);
    const models = catalog.modelSummaries || [];
    const results = new Array(models.length);
    let cursor = 0, completed = 0;
    async function worker() {
      while (cursor < models.length) {
        const index = cursor++;
        const model = models[index];
        const result = { name: model.modelName, provider: model.providerName, modelId: model.modelId, lifecycle: model.modelLifecycle?.status };
        try { result.availability = await aws(['bedrock', 'get-foundation-model-availability', '--model-id', model.modelId]); }
        catch (error) { result.error = describeFailure(error); }
        results[index] = result;
        completed++;
        if (completed % 20 === 0 || completed === models.length) console.log(`Checked ${completed}/${models.length} models`);
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    results.sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`));
    console.table(results.map(model => ({
      Model: model.name, ID: model.modelId,
      Authorized: model.availability?.authorizationStatus || 'UNKNOWN',
      Entitlement: model.availability?.entitlementAvailability || 'UNKNOWN',
      Agreement: model.availability?.agreementAvailability?.status || 'UNKNOWN',
      Region: model.availability?.regionAvailability || 'UNKNOWN',
      Error: model.error || '',
    })));
    await mkdir('data', { recursive: true });
    await writeFile('data/model-availability.json', JSON.stringify({
      checkedAt: new Date().toISOString(), account: identity.Account, principal: identity.Arn, region,
      scope: 'Foundation models returned by the regional Bedrock catalog. No inference requests, subscriptions, or permission changes performed.',
      models: results,
    }, null, 2), { mode: 0o600 });
    console.log('Saved data/model-availability.json. UNKNOWN means the status check failed, not that access is denied.');
    console.log('These are availability metadata checks. Actual invocation permissions, quotas, and cross-region routing still require a model-specific inference check.');
    if (results.some(model => model.error)) process.exitCode = 2;
  }
} catch (error) {
  console.error(describeFailure(error));
  console.error('No account-specific model list was verified. Run this command in a terminal with working AWS connectivity and workshop credentials.');
  process.exitCode = 1;
}
