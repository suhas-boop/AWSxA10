import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: true });

// Register application-specific tools here after their data sources and permissions are defined.
// Identity always comes from ctx.principal, never from model-provided user IDs.
const definitions = [{
  name: 'get_session_info',
  description: 'Read the current conversation time and session capabilities. Does not access external records or change data.',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    await ctx.checkAccess();
    return { time: new Date().toISOString(), capabilities: ['voice_conversation', 'session_information'], applicationToolsConfigured: false };
  },
}];

export const tools = definitions.map(tool => ({ ...tool, validate: ajv.compile(tool.schema) }));
