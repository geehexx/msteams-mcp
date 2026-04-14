/**
 * Authentication handling for Microsoft Teams.
 * Manages login detection and manual authentication flows.
 */

import type { Page, BrowserContext } from 'playwright';
import { saveSessionState } from './context.js';
import {
  OVERLAY_STEP_PAUSE_MS,
  OVERLAY_COMPLETE_PAUSE_MS,
  TOKEN_REFRESH_WAIT_TIMEOUT_MS,
  TOKEN_REFRESH_POLL_INTERVAL_MS,
  TOKEN_REFRESH_LOG_INTERVAL_MS,
} from '../constants.js';
import { extractSubstrateToken } from '../auth/token-extractor.js';
import {
  getInterceptedTokens,
  createTokenInterceptor,
  saveInterceptedTokens,
  clearInterceptedTokens,
} from '../auth/token-interceptor.js';
import * as logger from '../utils/logger.js';

/**
 * Default Teams URL for initial login.
 * 
 * For commercial tenants, this is teams.microsoft.com.
 * For GCC/GCC-High/DoD tenants, Microsoft's login flow will redirect users
 * to the appropriate URL (teams.microsoft.us, etc.) after authentication.
 * We then extract the correct base URL from DISCOVER-REGION-GTM for all API calls.
 */
const TEAMS_URL = 'https://teams.microsoft.com';

// ─────────────────────────────────────────────────────────────────────────────
// Progress Overlay UI
// ─────────────────────────────────────────────────────────────────────────────

const PROGRESS_OVERLAY_ID = 'mcp-login-progress-overlay';

/** Phases for the login progress overlay. */
type OverlayPhase = 'signed-in' | 'saving' | 'complete' | 'error';

/** Content for each overlay phase. */
const OVERLAY_CONTENT: Record<OverlayPhase, { message: string; detail: string }> = {
  'signed-in': {
    message: "You're signed in!",
    detail: 'Setting up your connection to Teams...',
  },
  'saving': {
    message: 'Saving your session...',
    detail: "So you won't need to log in again.",
  },
  'complete': {
    message: 'All done!',
    detail: 'This window will close automatically.',
  },
  'error': {
    message: 'Something went wrong',
    detail: 'Please try again or check the console for details.',
  },
};

/**
 * Shows a progress overlay for a specific phase.
 * Handles injection, content, and optional pause.
 * Failures are silently ignored - the overlay is purely cosmetic.
 */
async function showLoginProgress(
  page: Page,
  phase: OverlayPhase,
  options: { pause?: boolean } = {}
): Promise<void> {
  const content = OVERLAY_CONTENT[phase];
  const isComplete = phase === 'complete';
  const isError = phase === 'error';

  try {
    await page.evaluate(({ id, message, detail, complete, error }) => {
      // Remove existing overlay if present
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      // Create overlay container
      const overlay = document.createElement('div');
      overlay.id = id;
      Object.assign(overlay.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '999999',
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      });

      // Create modal card
      const modal = document.createElement('div');
      Object.assign(modal.style, {
        background: 'white',
        borderRadius: '12px',
        padding: '40px 48px',
        maxWidth: '420px',
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      });

      // Create icon
      const icon = document.createElement('div');
      const iconBg = error ? '#c42b1c' : complete ? '#107c10' : '#5b5fc7';
      Object.assign(icon.style, {
        width: '64px',
        height: '64px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '32px',
        background: iconBg,
        color: 'white',
        margin: '0 auto 24px',
      });
      icon.textContent = error ? '✕' : complete ? '✓' : '⋯';

      // Create title
      const title = document.createElement('h2');
      Object.assign(title.style, {
        margin: '0 0 12px',
        fontSize: '20px',
        fontWeight: '600',
        color: '#242424',
      });
      title.textContent = message;

      // Create detail text
      const detailEl = document.createElement('p');
      Object.assign(detailEl.style, {
        margin: '0',
        fontSize: '14px',
        color: '#616161',
        lineHeight: '1.5',
      });
      detailEl.textContent = detail;

      // Assemble and append
      modal.appendChild(icon);
      modal.appendChild(title);
      modal.appendChild(detailEl);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    }, {
      id: PROGRESS_OVERLAY_ID,
      message: content.message,
      detail: content.detail,
      complete: isComplete,
      error: isError,
    });

    // Pause if requested (for steps that need user to see the message)
    if (options.pause) {
      const pauseMs = isComplete ? OVERLAY_COMPLETE_PAUSE_MS : OVERLAY_STEP_PAUSE_MS;
      await page.waitForTimeout(pauseMs);
    }
  } catch {
    // Overlay is cosmetic - don't fail login if it can't be shown
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Detection
// ─────────────────────────────────────────────────────────────────────────────

// URLs that indicate we're in a login flow
const LOGIN_URL_PATTERNS = [
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
];

// Selectors that indicate successful authentication
const AUTH_SUCCESS_SELECTORS = [
  '[data-tid="app-bar"]',
  '[data-tid="search-box"]',
  'input[placeholder*="Search"]',
  '[data-tid="chat-list"]',
  '[data-tid="team-list"]',
];

export interface AuthStatus {
  isAuthenticated: boolean;
  isOnLoginPage: boolean;
  currentUrl: string;
}

/**
 * Checks if the current page URL indicates a login flow.
 */
function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERNS.some(pattern => url.includes(pattern));
}

