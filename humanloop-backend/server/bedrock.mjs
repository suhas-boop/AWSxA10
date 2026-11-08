import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

export function createTransport({ region, modelId }) {
  const client = new BedrockRuntimeClient({
    region,
    maxAttempts: 1,
    requestHandler: new NodeHttp2Handler({ requestTimeout: 490000, sessionTimeout: 490000 }),
  });
  return {
    async open(queue, signal) {
      async function* body() {
        for await (const value of queue) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(value)) } };
      }
      const response = await client.send(new InvokeModelWithBidirectionalStreamCommand({ modelId, body: body() }), { abortSignal: signal });
      if (!response.body) throw new Error('Missing Bedrock stream');
      return (async function* () {
        for await (const part of response.body) {
          if (part.chunk?.bytes) yield JSON.parse(new TextDecoder().decode(part.chunk.bytes)).event;
          else {
            const name = Object.keys(part).find(key => key.endsWith('Exception'));
            if (name) { const error = new Error('Bedrock stream failed'); error.name = name; throw error; }
          }
        }
      })();
    },
    destroy() { client.destroy(); },
  };
}
