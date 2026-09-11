/**
 * Log level resolution.
 *
 * A blank `LOG_LEVEL=` in a .env file arrives as an empty string, and pino
 * throws on an empty level name. Copying .env.example, which ships that blank
 * line, must still boot.
 */
import { describe, it, expect } from 'vitest';
import { resolveLogLevel } from '../src/lib/logger.js';

describe('resolveLogLevel', () => {
  it('treats a blank value as unset', () => {
    expect(resolveLogLevel('', { test: false, prod: false })).toBe('debug');
    expect(resolveLogLevel('', { test: false, prod: true })).toBe('info');
  });

  it('honours an explicit level', () => {
    expect(resolveLogLevel('warn', { test: false, prod: true })).toBe('warn');
  });

  it('is silent under test, whatever is configured', () => {
    expect(resolveLogLevel('debug', { test: true, prod: false })).toBe('silent');
  });
});
