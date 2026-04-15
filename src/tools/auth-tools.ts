/**
 * Authentication-related tool handlers.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RegisteredTool, ToolContext, ToolResult } from './index.js';
import {
  hasSessionState,
  isSessionLikelyExpired,
  clearSessionState,
} from '../auth/session-store.js';
import {
  getSubstrateTokenStatus,
  getMessageAuthStatus,
  extractMessageAuth,
  extractCsaToken,
  clearTokenCache,
} from '../auth/token-extractor.js';
import { createBrowserContext, createCleanBrowserContext, closeBrowser, clearBrowserProfile } from '../browser/context.js';
import * as log from '../utils/logger.js';
import { ensureAuthenticated, forceNewLogin, getAuthStatus } from '../browser/auth.js';
import { clearInterceptedTokens } from '../auth/token-interceptor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const LoginInputSchema = z.object({
  forceNew: z.boolean().optional().default(false),
});

export const LogoutInputSchema = z.object({});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

const loginToolDefinition: Tool = {
  name: 'teams_login',
  description: 'Trigger manual login flow for Microsoft Teams. Use this if the session has expired or you need to switch accounts. Set forceNew=true to completely reset the browser profile and start fresh — this clears all cached accounts so you can sign in with a different Microsoft account.',
  inputSchema: {
    type: 'object',
    properties: {
      forceNew: {
        type: 'boolean',
        description: 'Force a new login even if a session exists (default: false)',
      },
    },
  },
};

const statusToolDefinition: Tool = {
  name: 'teams_status',
  description: 'Check the current authentication status and session state.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const logoutToolDefinition: Tool = {
  name: 'teams_logout',
  description: 'Sign out of Microsoft Teams completely. Clears all session data, tokens, and the browser profile so the next teams_login starts fresh with no remembered accounts. Use this to switch Microsoft accounts or resolve authentication issues.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum minutes remaining on token to consider it valid (skip browser). */
const TOKEN_VALID_THRESHOLD_MINUTES = 10;

