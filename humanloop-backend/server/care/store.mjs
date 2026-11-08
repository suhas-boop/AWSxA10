import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export class Conflict extends Error { constructor() { super('Conditional state conflict'); this.name = 'Conflict'; } }
const keyOf = item => `${item.pk}\u0000${item.sk}`;
export class MemoryStore {
  constructor() { this.rows = new Map(); }
  async get(pk, sk) { return structuredClone(this.rows.get(keyOf({ pk, sk }))); }
  async query(pk, prefix = '') { return structuredClone([...this.rows.values()].filter(x => x.pk === pk && x.sk.startsWith(prefix))); }
  async put(item) { this.rows.set(keyOf(item), structuredClone(item)); }
  async transact(ops) {
    for (const op of ops) {
      const old = this.rows.get(keyOf(op.item || op));
      if (op.expectedVersion === null && old) throw new Conflict();
      if (typeof op.expectedVersion === 'number' && old?.version !== op.expectedVersion) throw new Conflict();
      for (const [k, v] of Object.entries(op.equals || {})) if (old?.[k] !== v) throw new Conflict();
      for (const [k, v] of Object.entries(op.greater || {})) if (!(old?.[k] > v)) throw new Conflict();
    }
    for (const op of ops) if (op.kind === 'put') await this.put(op.item);
  }
}

export class DynamoStore {
  constructor(table, region) {
    this.table = table;
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 2 }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async get(pk, sk) { return (await this.client.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(5000) })).Item; }
  async query(pk, prefix = '') {
    const rows = []; let cursor;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk' + (prefix ? ' AND begins_with(sk, :prefix)' : ''),
        ExpressionAttributeValues: { ':pk': pk, ...(prefix ? { ':prefix': prefix } : {}) }, ConsistentRead: true, ExclusiveStartKey: cursor }), { abortSignal: AbortSignal.timeout(5000) });
      rows.push(...result.Items); cursor = result.LastEvaluatedKey;
    } while (cursor);
    return rows;
  }
  async put(item) { await this.client.send(new PutCommand({ TableName: this.table, Item: item }), { abortSignal: AbortSignal.timeout(5000) }); }
  async transact(ops) {
    const items = ops.map(op => {
      const names = {}, values = {}, expressions = [];
      if (op.expectedVersion === null) expressions.push('attribute_not_exists(pk)');
      const add = (field, sign, value) => { const i = Object.keys(names).length; names[`#n${i}`] = field; values[`:v${i}`] = value; expressions.push(`#n${i} ${sign} :v${i}`); };
      if (typeof op.expectedVersion === 'number') add('version', '=', op.expectedVersion);
      for (const [k, v] of Object.entries(op.equals || {})) add(k, '=', v);
      for (const [k, v] of Object.entries(op.greater || {})) add(k, '>', v);
      const value = { TableName: this.table, ...(op.kind === 'put' ? { Item: op.item } : { Key: { pk: op.pk, sk: op.sk } }),
        ...(expressions.length ? { ConditionExpression: expressions.join(' AND ') } : {}),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names, ExpressionAttributeValues: values } : {}) };
      return { [op.kind === 'put' ? 'Put' : 'ConditionCheck']: value };
    });
    try { await this.client.send(new TransactWriteCommand({ TransactItems: items }), { abortSignal: AbortSignal.timeout(7000) }); }
    catch (error) {
      if (error.name === 'TransactionCanceledException' && error.CancellationReasons?.some(x => x.Code === 'ConditionalCheckFailed')) throw new Conflict();
      throw error;
    }
  }
}

export class RunLocks {
  constructor() { this.tails = new Map(); }
  async with(key, fn) {
    const prior = this.tails.get(key) || Promise.resolve();
    let unlock; const tail = new Promise(resolve => { unlock = resolve; });
    this.tails.set(key, tail);
    await prior;
    try { return await fn(); }
    finally { unlock(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}
