import { describe, expect, it } from 'vitest';
import { AntibotChallengeError, UnauthorizedError } from '../src/core/failures.js';
import { failedChatAllResult } from '../src/core/orchestrator.js';

/**
 * The parallel run catches the failure of every provider itself, so the kind of
 * the failure must survive the catch — otherwise the CLI cannot tell the user
 * what to do.
 */
describe('a failed provider of a parallel run', () => {
  it('keeps the kind of the failure', () => {
    expect(failedChatAllResult('chatgpt', new AntibotChallengeError()).kind).toBe('antibot');
    expect(failedChatAllResult('gemini', new UnauthorizedError('no session')).kind).toBe(
      'unauthorized',
    );
  });

  it('has no kind for an unclassified failure', () => {
    const result = failedChatAllResult('grok', new Error('something else'));
    expect(result.kind).toBeUndefined();
    expect(result.error).toBe('something else');
  });
});
