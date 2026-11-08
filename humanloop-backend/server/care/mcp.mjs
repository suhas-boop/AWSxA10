import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from './service.mjs';

/** Each internal MCP connection is bound by the server to one run. No public MCP endpoint. */
export async function createRunMcp(service, runId) {
  const server = new Server({ name: 'carealong-private-gateway', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.schema })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await service.agentCall(runId, request.params.name, request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok };
  });
  const client = new Client({ name: 'carealong-voice-adapter', version: '2.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
      return JSON.parse(result.content.find(item => item.type === 'text').text);
    },
    async close() { await client.close(); await server.close(); },
  };
}