/**
 * Checks if the page shows authenticated Teams content.
 */
async function hasAuthenticatedContent(page: Page): Promise<boolean> {
  for (const selector of AUTH_SUCCESS_SELECTORS) {
    try {
      const count = await page.locator(selector).count();
      if (count > 0) {
        return true;
      }
    } catch {
      // Selector not found, continue checking others
    }
  }
  return false;
}

/**
 * Gets the current authentication status.
 */
export async function getAuthStatus(page: Page): Promise<AuthStatus> {
  const currentUrl = page.url();
  const onLoginPage = isLoginUrl(currentUrl);

  // If on login page, definitely not authenticated
  if (onLoginPage) {
    return {
      isAuthenticated: false,
      isOnLoginPage: true,
      currentUrl,
    };
  }

  // If on Teams domain, check for authenticated content
  if (currentUrl.includes('teams.microsoft.com')) {
    const hasContent = await hasAuthenticatedContent(page);
    return {
      isAuthenticated: hasContent,
      isOnLoginPage: false,
      currentUrl,
    };
  }

  // Unknown state
  return {
    isAuthenticated: false,
    isOnLoginPage: false,
    currentUrl,
  };
}

/** Timeout for detecting login redirect (ms). */
const LOGIN_REDIRECT_TIMEOUT_MS = 5000;

/** URL patterns that indicate we're on a Teams page (not redirected elsewhere). */
const TEAMS_URL_PATTERNS = [
  'teams.microsoft.com',
  'teams.microsoft.us',      // GCC-High
  'dod.teams.microsoft.us',  // DoD
  'teams.cloud.microsoft',   // New Teams URL
];

/**
 * Checks if a URL is a Teams domain.
 */
function isTeamsUrl(url: string): boolean {
  return TEAMS_URL_PATTERNS.some(pattern => url.includes(pattern));
}

/**
 * Navigates to Teams and checks authentication status.
 * 
 * Uses a fast redirect-based detection: if we're not redirected to a login
 * page within a few seconds, the session is valid. This is much faster than
 * waiting for the full Teams SPA to render (which can take 30+ seconds).
 * 
 * Returns isAuthenticated: false if we can't confirm we're on Teams, to avoid
 * silently failing with an invisible browser stuck on an unexpected page.
 */
