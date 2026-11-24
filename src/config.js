import 'dotenv/config';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 5055);
const onVercel = Boolean(process.env.VERCEL);

// On Vercel the redirect URI defaults to the project's production domain.
const defaultRedirect = onVercel && process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/callback`
  : `http://localhost:${port}/callback`;

const clientSecret = process.env.QBO_CLIENT_SECRET || '';
const appPassword = process.env.APP_PASSWORD || '';

export const config = {
  port,
  onVercel,
  // Bind to localhost by default: anyone who can reach this app can post to the connected books.
  host: process.env.HOST || '127.0.0.1',
  clientId: process.env.QBO_CLIENT_ID || '',
  clientSecret,
  environment: (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox',
  redirectUri: process.env.QBO_REDIRECT_URI || defaultRedirect,
  appPassword,
  // Signs session and sign-in cookies. Derived from the secrets when not set, so changing
  // APP_PASSWORD signs everyone out.
  sessionSecret:
    process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update(`journal-import:${clientSecret}:${appPassword}`).digest('hex'),
};

export const isConfigured = () => Boolean(config.clientId && config.clientSecret);
