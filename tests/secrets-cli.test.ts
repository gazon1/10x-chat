import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The prompt of the library is replaced: the real one needs a terminal.
vi.mock('@inquirer/prompts', () => ({ password: vi.fn() }));

const { password } = await import('@inquirer/prompts');
const { readValue, createSecretsCommand } = await import('../src/cli/secrets.js');

/** A stream that pretends to be a terminal (the prompt branch). */
function terminal(): Readable & { isTTY?: boolean } {
  return Object.assign(Readable.from([]), { isTTY: true });
}

describe('reading the value of a secret', () => {
  beforeEach(() => {
    vi.mocked(password).mockReset();
  });

  it('reads a piped stdin as is', async () => {
    const input = Readable.from(['super-secret-value']);
    expect(await readValue(input)).toBe('super-secret-value');
  });

  it('drops only the trailing newline of a piped stdin', async () => {
    const input = Readable.from(['super-secret-value\n']);
    expect(await readValue(input)).toBe('super-secret-value');
  });

  it('keeps a value that ends with a newline of its own', async () => {
    const input = Readable.from(['super-secret-value\n\n']);
    expect(await readValue(input)).toBe('super-secret-value\n');
  });

  it('asks with the echo switched off in a terminal', async () => {
    vi.mocked(password).mockResolvedValue('typed-value');
    expect(await readValue(terminal())).toBe('typed-value');
    expect(password).toHaveBeenCalledWith({ message: 'Value (input hidden):' });
  });
});

describe('the name of a secret', () => {
  beforeEach(() => {
    vi.mocked(password).mockReset();
  });

  it('is checked before the value is asked for', async () => {
    const cmd = createSecretsCommand();

    await expect(cmd.parseAsync(['set', '../escape'], { from: 'user' })).rejects.toThrow(
      /Invalid secret name/,
    );
    // The user was not asked for a password that could not be stored.
    expect(password).not.toHaveBeenCalled();
  });

  it('is checked before a secret is removed', async () => {
    const cmd = createSecretsCommand();

    await expect(cmd.parseAsync(['remove', '../escape'], { from: 'user' })).rejects.toThrow(
      /Invalid secret name/,
    );
  });
});