async function handleLogin(
  input: z.infer<typeof LoginInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> {
  // Close existing browser if any
  const existingManager = ctx.server.getBrowserManager();
  if (existingManager) {
    await closeBrowser(existingManager, !input.forceNew);
    ctx.server.resetBrowserState();
  }

  if (input.forceNew) {
    clearSessionState();
    clearTokenCache();
    clearInterceptedTokens();
    clearBrowserProfile();
  }

  // Fast path: if tokens are still valid, skip browser entirely
  // This is more reliable than browser-based auth detection
  if (!input.forceNew) {
    const tokenStatus = getSubstrateTokenStatus();
    if (tokenStatus.hasToken && 
        tokenStatus.minutesRemaining !== undefined && 
        tokenStatus.minutesRemaining >= TOKEN_VALID_THRESHOLD_MINUTES) {
      ctx.server.markInitialised();
      return {
        success: true,
        data: {
          message: `Already authenticated. Token valid for ${tokenStatus.minutesRemaining} more minutes.`,
          tokenStatus: {
            expiresAt: tokenStatus.expiresAt,
            minutesRemaining: tokenStatus.minutesRemaining,
          },
        },
      };
    }
  }

  // Headless-first strategy:
  // Only attempt headless SSO if a session exists AND we're not forcing new login.
  // Without an existing session (no browser profile cookies), headless will always
  // fail immediately (login page detected → throw). Skipping it avoids a brief
  // window flash on Windows where headless Edge can momentarily show a window.
  const shouldTryHeadless = !input.forceNew && hasSessionState();

  if (shouldTryHeadless) {
    const headlessManager = await createBrowserContext({ headless: true });
    ctx.server.setBrowserManager(headlessManager);

    try {
      await ensureAuthenticated(
        headlessManager.page,
        headlessManager.context,
        (msg) => log.info('login:headless', msg),
        false, // No overlay in headless
        true   // Headless mode - throw immediately if user interaction required
      );

      await closeBrowser(headlessManager, true);
      ctx.server.resetBrowserState();
      ctx.server.markInitialised();

      return {
        success: true,
        data: {
          message: 'Login completed silently via SSO. Session has been saved.',
        },
      };
    } catch (error) {
      // Headless attempt failed - fall through to visible browser
      log.warn('login:headless', `Headless SSO failed, falling back to visible browser: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await closeBrowser(headlessManager, false);
      } catch {
        // Ignore cleanup errors
      }
      ctx.server.resetBrowserState();
    }
  }

  // Open visible browser for user interaction.
  // Use createCleanBrowserContext (non-persistent, chromium.launch) which does NOT
  // apply enterprise policies or Windows Integrated Authentication. This gives the
  // user a blank Microsoft login page with no auto-filled accounts from the Windows
  // session. After login, we save the session state to our encrypted storage.
  const browserManager = await createCleanBrowserContext({ headless: false });
  ctx.server.setBrowserManager(browserManager);

  try {
    if (input.forceNew) {
      await forceNewLogin(
        browserManager.page,
        browserManager.context,
        (msg) => log.info('login', msg)
      );
    } else {
      await ensureAuthenticated(
        browserManager.page,
        browserManager.context,
        (msg) => log.info('login', msg)
      );
    }
  } finally {
    // Close browser after login - we only need the saved session/tokens
    await closeBrowser(browserManager, true);
    ctx.server.resetBrowserState();
  }

  ctx.server.markInitialised();

  return {
    success: true,
    data: {
      message: 'Login completed successfully. Session has been saved.',
    },
  };
}

async function handleStatus(
  _input: Record<string, never>,
  ctx: ToolContext
): Promise<ToolResult> {
  const sessionExists = hasSessionState();
  const sessionExpired = isSessionLikelyExpired();
  const tokenStatus = getSubstrateTokenStatus();
  const messageAuthStatus = getMessageAuthStatus();
  const messageAuth = extractMessageAuth();
  const csaToken = extractCsaToken();

  let authStatus = null;
  const browserManager = ctx.server.getBrowserManager();
  if (browserManager && ctx.server.isInitialisedState()) {
    authStatus = await getAuthStatus(browserManager.page);
  }

  return {
    success: true,
    data: {
      directApi: {
        available: tokenStatus.hasToken,
        expiresAt: tokenStatus.expiresAt,
        minutesRemaining: tokenStatus.minutesRemaining,
      },
      messaging: {
        available: messageAuthStatus.hasToken,
        expiresAt: messageAuthStatus.expiresAt,
        minutesRemaining: messageAuthStatus.minutesRemaining,
      },
      favorites: {
        available: messageAuth !== null && csaToken !== null,
      },
      session: {
        exists: sessionExists,
        likelyExpired: sessionExpired,
      },
      browser: {
        running: browserManager !== null,
        initialised: ctx.server.isInitialisedState(),
      },
      authentication: authStatus,
    },
  };
}

async function handleLogout(
  _input: Record<string, never>,
  ctx: ToolContext
): Promise<ToolResult> {
  // Close any running browser
  const existingManager = ctx.server.getBrowserManager();
  if (existingManager) {
    try {
      await closeBrowser(existingManager, false);
    } catch {
      // Ignore cleanup errors
    }
    ctx.server.resetBrowserState();
  }

  // Clear everything
  clearSessionState();
  clearTokenCache();
  clearInterceptedTokens();
  clearBrowserProfile();

  return {
    success: true,
    data: {
      message: 'Signed out. All session data, tokens, and browser profile cleared. Call teams_login to sign in with a new account.',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const loginTool: RegisteredTool<typeof LoginInputSchema> = {
  definition: loginToolDefinition,
  schema: LoginInputSchema,
  handler: handleLogin,
};

export const statusTool: RegisteredTool<z.ZodObject<Record<string, never>>> = {
  definition: statusToolDefinition,
  schema: z.object({}),
  handler: handleStatus,
};

export const logoutTool: RegisteredTool<z.ZodObject<Record<string, never>>> = {
  definition: logoutToolDefinition,
  schema: z.object({}),
  handler: handleLogout,
};

/** All auth-related tools. */
export const authTools = [loginTool, statusTool, logoutTool];