export async function navigateToTeams(page: Page): Promise<AuthStatus> {
  // Set up a promise that resolves when we detect a login redirect
  let redirectDetected = false;
  
  // Handler for detecting login redirects
  const handleFrameNavigated = (frame: import('playwright').Frame) => {
    if (frame === page.mainFrame() && isLoginUrl(frame.url())) {
      redirectDetected = true;
    }
  };

  // Listen for navigation events
  page.on('framenavigated', handleFrameNavigated);

  try {
    // Navigate to Teams
    await page.goto(TEAMS_URL, { waitUntil: 'domcontentloaded' });

    // Wait for either:
    // 1. A redirect to login page (detected via framenavigated)
    // 2. Timeout expires (no redirect = session valid)
    // 
    // Research shows login redirect happens ~3-4 seconds after navigation
    // when session is invalid (MSAL tries silent auth first, then redirects).
    // 5 seconds gives enough buffer while still being fast.
    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_REDIRECT_TIMEOUT_MS) {
      if (redirectDetected) break;
      await page.waitForTimeout(100); // Check every 100ms
    }
  } finally {
    // Clean up listener to avoid memory leaks
    page.off('framenavigated', handleFrameNavigated);
  }

  // Check final state
  const currentUrl = page.url();
  
  // Definitely on login page
  if (redirectDetected || isLoginUrl(currentUrl)) {
    return {
      isAuthenticated: false,
      isOnLoginPage: true,
      currentUrl,
    };
  }

  // Verify we're actually on a Teams page (not some unexpected redirect)
  // If we ended up somewhere unexpected, treat as unauthenticated to avoid
  // silently failing with a headless browser stuck on the wrong page
  if (!isTeamsUrl(currentUrl)) {
    return {
      isAuthenticated: false,
      isOnLoginPage: false,  // Not on login, but also not on Teams
      currentUrl,
    };
  }

  // On a Teams URL and no redirect to login = session is valid
  return {
    isAuthenticated: true,
    isOnLoginPage: false,
    currentUrl,
  };
}

/**
 * Waits for the user to complete manual authentication.
 * Returns when authenticated or throws after timeout.
 *
 * @param page - The page to monitor
 * @param context - Browser context for saving session
 * @param timeoutMs - Maximum time to wait (default: 5 minutes)
 * @param onProgress - Callback for progress updates
 * @param showOverlay - Whether to show progress overlay (default: true for visible browsers)
 */
