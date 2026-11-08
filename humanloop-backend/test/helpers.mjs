import { EventQueue } from '../server/queue.mjs';
export function fakeTransport() {
  const connections = [];
  return {
    connections,
    async open(input, signal) {
      const output = new EventQueue(1000);
      const c = { input: [], output };
      connections.push(c);
      signal.addEventListener('abort', () => output.close(), { once: true });
      c.collect = (async () => { for await (const item of input) { c.input.push(item); if (item.event.sessionEnd) output.close(); } })();
      return output;
    },
  };
}
export async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
export const principal = () => ({ id: 'test-user', expiresAt: Date.now() + 60000, permissions: ['test_tool'] });
export const testTool = overrides => ({ name: 'test_tool', description: 'Test tool', schema: { type: 'object' }, validate: args => !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0, execute: async () => ({ value: 1 }), ...overrides });
