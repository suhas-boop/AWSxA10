export function readConfig(env = process.env) {
  const value = {
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    modelId: env.BEDROCK_MODEL_ID || 'amazon.nova-2-sonic-v1:0',
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8080),
    authMode: env.AUTH_MODE || 'local', voice: env.VOICE_ID || 'tiffany', table: env.DYNAMODB_TABLE,
    issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, jwksUrl: env.JWT_JWKS_URL,
    requiredScope: env.JWT_REQUIRED_SCOPE || 'voice:connect',
    origins: (env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080').split(',').map(x => x.trim()),
  };
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Invalid PORT');
  if (!['local', 'jwt'].includes(value.authMode)) throw new Error('Invalid AUTH_MODE');
  return value;
}
