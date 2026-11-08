import { randomUUID } from 'node:crypto';

export const event = (name, value = {}) => ({ event: { [name]: value } });

export function textEvents(promptName, role, text, interactive = false) {
  const contentName = randomUUID();
  return [
    event('contentStart', { promptName, contentName, type: 'TEXT', role, interactive, textInputConfiguration: { mediaType: 'text/plain' } }),
    event('textInput', { promptName, contentName, content: text }),
    event('contentEnd', { promptName, contentName }),
  ];
}

export function startEvents({ promptName, audioName, voice, systemPrompt, tools, history = [], requiredTool }) {
  return [
    event('sessionStart', { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }, turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' } }),
    event('promptStart', {
      promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: voice, encoding: 'base64', audioType: 'SPEECH' },
      ...(tools.length ? { toolUseOutputConfiguration: { mediaType: 'application/json' }, toolConfiguration: { tools, ...(requiredTool ? { toolChoice: { tool: { name: requiredTool } } } : {}) } } : {}),
    }),
    ...textEvents(promptName, 'SYSTEM', systemPrompt),
    ...history.flatMap(turn => textEvents(promptName, turn.role, turn.text)),
    event('contentStart', {
      promptName, contentName: audioName, type: 'AUDIO', role: 'USER', interactive: true,
      audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' },
    }),
  ];
}

export function toolResultEvents(promptName, toolUseId, result) {
  const contentName = randomUUID();
  return [
    event('contentStart', { promptName, contentName, type: 'TOOL', role: 'TOOL', interactive: false,
      toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } }),
    event('toolResult', { promptName, contentName, content: JSON.stringify(result) }),
    event('contentEnd', { promptName, contentName }),
  ];
}

export function endEvents(promptName, audioName) {
  return [event('contentEnd', { promptName, contentName: audioName }), event('promptEnd', { promptName }), event('sessionEnd')];
}
