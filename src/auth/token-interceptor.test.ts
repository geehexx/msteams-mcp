/**
 * Unit tests for token interceptor.
 *
 * Tests JWT decoding, token identification logic, and the interceptor lifecycle.
 * Does NOT require a real browser — mocks Playwright's Page and Request types.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  decodeJwtPayload,
  identifyToken,
  createTokenInterceptor,
  getInterceptedTokens,
  clearInterceptedTokens,
  saveInterceptedTokens,
  loadInterceptedTokens,
  deleteInterceptedTokensFile,
} from './token-interceptor.js';

// ============================================================================
// JWT Helpers for Tests
// ============================================================================

/** Creates a minimal JWT with the given payload claims. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'fake-signature';
  return `${header}.${body}.${signature}`;
}

/** Creates a mock Playwright Request object. */
function mockRequest(url: string, headers: Record<string, string>): { url: () => string; headers: () => Record<string, string> } {
  return {
    url: () => url,
    headers: () => headers,
  };
}

/** Creates a mock Playwright Page with on/off event handling. */
function mockPage(): { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; _handlers: Map<string, Set<(...args: unknown[]) => void>> } {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    _handlers: handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
  };
}

// ============================================================================
// decodeJwtPayload
// ============================================================================

describe('decodeJwtPayload', () => {
  it('decodes a standard base64url JWT payload', () => {
    const payload = { aud: 'https://outlook.office.com/', exp: 1700000000, oid: 'abc-123' };
    const jwt = makeJwt(payload);
    const decoded = decodeJwtPayload(jwt);
    expect(decoded).toEqual(payload);
  });

  it('handles base64url characters (- and _)', () => {
    // Create a payload that produces - and _ in base64url encoding
    const payload = { data: '>>>???', exp: 1700000000 };
    const jwt = makeJwt(payload);
    const decoded = decodeJwtPayload(jwt);
    expect(decoded).toEqual(payload);
  });

  it('returns null for non-JWT strings', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('only.one')).toBeNull();
  });

  it('returns null for invalid base64 payload', () => {
    expect(decodeJwtPayload('header.!!!invalid!!!.signature')).toBeNull();
  });
});

// ============================================================================
// identifyToken
// ============================================================================

