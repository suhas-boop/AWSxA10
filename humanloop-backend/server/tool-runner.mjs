/** The model proposes actions; only this server-side gate can execute them. */
export class ToolRunner {
  constructor({ tools, principal, authorize, emit, timeoutMs = 10000 }) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    this.principal = principal;
    this.authorize = authorize;
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.enabled = true;
    this.calls = new Map();
    this.controllers = new Set();
  }
  specs() {
    return [...this.tools.values()].map(tool => ({ toolSpec: {
      name: tool.name, description: tool.description, inputSchema: { json: JSON.stringify(tool.schema) },
    } }));
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.cancel('Tool access revoked');
  }
  cancel(message = 'Session ended') { for (const controller of this.controllers) controller.abort(new Error(message)); }
  execute(call) {
    // Replayed events must never execute a mutation twice in a session.
    if (this.calls.has(call.toolUseId)) return this.calls.get(call.toolUseId);
    if (this.calls.size >= 500) return Promise.resolve({ ok: false, error: 'Session tool limit reached' });
    const task = this.run(call);
    this.calls.set(call.toolUseId, task);
    return task;
  }
  async run(call) {
    const action = status => this.emit({ type: 'action', id: call.toolUseId, name: call.toolName, status, at: new Date().toISOString() });
    action('requested');
    const controller = new AbortController();
    this.controllers.add(controller);
    let allowed = false;
    let timeout;
    try {
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        timeout = setTimeout(() => controller.abort(new Error('Tool timed out')), this.timeoutMs);
      });
      const work = async () => {
        const tool = this.tools.get(call.toolName);
        if (!tool) throw new Error('Unknown tool');
        const args = JSON.parse(call.content);
        if (!tool.validate(args)) throw new Error('Invalid tool arguments');
        const checkAccess = async () => {
          if (!this.enabled || controller.signal.aborted) throw new Error('Tool access revoked');
          if (this.principal.expiresAt <= Date.now()) throw new Error('Authentication expired');
          if (!await this.authorize(this.principal, tool.name)) throw new Error('Action is not permitted');
          if (!this.enabled || controller.signal.aborted) throw new Error('Tool access revoked');
        };
        await checkAccess();
        allowed = true;
        action('allowed');
        // Integrations must honor signal and call checkAccess immediately before side effects.
        const result = await tool.execute(args, { principal: this.principal, signal: controller.signal, checkAccess, idempotencyKey: call.toolUseId });
        if (JSON.stringify(result).length > 16000) throw new Error('Tool result exceeds size limit');
        return result;
      };
      const result = await Promise.race([work(), cancelled]);
      action('completed');
      return { ok: true, result };
    } catch (error) {
      action(allowed ? 'failed' : 'blocked');
      // Do not leak upstream errors, credentials, or arbitrary exception contents to the model.
      const known = new Set(['Unknown tool', 'Invalid tool arguments', 'Tool access revoked', 'Authentication expired', 'Action is not permitted', 'Tool timed out', 'Session ended']);
      return { ok: false, error: known.has(error.message) ? error.message : 'Tool execution failed' };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
}
