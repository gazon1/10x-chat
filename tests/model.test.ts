import { describe, expect, it } from 'vitest';
import { chatModel } from '../src/core/model.js';

describe('model of a chat command', () => {
  it('prefers the flag over the config file', () => {
    expect(chatModel('from-flag', 'from-config', 'from-provider')).toBe('from-flag');
  });

  it('prefers the config file over the default of the provider', () => {
    expect(chatModel(undefined, 'from-config', 'from-provider')).toBe('from-config');
  });

  it('falls back to the default of the provider', () => {
    expect(chatModel(undefined, undefined, 'from-provider')).toBe('from-provider');
  });

  it('has no model when nothing names one', () => {
    expect(chatModel(undefined, undefined, undefined)).toBeUndefined();
  });
});