describe('identifyToken', () => {
  it('identifies substrate token by request host (not audience)', () => {
    // Substrate has aud=outlook.office.com but is sent to substrate.office.com
    expect(identifyToken('https://outlook.office.com/', 'substrate.office.com')).toBe('substrate');
  });

  it('identifies substrate even with different audience', () => {
    // Any token sent to substrate host should be classified as substrate
    expect(identifyToken('https://some-other-audience.com/', 'substrate.office.com')).toBe('substrate');
  });

  it('identifies chatsvc token by audience', () => {
    expect(identifyToken('https://chatsvcagg.teams.microsoft.com', 'teams.microsoft.com')).toBe('chatsvc');
  });

  it('identifies skypeSpaces token by audience', () => {
    expect(identifyToken('https://api.spaces.skype.com', 'teams.microsoft.com')).toBe('skypeSpaces');
  });

  it('returns null for unrecognised tokens', () => {
    expect(identifyToken('https://graph.microsoft.com', 'graph.microsoft.com')).toBeNull();
    expect(identifyToken('https://outlook.office.com/', 'outlook.office.com')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(identifyToken('', '')).toBeNull();
  });
});

// ============================================================================
// createTokenInterceptor + getInterceptedTokens
// ============================================================================

describe('createTokenInterceptor', () => {
  beforeEach(() => {
    clearInterceptedTokens();
  });

  it('attaches a request listener and returns cleanup function', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);

    expect(page.on).toHaveBeenCalledWith('request', expect.any(Function));
    expect(typeof cleanup).toBe('function');

    cleanup();
    expect(page.off).toHaveBeenCalledWith('request', expect.any(Function));
  });

  it('captures a substrate token from a matching request', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);

    // Get the handler that was registered
    const handler = [...page._handlers.get('request')!][0];

    // Simulate a request with a substrate bearer token
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const jwt = makeJwt({ aud: 'https://outlook.office.com/', exp: futureExp, oid: 'user-1' });
    const request = mockRequest('https://substrate.office.com/api/search', {
      authorization: `Bearer ${jwt}`,
    });

    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.substrate).toBeDefined();
    expect(tokens.substrate!.token).toBe(jwt);
    expect(tokens.substrate!.audience).toBe('https://outlook.office.com/');
    expect(tokens.substrate!.capturedFrom).toBe('substrate.office.com');

    cleanup();
  });

  it('captures a chatsvc token', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ aud: 'https://chatsvcagg.teams.microsoft.com', exp: futureExp });
    const request = mockRequest('https://teams.microsoft.com/api/chatsvc/amer/v1/threads', {
      authorization: `Bearer ${jwt}`,
    });

    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.chatsvc).toBeDefined();
    expect(tokens.chatsvc!.audience).toBe('https://chatsvcagg.teams.microsoft.com');

    cleanup();
  });

  it('captures a skypeSpaces token', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ aud: 'https://api.spaces.skype.com', exp: futureExp });
    const request = mockRequest('https://teams.microsoft.com/api/mt/part/amer-02/beta/me/calendarEvents', {
      authorization: `Bearer ${jwt}`,
    });

    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.skypeSpaces).toBeDefined();

    cleanup();
  });

  it('ignores requests from login.microsoftonline.com', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ aud: 'https://outlook.office.com/', exp: futureExp });
    const request = mockRequest('https://login.microsoftonline.com/oauth2/token', {
      authorization: `Bearer ${jwt}`,
    });

    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.substrate).toBeUndefined();

    cleanup();
  });

  it('ignores expired tokens', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const jwt = makeJwt({ aud: 'https://outlook.office.com/', exp: pastExp });
    const request = mockRequest('https://substrate.office.com/api/search', {
      authorization: `Bearer ${jwt}`,
    });

    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.substrate).toBeUndefined();

    cleanup();
  });

  it('ignores requests without Authorization header', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const request = mockRequest('https://substrate.office.com/api/search', {});
    handler(request);

    const tokens = getInterceptedTokens();
    expect(tokens.substrate).toBeUndefined();

    cleanup();
  });

  it('keeps the token with the latest expiry (idempotent)', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const exp1 = Math.floor(Date.now() / 1000) + 1800; // 30 min
    const exp2 = Math.floor(Date.now() / 1000) + 3600; // 60 min
    const jwt1 = makeJwt({ aud: 'https://outlook.office.com/', exp: exp1 });
    const jwt2 = makeJwt({ aud: 'https://outlook.office.com/', exp: exp2 });

    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt1}` }));
    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt2}` }));

    const tokens = getInterceptedTokens();
    expect(tokens.substrate!.token).toBe(jwt2);
    expect(tokens.substrate!.expiry).toBe(exp2 * 1000);

    cleanup();
  });

  it('does not replace a token with an earlier expiry', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const exp1 = Math.floor(Date.now() / 1000) + 3600; // 60 min
    const exp2 = Math.floor(Date.now() / 1000) + 1800; // 30 min
    const jwt1 = makeJwt({ aud: 'https://outlook.office.com/', exp: exp1 });
    const jwt2 = makeJwt({ aud: 'https://outlook.office.com/', exp: exp2 });

    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt1}` }));
    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt2}` }));

    const tokens = getInterceptedTokens();
    expect(tokens.substrate!.token).toBe(jwt1);

    cleanup();
  });
});

// ============================================================================
// clearInterceptedTokens
// ============================================================================

describe('clearInterceptedTokens', () => {
  it('resets all captured tokens', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ aud: 'https://outlook.office.com/', exp: futureExp });
    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt}` }));

    expect(getInterceptedTokens().substrate).toBeDefined();

    clearInterceptedTokens();

    expect(getInterceptedTokens().substrate).toBeUndefined();
    expect(getInterceptedTokens().version).toBe(1);

    cleanup();
  });
});

// ============================================================================
// save/load round-trip
// ============================================================================

describe('saveInterceptedTokens / loadInterceptedTokens', () => {
  beforeEach(() => {
    clearInterceptedTokens();
    deleteInterceptedTokensFile();
  });

  it('saves and loads tokens with encryption', () => {
    const page = mockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = createTokenInterceptor(page as any);
    const handler = [...page._handlers.get('request')!][0];

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ aud: 'https://outlook.office.com/', exp: futureExp });
    handler(mockRequest('https://substrate.office.com/api/search', { authorization: `Bearer ${jwt}` }));

    saveInterceptedTokens();

    // Clear in-memory state
    clearInterceptedTokens();
    expect(getInterceptedTokens().substrate).toBeUndefined();

    // Load from disk
    const loaded = loadInterceptedTokens();
    expect(loaded).not.toBeNull();
    expect(loaded!.substrate).toBeDefined();
    expect(loaded!.substrate!.token).toBe(jwt);
    expect(loaded!.version).toBe(1);

    cleanup();
    deleteInterceptedTokensFile();
  });

  it('returns null when no file exists', () => {
    expect(loadInterceptedTokens()).toBeNull();
  });

  it('does not save when no tokens captured', () => {
    saveInterceptedTokens();
    expect(loadInterceptedTokens()).toBeNull();
  });
});
