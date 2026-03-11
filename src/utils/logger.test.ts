/**
 * Unit tests for the logger module.
 *
 * Tests log level filtering and output formatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { error, warn, info, debug, setLogLevel } from './logger.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('info');
});

describe('log output formatting', () => {
  it('prefixes messages with [context]', () => {
    setLogLevel('debug');

    error('auth', 'token expired');
    expect(console.error).toHaveBeenCalledWith('[auth] token expired');

    warn('http', 'slow response');
    expect(console.warn).toHaveBeenCalledWith('[http] slow response');

    info('server', 'started');
    expect(console.log).toHaveBeenCalledWith('[server] started');

    debug('parser', 'parsing item');
    expect(console.debug).toHaveBeenCalledWith('[parser] parsing item');
  });
});

describe('log level filtering', () => {
  it('at error level, only errors are shown', () => {
    setLogLevel('error');

    error('ctx', 'err msg');
    warn('ctx', 'warn msg');
    info('ctx', 'info msg');
    debug('ctx', 'debug msg');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('at warn level, errors and warnings are shown', () => {
    setLogLevel('warn');

    error('ctx', 'err');
    warn('ctx', 'warn');
    info('ctx', 'info');
    debug('ctx', 'debug');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('at info level (default), errors, warnings, and info are shown', () => {
    setLogLevel('info');

    error('ctx', 'err');
    warn('ctx', 'warn');
    info('ctx', 'info');
    debug('ctx', 'debug');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('at debug level, all messages are shown', () => {
    setLogLevel('debug');

    error('ctx', 'err');
    warn('ctx', 'warn');
    info('ctx', 'info');
    debug('ctx', 'debug');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.debug).toHaveBeenCalledTimes(1);
  });
});
