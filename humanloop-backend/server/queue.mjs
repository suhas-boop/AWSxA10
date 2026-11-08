/** A bounded, single-consumer stream. Overflow ends the session instead of adding latency. */
export class EventQueue {
  constructor(limit = 256) { this.limit = limit; this.items = []; this.waiter = null; this.closed = false; }
  push(value) {
    if (this.closed) throw new Error('Stream is closed');
    if (this.waiter) { const wake = this.waiter; this.waiter = null; wake({ value, done: false }); }
    else {
      if (this.items.length >= this.limit) throw new Error('Audio stream is congested. Please reconnect.');
      this.items.push(value);
    }
  }
  close() {
    this.closed = true;
    if (this.waiter) { this.waiter({ done: true }); this.waiter = null; }
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  return() { this.items = []; this.close(); return Promise.resolve({ done: true }); }
}