export async function waitForManualLogin(
  page: Page,
  context: BrowserContext,
  timeoutMs: number = 5 * 60 * 1000,
  onProgress?: (message: string) => void,
  showOverlay: boolean = true
): Promise<void> {
  const startTime = Date.now();
  const log = onProgress ?? console.log;

  // Capture bearer tokens during manual login flow
  clearInterceptedTokens();
  const cleanupLoginInterceptor = createTokenInterceptor(page);

  log('Waiting for manual login...');

  while (Date.now() - startTime < timeoutMs) {
    const status = await getAuthStatus(page);

    if (status.isAuthenticated) {
      log('Authentication successful!');

      if (showOverlay) {
        await showLoginProgress(page, 'signed-in', { pause: true });
        await showLoginProgress(page, 'saving');
      }

      // Wait for MSAL to store tokens in localStorage before saving session.
      // After a fresh interactive login, Teams UI can appear before token
      // acquisition completes — polling ensures tokens are captured.
      const tokensReady = await waitForTokenRefresh(page, context, onProgress);
      if (!tokensReady) {
        // Tokens didn't appear within timeout — save whatever state we have
        await saveSessionState(context);
      }
      saveInterceptedTokens();
      cleanupLoginInterceptor();
      log('Session state saved.');

      if (showOverlay) {
        await showLoginProgress(page, 'complete', { pause: true });
      }

      return;
    }

    // Check every 2 seconds
    await page.waitForTimeout(2000);
  }

  // Show error overlay before throwing (only if overlay enabled)
  if (showOverlay) {
    await showLoginProgress(page, 'error', { pause: true });
  }

  saveInterceptedTokens();
  cleanupLoginInterceptor();
  throw new Error('Authentication timeout: user did not complete login within the allowed time');
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Readiness Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Status of tokens found in the browser's localStorage. */
export interface BrowserTokenStatus {
  /** Substrate search token expiry in minutes, or -1 if not found. */
  substrateExpiryMins: number;
  /** Whether a chatsvc token was found. */
  hasChatsvcToken: boolean;
  /** Whether a Skype Spaces token was found. */
  hasSkypeSpacesToken: boolean;
  /** Whether the DISCOVER-REGION-GTM config is present. */
  hasRegionConfig: boolean;
  /** Total number of localStorage keys (for diagnostics). */
  totalKeys: number;
  /** Number of keys containing 'substrate' (for diagnostics). */
  substrateKeyCount: number;
  /** Number of keys containing 'chatsvc' (for diagnostics). */
  chatsvcKeyCount: number;
}

/**
 * Checks in-browser localStorage for all key tokens.
 *
 * Evaluates directly in the page context to avoid serialising the full
 * session state (~600KB) to disk on every poll. Returns a status object
 * showing which tokens are present and their expiry.
 */
export async function checkBrowserTokensReady(page: Page): Promise<BrowserTokenStatus> {
  try {
    return await page.evaluate(() => {
      const now = Date.now();
      let substrateExpiryMins = -1;
      let hasChatsvcToken = false;
      let hasSkypeSpacesToken = false;
      let hasRegionConfig = false;
      let substrateKeyCount = 0;
      let chatsvcKeyCount = 0;
      const totalKeys = localStorage.length;

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        const value = localStorage.getItem(key);
        if (!value) continue;

        // Check for DISCOVER-REGION-GTM (not a JSON-with-target entry)
        if (key.includes('DISCOVER-REGION-GTM')) {
          hasRegionConfig = true;
          continue;
        }

        // Count diagnostic keys
        const keyLower = key.toLowerCase();
        if (keyLower.includes('substrate')) substrateKeyCount++;
        if (keyLower.includes('chatsvc')) chatsvcKeyCount++;

        try {
          const entry = JSON.parse(value);
          const target = entry.target as string | undefined;
          if (!target) continue;

          const secret = entry.secret as string | undefined;
          if (!secret?.startsWith('ey')) continue;

          // Decode JWT exp claim
          const b64 = secret.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(atob(b64));
          if (typeof payload.exp !== 'number') continue;

          const expiryMs = payload.exp * 1000;
          if (expiryMs <= now) continue;

          // Substrate token
          if (target.includes('substrate.office.com') && target.includes('SubstrateSearch')) {
            const minsRemaining = Math.round((expiryMs - now) / 60000);
            if (minsRemaining > substrateExpiryMins) {
              substrateExpiryMins = minsRemaining;
            }
          }

          // chatsvc token
          if (target.includes('chatsvcagg.teams.microsoft.com')) {
            hasChatsvcToken = true;
          }

          // Skype Spaces token
          if (target.includes('api.spaces.skype.com')) {
            hasSkypeSpacesToken = true;
          }
        } catch {
          continue;
        }
      }

      return {
        substrateExpiryMins,
        hasChatsvcToken,
        hasSkypeSpacesToken,
        hasRegionConfig,
        totalKeys,
        substrateKeyCount,
        chatsvcKeyCount,
      };
    });
  } catch {
    return {
      substrateExpiryMins: -1,
      hasChatsvcToken: false,
      hasSkypeSpacesToken: false,
      hasRegionConfig: false,
      totalKeys: 0,
      substrateKeyCount: 0,
      chatsvcKeyCount: 0,
    };
  }
}

/**
 * Formats a BrowserTokenStatus into a human-readable log line.
 */
function formatTokenStatus(status: BrowserTokenStatus): string {
  const parts: string[] = [];
  if (status.substrateExpiryMins > 0) {
    parts.push(`substrate=${status.substrateExpiryMins}m`);
  }
  if (status.hasChatsvcToken) parts.push('chatsvc=✓');
  if (status.hasSkypeSpacesToken) parts.push('skype=✓');
  if (status.hasRegionConfig) parts.push('region=✓');
  if (parts.length === 0) {
    return `no tokens found (${status.totalKeys} localStorage keys, ${status.substrateKeyCount} substrate, ${status.chatsvcKeyCount} chatsvc)`;
  }
  return parts.join(', ');
}

