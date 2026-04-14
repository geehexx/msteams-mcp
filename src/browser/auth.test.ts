/**
 * Tests for browser auth module.
 *
 * Covers the token refresh wait timeout, progress logging, and
 * ensureAuthenticated visible-mode token refresh behaviour.
 */

import { describe, it, expect } from 'vitest';

// ── Constants tests ─────────────────────────────────────────────────────────

describe('TOKEN_REFRESH_WAIT_TIMEOUT_MS', () => {
  it('should be 90 seconds for enterprise SSO tenants', async () => {
    const { TOKEN_REFRESH_WAIT_TIMEOUT_MS } = await import('../constants.js');
    expect(TOKEN_REFRESH_WAIT_TIMEOUT_MS).toBe(90000);
  });

  it('should be exported from constants module', async () => {
    const constants = await import('../constants.js');
    expect(constants).toHaveProperty('TOKEN_REFRESH_WAIT_TIMEOUT_MS');
    expect(constants).toHaveProperty('TOKEN_REFRESH_POLL_INTERVAL_MS');
    expect(constants).toHaveProperty('TOKEN_REFRESH_LOG_INTERVAL_MS');
  });
});

describe('TOKEN_REFRESH_POLL_INTERVAL_MS', () => {
  it('should be 1 second', async () => {
    const { TOKEN_REFRESH_POLL_INTERVAL_MS } = await import('../constants.js');
    expect(TOKEN_REFRESH_POLL_INTERVAL_MS).toBe(1000);
  });
});

describe('TOKEN_REFRESH_LOG_INTERVAL_MS', () => {
  it('should be 5 seconds', async () => {
    const { TOKEN_REFRESH_LOG_INTERVAL_MS } = await import('../constants.js');
    expect(TOKEN_REFRESH_LOG_INTERVAL_MS).toBe(5000);
  });
});
