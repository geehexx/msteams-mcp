/**
 * Unit tests for HTTP utilities.
 *
 * Tests retry logic, timeout handling, rate limit tracking,
 * and error classification — all with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpRequest, clearRateLimitState } from './http.js';
import { ErrorCode } from '../types/errors.js';

beforeEach(() => {
  clearRateLimitState();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Successful Requests
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - successful requests', () => {
  it('returns parsed JSON for application/json responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: 'ok' }));

    const result = await httpRequest<{ message: string }>('https://api.example.com/data');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.data.message).toBe('ok');
    }
  });

  it('returns text for non-JSON responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('plain text'));

    const result = await httpRequest<string>('https://api.example.com/text');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe('plain text');
    }
  });

  it('handles empty JSON body gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await httpRequest('https://api.example.com/empty');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toEqual({});
    }
  });

  it('passes through request options to fetch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await httpRequest('https://api.example.com/post', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer token123' },
      body: JSON.stringify({ key: 'value' }),
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(options?.method).toBe('POST');
    expect((options?.headers as Record<string, string>)['Authorization']).toBe('Bearer token123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Classification
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - error classification', () => {
  it('classifies 401 as AUTH_EXPIRED', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await httpRequest('https://api.example.com/auth');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AUTH_EXPIRED);
      expect(result.error.retryable).toBe(false);
    }
  });

  it('classifies 403 as AUTH_REQUIRED', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Forbidden', { status: 403 })
    );

    const result = await httpRequest('https://api.example.com/forbidden');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AUTH_REQUIRED);
    }
  });

  it('classifies 404 as NOT_FOUND', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const result = await httpRequest('https://api.example.com/missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(result.error.retryable).toBe(false);
    }
  });

  it('classifies 429 as RATE_LIMITED with retryable flag', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '10' },
      })
    );

    const result = await httpRequest('https://api.example.com/rate', { maxRetries: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.RATE_LIMITED);
      expect(result.error.retryAfterMs).toBe(10000);
    }
  });

  it('classifies 500 as API_ERROR with retryable flag', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );

    const result = await httpRequest('https://api.example.com/error', { maxRetries: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.API_ERROR);
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry Logic
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - retry logic', () => {
  it('retries retryable errors up to maxRetries', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Server Error', { status: 500 })
    );

    const result = await httpRequest('https://api.example.com/retry', {
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
  });

  it('does not retry non-retryable errors (e.g. 404)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const result = await httpRequest('https://api.example.com/noretry', {
      maxRetries: 3,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('succeeds on retry after transient failure', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('Error', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ recovered: true }));

    const result = await httpRequest<{ recovered: boolean }>('https://api.example.com/recover', {
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.recovered).toBe(true);
    }
  });

  it('retries network errors (ECONNRESET)', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await httpRequest('https://api.example.com/network', {
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - timeout', () => {
  it('returns TIMEOUT error when request exceeds timeout', async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    });

    const result = await httpRequest('https://api.example.com/slow', {
      timeoutMs: 50,
      maxRetries: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.TIMEOUT);
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('50ms');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit State
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - rate limit state', () => {
  it('returns RATE_LIMITED immediately when in rate-limited state', async () => {
    // First: trigger rate limiting
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Too Many', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    );

    await httpRequest('https://api.example.com/trigger', { maxRetries: 1 });

    // Second: should be rejected without making a fetch call
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    const result = await httpRequest('https://api.example.com/blocked');
    const callsAfter = vi.mocked(fetch).mock.calls.length;

    expect(callsAfter).toBe(callsBefore);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.RATE_LIMITED);
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('clears rate limit state via clearRateLimitState', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Too Many', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    );

    await httpRequest('https://api.example.com/trigger', { maxRetries: 1 });
    clearRateLimitState();

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await httpRequest('https://api.example.com/after-clear');

    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Network Errors
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest - network errors', () => {
  it('classifies ENOTFOUND as NETWORK_ERROR', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ENOTFOUND'));

    const result = await httpRequest('https://api.example.com/dns', {
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NETWORK_ERROR);
      expect(result.error.retryable).toBe(true);
    }
  });

  it('classifies ETIMEDOUT as NETWORK_ERROR', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await httpRequest('https://api.example.com/timeout', {
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NETWORK_ERROR);
    }
  });

  it('classifies unknown errors as UNKNOWN and non-retryable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Some unexpected error'));

    const result = await httpRequest('https://api.example.com/unknown', {
      maxRetries: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.UNKNOWN);
      expect(result.error.retryable).toBe(false);
    }
  });

  it('handles non-Error thrown values', async () => {
    vi.mocked(fetch).mockRejectedValue('string error');

    const result = await httpRequest('https://api.example.com/nonError', {
      maxRetries: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('string error');
    }
  });
});
