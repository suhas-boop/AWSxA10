import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function createState(table, region) {
  if (!table) return {
    // Local development policy is checked on every call; browser revocation is also enforced by ToolRunner.
    async authorize(principal, tool) { return principal.permissions.includes(tool); },
    async save(principal, summary) {
      await mkdir('data/sessions', { recursive: true });
      const user = createHash('sha256').update(principal.id).digest('hex').slice(0, 16);
      await writeFile(`data/sessions/${user}-${summary.sessionId}.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
    },
  };
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 2 }));
  return {
    async authorize(principal, tool) {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: { pk: `USER#${principal.id}`, sk: 'POLICY' }, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(4000) });
      // Missing policy means no tools. Revocation is read from DynamoDB for each invocation.
      return !!Item && Item.enabled === true && Array.isArray(Item.tools) && Item.tools.includes(tool) && principal.permissions.includes(tool);
    },
    async save(principal, summary) {
      await client.send(new PutCommand({ TableName: table, Item: { pk: `USER#${principal.id}`, sk: `SESSION#${summary.sessionId}`, ...summary,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400 } }), { abortSignal: AbortSignal.timeout(5000) });
    },
  };
}
