/**
 * The timeout of a command, in milliseconds.
 *
 * The order of the precedence is the same for every command:
 * the flag of the command → the config file → the default of the command.
 *
 * `defaultTimeoutMs` of the config file belongs to the chat commands only
 * (`chat`, `delegate`): `image` and `research` have their own, much longer
 * defaults, and a chat timeout must not shorten a research run
 * (see `docs/config-contract.md`).
 */

/** The default timeout of the image generation. */
export const IMAGE_TIMEOUT_MS = 120_000;

/** The default timeout of the deep research. */
export const RESEARCH_TIMEOUT_MS = 600_000;

/**
 * The timeout of a chat command: the flag, then the config file, then the
 * default of the provider.
 */
export function chatTimeoutMs(
  flagMs: number | undefined,
  configMs: number | undefined,
  providerDefaultMs: number,
): number {
  return flagMs ?? configMs ?? providerDefaultMs;
}

/**
 * Is the error the timeout of the answer capture (the provider never finished
 * streaming)? A Playwright wait ("Timeout 15000ms exceeded") is a failure of
 * the interaction, not a slow answer, so it must not be reported as a timeout.
 */
export function isResponseTimeout(error: unknown): boolean {
  return error instanceof Error && /^timed out waiting/i.test(error.message);
}

/**
 * The timeout of a command with its own default (`image`, `research`).
 *
 * There is no config value here on purpose: `defaultTimeoutMs` is the timeout
 * of a chat and must not change the other commands.
 */
export function commandTimeoutMs(flagMs: number | undefined, defaultMs: number): number {
  return flagMs ?? defaultMs;
}
