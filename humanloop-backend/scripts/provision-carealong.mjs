import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CognitoIdentityProviderClient, CreateUserPoolCommand, CreateResourceServerCommand, CreateUserPoolClientCommand, CreateUserPoolDomainCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, CreateTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoStore } from '../server/care/store.mjs';
import { people, TOOL_NAMES, seedFixtures } from '../server/care/fixtures.mjs';

const region = process.env.AWS_REGION || 'us-east-1';
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== '389415889552') throw new Error('Refusing to provision outside the hackathon account');
let config, secrets;
try { config = JSON.parse(await readFile('.carealong-cloud.json', 'utf8')); secrets = JSON.parse(await readFile('.carealong-secrets.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
config ||= { account: identity.Account, region, name: `carealong-${Date.now().toString(36)}`, subjects: {} };
secrets ||= { passwords: {} };
if (config.account !== identity.Account) throw new Error('Existing configuration belongs to another account');
async function checkpoint() {
  await writeFile('.carealong-cloud.json', JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile('.carealong-secrets.json', JSON.stringify(secrets, null, 2), { mode: 0o600 });
}
await checkpoint();
const cognito = new CognitoIdentityProviderClient({ region });
if (!config.poolId) {
  const { UserPool } = await cognito.send(new CreateUserPoolCommand({ PoolName: config.name, UserPoolTier: 'LITE', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    Policies: { PasswordPolicy: { MinimumLength: 14, RequireUppercase: true, RequireLowercase: true, RequireNumbers: true, RequireSymbols: true } } }));
  config.poolId = UserPool.Id; config.issuer = `https://cognito-idp.${region}.amazonaws.com/${UserPool.Id}`; await checkpoint(); console.log('Created Cognito user pool');
}
if (!config.resourceServer) {
  await cognito.send(new CreateResourceServerCommand({ UserPoolId: config.poolId, Identifier: 'carealong', Name: 'CareAlong internal tools', Scopes: TOOL_NAMES.map(name => ({ ScopeName: name, ScopeDescription: `Execute ${name} with a resident run grant` })) }));
  config.resourceServer = true; await checkpoint();
}
if (!config.humanClientId) {
  const { UserPoolClient } = await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: config.poolId, ClientName: 'carealong-human', GenerateSecret: false, ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'], PreventUserExistenceErrors: 'ENABLED', AccessTokenValidity: 60, TokenValidityUnits: { AccessToken: 'minutes' }, EnableTokenRevocation: true }));
  config.humanClientId = UserPoolClient.ClientId; await checkpoint();
}
if (!config.machineClientId) {
  const { UserPoolClient } = await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: config.poolId, ClientName: 'carealong-agent-workload', GenerateSecret: true, AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['client_credentials'], AllowedOAuthScopes: TOOL_NAMES.map(name => `carealong/${name}`), AccessTokenValidity: 10, TokenValidityUnits: { AccessToken: 'minutes' } }));
  config.machineClientId = UserPoolClient.ClientId; secrets.machineClientSecret = UserPoolClient.ClientSecret; await checkpoint();
}
if (!config.domain) {
  const domain = config.name + '-' + randomBytes(3).toString('hex');
  await cognito.send(new CreateUserPoolDomainCommand({ UserPoolId: config.poolId, Domain: domain }));
  config.domain = `https://${domain}.auth.${region}.amazoncognito.com`; await checkpoint();
}
if (!config.table) {
  const table = config.name + '-state';
  await new DynamoDBClient({ region }).send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    SSESpecification: { Enabled: true }, Tags: [{ Key: 'Project', Value: 'CareAlongHackathon' }] }));
  config.table = table; await checkpoint();
}
await waitUntilTableExists({ client: new DynamoDBClient({ region }), maxWaitTime: 60 }, { TableName: config.table });
for (const person of people) {
  if (config.subjects[person.username]) continue;
  const password = 'Ca!' + randomBytes(18).toString('base64url') + '7zA';
  const { User } = await cognito.send(new AdminCreateUserCommand({ UserPoolId: config.poolId, Username: person.username, MessageAction: 'SUPPRESS', TemporaryPassword: password }));
  secrets.passwords[person.username] = password; await checkpoint();
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: config.poolId, Username: person.username, Password: password, Permanent: true }));
  config.subjects[person.username] = User.Attributes.find(x => x.Name === 'sub').Value; await checkpoint();
}
await seedFixtures(new DynamoStore(config.table, region), config.subjects);
console.log(JSON.stringify({ account: config.account, region, pool: config.poolId, table: config.table, humanUsers: Object.keys(config.subjects), machineIdentity: config.machineClientId }));
console.log('Real AWS resources and synthetic fixtures are ready. Passwords and machine secret are in ignored .carealong-secrets.json, never in frontend code.');
