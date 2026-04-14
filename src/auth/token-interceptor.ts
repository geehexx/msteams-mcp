/**
 * Network request token interceptor.
 *
 * Captures bearer tokens from HTTP request headers during browser sessions.
 * The new Microsoft Teams (teams.cloud.microsoft) encrypts MSAL tokens in
 * localStorage, so we intercept them from network requests instead.
 *
 * Tokens are identified by decoding the JWT payload and checking the `aud`
 * claim combined with the request URL host. The interceptor is passive —
 * it observes requests via `page.on('request')`, never blocking or modifying them.
 */

import type { Page, Request } from 'playwright';
import { CONFIG_DIR } from './session-store.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import * as fs from 'fs';
import * as path from 'path';
import * as log from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/** A single intercepted bearer token with metadata. */
export interface InterceptedToken {
  /** The raw JWT bearer token. */
  token: string;
  /** The `aud` claim from the JWT payload. */
  audience: string;
  /** Token expiry from the JWT `exp` claim (ms since epoch). */
  expiry: number;
  /** When this token was captured (ms since epoch). */
  capturedAt: number;
  /** The request URL host this token was captured from. */
  capturedFrom: string;
}

/** Collection of intercepted tokens keyed by service. */
export interface InterceptedTokens {
  /** Substrate token — aud contains outlook.office.com, request to substrate.office.com. */
  substrate?: InterceptedToken;
  /** Chat service aggregator token — aud contains chatsvcagg.teams.microsoft.com. */
  chatsvc?: InterceptedToken;
  /** Skype Spaces token — aud contains api.spaces.skype.com. */
  skypeSpaces?: InterceptedToken;
  /** Schema version for forward compatibility. */
  version: number;
}

// ============================================================================
// Module State
// ============================================================================

/** In-memory store of captured tokens. */
let capturedTokens: InterceptedTokens = { version: 1 };

/** File path for persisted intercepted tokens. */
const INTERCEPTED_TOKENS_PATH = path.join(CONFIG_DIR, 'intercepted-tokens.json');

/** File permission mode: owner read/write only. */
const SECURE_FILE_MODE = 0o600;

// ============================================================================
// JWT Utilities
// ============================================================================

/**
 * Decodes a JWT payload with proper base64url handling.
 * Replaces `-` with `+` and `_` with `/` before decoding.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ============================================================================
// Token Identification
// ============================================================================

/** Hosts to ignore — auth flow tokens, not API tokens. */
const IGNORED_HOSTS = [
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
];

/**
 * Identifies which service a bearer token belongs to based on the JWT audience
 * and the request URL host.
 *
 * Returns the token slot name ('substrate' | 'chatsvc' | 'skypeSpaces') or null.
 */
export function identifyToken(
  audience: string,
  requestHost: string,
): 'substrate' | 'chatsvc' | 'skypeSpaces' | null {
  // Substrate: identified by request host containing 'substrate', NOT by audience.
  // The audience is outlook.office.com but it's sent to substrate.office.com.
  if (requestHost.includes('substrate')) {
    return 'substrate';
  }

  // Chatsvc: audience contains chatsvcagg.teams.microsoft.com
  if (audience.includes('chatsvcagg.teams.microsoft.com')) {
    return 'chatsvc';
  }

  // Skype Spaces: audience contains api.spaces.skype.com
  if (audience.includes('api.spaces.skype.com')) {
    return 'skypeSpaces';
  }

  return null;
}

/**
 * Processes a single HTTP request, extracting and storing any bearer token.
 */
function handleRequest(request: Request): void {
  try {
    const headers = request.headers();
    const authHeader = headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return;

    const url = new URL(request.url());
    const host = url.hostname;

    // Skip auth flow requests
    if (IGNORED_HOSTS.some(h => host.includes(h))) return;

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix
    if (!token.startsWith('ey')) return; // Quick JWT check

    const payload = decodeJwtPayload(token);
    if (!payload) return;

    const aud = typeof payload.aud === 'string' ? payload.aud : '';
    const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;

    if (exp <= Date.now()) return; // Skip expired tokens

    const slot = identifyToken(aud, host);
    if (!slot) return;

    const existing = capturedTokens[slot];

    // Keep the token with the latest expiry (idempotent)
    if (existing && existing.expiry >= exp) return;

    capturedTokens[slot] = {
      token,
      audience: aud,
      expiry: exp,
      capturedAt: Date.now(),
      capturedFrom: host,
    };

    log.debug('token-interceptor', `Captured ${slot} token from ${host} (expires ${new Date(exp).toISOString()})`);
  } catch {
    // Never let interceptor errors break the browser session
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Sets up a request listener on the page to capture bearer tokens.
 * Returns a cleanup function that removes the listener.
 *
 * Uses `page.on('request', ...)` — observes only, never intercepts or modifies.
 */
export function createTokenInterceptor(page: Page): () => void {
  page.on('request', handleRequest);
  log.debug('token-interceptor', 'Token interceptor attached');

  return () => {
    page.off('request', handleRequest);
    log.debug('token-interceptor', 'Token interceptor detached');
  };
}

/** Returns the current in-memory captured tokens. */
export function getInterceptedTokens(): InterceptedTokens {
  return { ...capturedTokens };
}

/** Resets the in-memory captured tokens. */
export function clearInterceptedTokens(): void {
  capturedTokens = { version: 1 };
}

/**
 * Persists captured tokens to disk with encryption.
 * Uses the same writeSecure pattern as session-store.
 */
export function saveInterceptedTokens(): void {
  if (!capturedTokens.substrate && !capturedTokens.chatsvc && !capturedTokens.skypeSpaces) {
    return; // Nothing to save
  }

  try {
    const dir = path.dirname(INTERCEPTED_TOKENS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const json = JSON.stringify(capturedTokens, null, 2);
    const encrypted = encrypt(json);

    fs.writeFileSync(
      INTERCEPTED_TOKENS_PATH,
      JSON.stringify(encrypted, null, 2),
      { mode: SECURE_FILE_MODE, encoding: 'utf8' },
    );

    log.debug('token-interceptor', 'Intercepted tokens saved to disk');
  } catch (error) {
    log.error('token-interceptor', `Failed to save intercepted tokens: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Loads persisted intercepted tokens from disk.
 * Handles both encrypted and legacy plaintext formats.
 */
export function loadInterceptedTokens(): InterceptedTokens | null {
  if (!fs.existsSync(INTERCEPTED_TOKENS_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(INTERCEPTED_TOKENS_PATH, 'utf8');
    const parsed = JSON.parse(content);

    if (isEncrypted(parsed)) {
      const decrypted = decrypt(parsed);
      return JSON.parse(decrypted) as InterceptedTokens;
    }

    // Legacy plaintext — return as-is
    return parsed as InterceptedTokens;
  } catch (error) {
    log.error('token-interceptor', `Failed to load intercepted tokens: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Deletes the persisted intercepted tokens file.
 */
export function deleteInterceptedTokensFile(): void {
  if (fs.existsSync(INTERCEPTED_TOKENS_PATH)) {
    fs.unlinkSync(INTERCEPTED_TOKENS_PATH);
  }
}
