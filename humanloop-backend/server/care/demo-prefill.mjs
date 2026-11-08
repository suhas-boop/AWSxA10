// Explicitly enabled convenience for the local synthetic demonstration only.
const loopback = value => ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(value);
export function demoPrefillAllowed(request, { enabled, host }) {
  if (!enabled || !loopback(host) || !loopback(request.socket.remoteAddress)) return false;
  if (Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) return false;
  try {
    if (!loopback(new URL(`http://${request.headers.host}`).hostname)) return false;
    if (request.headers.origin && !loopback(new URL(request.headers.origin).hostname)) return false;
    return true;
  } catch { return false; }
}