/**
 * Waits for MSAL to refresh tokens in the browser.
 * 
 * When the browser is "authenticated" (session cookies valid) but MSAL tokens
 * are expired, we need to wait for Teams JS to load and trigger silent token
 * acquisition. Polls in-browser localStorage directly to avoid unnecessary
 * disk I/O, then saves session state once when tokens appear.
 * 
 * Returns early as soon as the Substrate token is found — it's the critical
 * one for most tools. Other tokens (chatsvc, Skype Spaces) are logged but
 * don't gate the return.
 * 
 * @returns true if tokens were refreshed, false if timeout
 */
async function waitForTokenRefresh(
  page: Page,
  context: BrowserContext,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const log = onProgress ?? ((msg: string) => logger.debug('auth', msg));
  
  log('Waiting for MSAL to refresh tokens...');
  const startTime = Date.now();
  let lastLogTime = startTime;
  
  while (Date.now() - startTime < TOKEN_REFRESH_WAIT_TIMEOUT_MS) {
    // Check all tokens in the browser's localStorage
    const status = await checkBrowserTokensReady(page);
    
    if (status.substrateExpiryMins > 0) {
      // Substrate token found — save session and return immediately
      await saveSessionState(context);
      const tokenInfo = formatTokenStatus(status);
      log(`Token refresh detected (${tokenInfo}).`);
      return true;
    }
    
    // Also check if network interceptor has captured tokens
    const intercepted = getInterceptedTokens();
    if (intercepted.substrate && intercepted.substrate.expiry > Date.now()) {
      await saveSessionState(context);
      saveInterceptedTokens();
      log('Tokens captured from network requests during wait.');
      return true;
    }

    // Log progress every TOKEN_REFRESH_LOG_INTERVAL_MS so the user knows we're still working
    const now = Date.now();
    if (now - lastLogTime >= TOKEN_REFRESH_LOG_INTERVAL_MS) {
      const elapsedSecs = Math.round((now - startTime) / 1000);
      const diagnostics = formatTokenStatus(status);
      log(`Waiting for tokens... (${elapsedSecs}s elapsed, ${diagnostics})`);
      lastLogTime = now;
    }
    
    // Wait and retry
    await page.waitForTimeout(TOKEN_REFRESH_POLL_INTERVAL_MS);
  }
  
  const totalSecs = Math.round((Date.now() - startTime) / 1000);
  // Final diagnostic dump on timeout
  const finalStatus = await checkBrowserTokensReady(page);
  const finalDiag = formatTokenStatus(finalStatus);
  log(`Token refresh timed out after ${totalSecs}s (${finalDiag}).`);
  return false;
}

/**
 * Performs a full authentication flow:
 * 1. Navigate to Teams
 * 2. Check if already authenticated
 * 3. If not, wait for manual login (or throw if headless)
 *
 * @param page - The page to use
 * @param context - Browser context for session management
 * @param onProgress - Callback for progress updates
 * @param showOverlay - Whether to show progress overlay (default: true for visible browsers)
 * @param headless - If true, throw immediately if user interaction is required (default: false)
 */
