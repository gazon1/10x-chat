import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_CONFIG,
  deepseekActions,
  extractDeepSeekFailureText,
} from '../src/providers/deepseek.js';

describe('DeepSeek Provider', () => {
  describe('DEEPSEEK_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(DEEPSEEK_CONFIG.name).toBe('deepseek');
    });

    it('should have correct display name', () => {
      expect(DEEPSEEK_CONFIG.displayName).toBe('DeepSeek');
    });

    it('should have correct URL', () => {
      expect(DEEPSEEK_CONFIG.url).toBe('https://chat.deepseek.com');
    });

    it('should point login to the sign-in page', () => {
      expect(DEEPSEEK_CONFIG.loginUrl).toBe('https://chat.deepseek.com/sign_in');
    });

    it('should offer the chat and reasoning models', () => {
      expect(DEEPSEEK_CONFIG.models).toContain('deepseek-chat');
      expect(DEEPSEEK_CONFIG.models).toContain('deepseek-reasoner');
    });

    it('should default to deepseek-chat', () => {
      expect(DEEPSEEK_CONFIG.defaultModel).toBe('deepseek-chat');
    });

    it('should have a 5-minute default timeout', () => {
      expect(DEEPSEEK_CONFIG.defaultTimeoutMs).toBe(5 * 60 * 1000);
    });
  });

  describe('extractDeepSeekFailureText', () => {
    it('detects server-busy failures', () => {
      expect(extractDeepSeekFailureText('Server busy, please try again later.')).toBe(
        'Server busy, please try again later.',
      );
    });

    it('detects rate-limit failures', () => {
      expect(extractDeepSeekFailureText('Too many requests. Try again later.')).toBe(
        'Too many requests. Try again later.',
      );
    });

    it('detects unavailable-service failures', () => {
      expect(extractDeepSeekFailureText('System temporarily unavailable')).toBe(
        'System temporarily unavailable',
      );
    });

    it('detects network failures', () => {
      expect(
        extractDeepSeekFailureText('Network Error. Please check your network status.'),
      ).toBe('Network Error. Please check your network status.');
    });

    it('does not flag normal assistant responses', () => {
      expect(extractDeepSeekFailureText('Here is the answer you asked for.')).toBeNull();
    });

    it('does not flag empty text', () => {
      expect(extractDeepSeekFailureText('   ')).toBeNull();
    });
  });

  describe('deepseekActions', () => {
    it('should export all required action methods', () => {
      expect(deepseekActions.isLoggedIn).toBeTypeOf('function');
      expect(deepseekActions.submitPrompt).toBeTypeOf('function');
      expect(deepseekActions.captureResponse).toBeTypeOf('function');
    });

    it('should export optional selectModel method', () => {
      expect(deepseekActions.selectModel).toBeTypeOf('function');
    });
  });
});
