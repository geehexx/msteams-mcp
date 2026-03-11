/**
 * Unit tests for tool registry.
 *
 * Tests tool lookup, input validation, invocation, and error handling
 * through the registry's public API.
 */

import { describe, it, expect } from 'vitest';
import { getToolDefinitions, getTool, invokeTool, hasTool } from './registry.js';
import { ErrorCode } from '../types/errors.js';
import type { ToolContext } from './index.js';
import type { TeamsServer } from '../types/server.js';

const mockServer: TeamsServer = {
  ensureBrowser: async () => { throw new Error('not implemented'); },
  resetBrowserState: () => {},
  getBrowserManager: () => null,
  setBrowserManager: () => {},
  markInitialised: () => {},
  isInitialisedState: () => false,
};
const ctx: ToolContext = { server: mockServer };

// ─────────────────────────────────────────────────────────────────────────────
// Tool Discovery
// ─────────────────────────────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns a non-empty array of tool definitions', () => {
    const tools = getToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('every tool has a name and description', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('every tool name is unique', () => {
    const tools = getToolDefinitions();
    const names = tools.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('every tool name starts with teams_', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^teams_/);
    }
  });

  it('every tool has an inputSchema', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('getTool', () => {
  it('returns a tool entry for known tools', () => {
    const tool = getTool('teams_search');
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe('teams_search');
  });

  it('returns undefined for unknown tool names', () => {
    expect(getTool('teams_nonexistent')).toBeUndefined();
    expect(getTool('')).toBeUndefined();
  });
});

describe('hasTool', () => {
  it('returns true for registered tools', () => {
    expect(hasTool('teams_search')).toBe(true);
    expect(hasTool('teams_login')).toBe(true);
    expect(hasTool('teams_status')).toBe(true);
  });

  it('returns false for unregistered tools', () => {
    expect(hasTool('teams_nonexistent')).toBe(false);
    expect(hasTool('')).toBe(false);
    expect(hasTool('search')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Invocation - Error Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('invokeTool - error handling', () => {
  it('returns INVALID_INPUT for unknown tool names', async () => {
    const result = await invokeTool('teams_nonexistent', {}, ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
      expect(result.error.message).toContain('Unknown tool');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('returns INVALID_INPUT for missing required parameters', async () => {
    const result = await invokeTool('teams_search', {}, ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
      expect(result.error.message).toContain('Invalid input');
    }
  });

  it('returns INVALID_INPUT for wrong parameter types', async () => {
    const result = await invokeTool('teams_search', { query: 123 }, ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
    }
  });

  it('validates constraint violations (e.g. empty query)', async () => {
    const result = await invokeTool('teams_search', { query: '' }, ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Invocation - Input Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('invokeTool - input validation', () => {
  it('applies default values from Zod schema', async () => {
    // teams_status has no required params — should validate successfully
    // (it will fail at the auth check level, not input validation)
    const result = await invokeTool('teams_status', {}, ctx);

    // The tool will fail because there's no real auth, but it should
    // pass input validation (not INVALID_INPUT)
    if (!result.success) {
      expect(result.error.code).not.toBe(ErrorCode.INVALID_INPUT);
    }
  });

  it('coerces valid optional parameters', async () => {
    // teams_get_thread with valid conversationId but optional limit
    // Will fail at auth, but should pass validation
    const result = await invokeTool('teams_get_thread', {
      conversationId: '19:abc@thread.tacv2',
    }, ctx);

    if (!result.success) {
      expect(result.error.code).not.toBe(ErrorCode.INVALID_INPUT);
    }
  });
});
