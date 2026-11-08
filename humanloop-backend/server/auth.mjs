import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createAuth(config) {
  if (config.authMode === 'local') {
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) throw new Error('Local authentication requires a loopback host');
    return async request => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new Error('Loopback connections only');
      return { id: 'local-user', expiresAt: Infinity, permissions: ['get_session_info'] };
    };
  }
  if (config.authMode !== 'jwt' || !config.issuer || !config.audience || !config.jwksUrl) throw new Error('JWT mode requires issuer, audience and JWKS URL');
  if (!config.jwksUrl.startsWith('https://')) throw new Error('JWKS URL must use HTTPS');
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000 });
  return async request => {
    let token = request.headers.authorization?.replace(/^Bearer /i, '');
    if (!token) {
      const protocol = request.headers['sec-websocket-protocol']?.split(',').map(x => x.trim()).find(x => x.startsWith('base64UrlBearerAuthorization.'));
      if (protocol) token = Buffer.from(protocol.slice('base64UrlBearerAuthorization.'.length), 'base64url').toString();
    }
    if (!token || token.length > 16000) throw new Error('Authentication required');
    const { payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256'] });
    if (!payload.sub || !payload.exp || !String(payload.scope || '').split(' ').includes(config.requiredScope)) throw new Error('Required identity or scope is missing');
    return { id: payload.sub, expiresAt: payload.exp * 1000, permissions: ['get_session_info'] };
  };
}