export async function ensureAuthenticated(
  page: Page,
  context: BrowserContext,
  onProgress?: (message: string) => void,
  showOverlay: boolean = true,
  headless: boolean = false
): Promise<void> {
  const log = onProgress ?? console.log;

  // Start capturing bearer tokens from network requests.
  // New Teams (teams.cloud.microsoft) encrypts localStorage tokens,
  // so we intercept them from HTTP headers as a fallback.
  clearInterceptedTokens();
  const cleanupInterceptor = createTokenInterceptor(page);

  log('Navigating to Teams...');
  const status = await navigateToTeams(page);

  if (status.isAuthenticated) {
    log('Already authenticated — checking tokens in browser...');
    
    // Check browser localStorage directly BEFORE saving session.
    // If the Substrate token is already present (common when browser profile
    // has a valid session from a previous login), we can skip the 90s wait.
    const browserTokens = await checkBrowserTokensReady(page);
    
    if (browserTokens.substrateExpiryMins > 0) {
      // Tokens already present — save session and return immediately
      await saveSessionState(context);
      saveInterceptedTokens();
      cleanupInterceptor();
      const tokenInfo = formatTokenStatus(browserTokens);
      log(`Tokens already present (${tokenInfo}) — session saved.`);
      return;
    }
    
    // Tokens not in browser yet — also check the saved session file as fallback.
    // saveSessionState captures Playwright's storageState; extractSubstrateToken
    // reads from that file. If the token is there, we're done.
    await saveSessionState(context);
    const token = extractSubstrateToken();
    const tokenValid = token && token.expiry.getTime() > Date.now();
    
    if (tokenValid) {
      saveInterceptedTokens();
      cleanupInterceptor();
      log('Session state saved — tokens valid from saved session.');
      return;
    }
    
    // Check if network interceptor already captured tokens
    const intercepted = getInterceptedTokens();
    if (intercepted.substrate) {
      saveInterceptedTokens();
      cleanupInterceptor();
      log('Tokens captured from network requests — session saved.');
      return;
    }

    // Neither browser localStorage nor saved session has valid tokens.
    // Wait for MSAL to refresh them.
    const diagnostics = formatTokenStatus(browserTokens);
    if (headless) {
      log(`Tokens expired, waiting for MSAL to refresh... (${diagnostics})`);
      const refreshed = await waitForTokenRefresh(page, context, onProgress);
      
      if (refreshed) {
        saveInterceptedTokens();
        cleanupInterceptor();
        return;
      }
      
      // Still no valid tokens after waiting
      saveInterceptedTokens();
      cleanupInterceptor();
      throw new Error('Headless SSO failed: MSAL token refresh timed out');
    }
    
    // In visible mode, also wait for MSAL to refresh tokens.
    // Enterprise SSO tenants need time for silent token acquisition even when
    // the browser session is valid. Without waiting, tokens won't be captured.
    log(`Tokens expired, waiting for MSAL to refresh... (${diagnostics})`);
    const refreshed = await waitForTokenRefresh(page, context, onProgress);
    
    if (refreshed) {
      saveInterceptedTokens();
      cleanupInterceptor();
      return;
    }
    
    // Tokens didn't appear — save whatever state we have so cookies still work
    saveInterceptedTokens();
    cleanupInterceptor();
    log('Session state saved (tokens may need refresh).');
    return;
  }

  // User interaction required - fail fast if headless
  if (headless) {
    const reason = status.isOnLoginPage 
      ? 'Login page detected - user credentials required'
      : `Unexpected page state: ${status.currentUrl}`;
    cleanupInterceptor();
    throw new Error(`Headless SSO failed: ${reason}`);
  }

  if (status.isOnLoginPage) {
    log('Login required. Please complete authentication in the browser window.');
    await waitForManualLogin(page, context, undefined, onProgress, showOverlay);
  } else {
    // Unexpected state - might need manual intervention
    log('Unexpected page state. Waiting for authentication...');
    await waitForManualLogin(page, context, undefined, onProgress, showOverlay);
  }

  saveInterceptedTokens();
  cleanupInterceptor();
}

/**
 * Forces a new login by clearing session and navigating to Teams.
 */
export async function forceNewLogin(
  page: Page,
  context: BrowserContext,
  onProgress?: (message: string) => void
): Promise<void> {
  const log = onProgress ?? console.log;

  log('Starting fresh login...');

  // Clear cookies to force re-authentication
  await context.clearCookies();

  // Navigate and wait for login
  await navigateToTeams(page);
  await waitForManualLogin(page, context, undefined, onProgress);
}
