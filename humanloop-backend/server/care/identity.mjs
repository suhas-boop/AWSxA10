import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { orgPK } from './fixtures.mjs';
import { CareError } from './service.mjs';

export function createIdentity(config, secrets, store) {
  const jwks = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), { timeoutDuration: 5000 });
  const cognito = new CognitoIdentityProviderClient({ region: config.region });
  async function verify(token, clientId) {
    if (typeof token !== 'string' || token.length > 16000) throw new CareError('AUTH_INVALID', 401);
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: config.issuer, algorithms: ['RS256'] });
      if (payload.token_use !== 'access' || payload.client_id !== clientId || !payload.sub || !payload.exp) throw new Error();
      return payload;
    } catch { throw new CareError('AUTH_INVALID', 401); }
  }
  let machineCache, fetching;
  return {
    async login(username, password) {
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 256) throw new CareError('AUTH_INVALID', 401);
      let result;
      try { result = await cognito.send(new InitiateAuthCommand({ ClientId: config.humanClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } }), { abortSignal: AbortSignal.timeout(8000) }); }
      catch { throw new CareError('AUTH_INVALID', 401); }
      const token = result.AuthenticationResult?.AccessToken;
      const principal = await verify(token, config.humanClientId);
      const member = await store.get(orgPK, `MEMBER#${principal.sub}`);
      if (!member?.active) throw new CareError('AUTH_INVALID', 401);
      await store.put({ pk: orgPK, sk: `LOGIN#${principal.jti}`, active: true, version: 1, sub: principal.sub, expiresAt: principal.exp });
      return { token, expiresAt: principal.exp * 1000, actor: { name: member.name, role: member.role, username: member.username } };
    },
    async human(token) {
      const principal = await verify(token, config.humanClientId);
      const login = await store.get(orgPK, `LOGIN#${principal.jti}`);
      if (!login?.active || login.sub !== principal.sub) throw new CareError('AUTH_INVALID', 401);
      return principal;
    },
    async logout(principal) {
      const login = await store.get(orgPK, `LOGIN#${principal.jti}`);
      if (login) await store.put({ ...login, active: false, version: login.version + 1 });
    },
    async machine(token, tool) {
      const principal = await verify(token, config.machineClientId);
      if (!String(principal.scope || '').split(' ').includes(`carealong/${tool}`)) throw new CareError('TOOL_NOT_ALLOWED');
      return principal;
    },
    async machineToken() {
      if (machineCache?.expires > Date.now() + 60000) return machineCache.token;
      if (fetching) return fetching;
      fetching = (async () => {
        const response = await fetch(`${config.domain}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Basic ${Buffer.from(`${config.machineClientId}:${secrets.machineClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials' }) });
        if (!response.ok) throw new CareError('AUTH_INVALID', 503);
        const value = await response.json();
        machineCache = { token: value.access_token, expires: Date.now() + value.expires_in * 1000 }; return value.access_token;
      })();
      try { return await fetching; } finally { fetching = null; }
    },
  };
}
