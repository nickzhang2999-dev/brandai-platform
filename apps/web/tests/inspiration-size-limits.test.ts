import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSizeLimits } from '../src/lib/inspiration/config';

beforeEach(() => {
  vi.stubEnv('INSPIRATION_MAX_PACKAGE_MIB', '');
  vi.stubEnv('INSPIRATION_MAX_SYNC_MIB', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('bounded operator reception sizes', () => {
  it('retains the existing defaults', () => {
    expect(syncSizeLimits()).toEqual({packageBytes: 128 * 1024 ** 2, syncBytes: 256 * 1024 ** 2});
  });
  it('permits an explicit 256 MiB checkpoint and 512 MiB history budget', () => {
    vi.stubEnv('INSPIRATION_MAX_PACKAGE_MIB', '256');
    vi.stubEnv('INSPIRATION_MAX_SYNC_MIB', '512');
    expect(syncSizeLimits()).toEqual({packageBytes: 256 * 1024 ** 2, syncBytes: 512 * 1024 ** 2});
  });
  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '513', '99999999999999999'])('rejects invalid or unbounded value %s', value => {
    vi.stubEnv('INSPIRATION_MAX_PACKAGE_MIB', value);
    expect(() => syncSizeLimits()).toThrow('Invalid inspiration size limits');
    vi.stubEnv('INSPIRATION_MAX_PACKAGE_MIB', '128');
    vi.stubEnv('INSPIRATION_MAX_SYNC_MIB', value);
    expect(() => syncSizeLimits()).toThrow('Invalid inspiration size limits');
  });
  it('rejects a history budget smaller than one allowed package', () => {
    vi.stubEnv('INSPIRATION_MAX_PACKAGE_MIB', '256');
    vi.stubEnv('INSPIRATION_MAX_SYNC_MIB', '128');
    expect(() => syncSizeLimits()).toThrow('Invalid inspiration size limits');
  });
});
