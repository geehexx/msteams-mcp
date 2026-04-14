/**
 * Tests for token refresh orchestrator.
 *
 * Covers the no-token browser fallback behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the module under test
vi.mock('./token-extractor.js', () => ({
  extractSubstrateToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));

vi.mock('./token-refresh-http.js', () => ({
  refreshTokensViaHttp: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../browser/context.js', () => ({
  createBrowserContext: vi.fn(),
  closeBrowser: vi.fn(),
}));

vi.mock('../browser/auth.js', () => ({
  ensureAuthenticated: vi.fn(),
}));

describe('refreshTokensViaBrowser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should attempt browser refresh when no Substrate token exists', async () => {
    const { extractSubstrateToken } = await import('./token-extractor.js');
    const { createBrowserContext, closeBrowser } = await import('../browser/context.js');
    const { ensureAuthenticated } = await import('../browser/auth.js');
    const { refreshTokensViaBrowser } = await import('./token-refresh.js');

    // No existing token
    vi.mocked(extractSubstrateToken)
      .mockReturnValueOnce(null)  // First call: no token (triggers browser fallback)
      .mockReturnValueOnce({      // Second call: after browser refresh, token exists
        token: 'eyJ...',
        expiry: new Date(Date.now() + 3600000),
      });

    // Mock browser context
    const mockPage = {};
    const mockContext = {};
    vi.mocked(createBrowserContext).mockResolvedValue({
      page: mockPage,
      context: mockContext,
      browser: {},
    } as never);
    vi.mocked(closeBrowser).mockResolvedValue(undefined);
    vi.mocked(ensureAuthenticated).mockResolvedValue(undefined);

    const result = await refreshTokensViaBrowser();

    // Should have attempted browser-based refresh (not returned AUTH_REQUIRED immediately)
    expect(createBrowserContext).toHaveBeenCalled();
    expect(ensureAuthenticated).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('should return AUTH_REQUIRED when browser refresh also fails to produce tokens', async () => {
    const { extractSubstrateToken } = await import('./token-extractor.js');
    const { createBrowserContext, closeBrowser } = await import('../browser/context.js');
    const { ensureAuthenticated } = await import('../browser/auth.js');
    const { refreshTokensViaBrowser } = await import('./token-refresh.js');

    // No token before or after browser refresh
    vi.mocked(extractSubstrateToken).mockReturnValue(null);

    // Mock browser context
    vi.mocked(createBrowserContext).mockResolvedValue({
      page: {},
      context: {},
      browser: {},
    } as never);
    vi.mocked(closeBrowser).mockResolvedValue(undefined);
    vi.mocked(ensureAuthenticated).mockResolvedValue(undefined);

    const result = await refreshTokensViaBrowser();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUTH_REQUIRED');
    }
  });
});
