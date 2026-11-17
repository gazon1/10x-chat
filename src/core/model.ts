/**
 * The model of a chat command.
 *
 * The order of the precedence is the same as for the timeout: the flag of the
 * command → the config file → the default of the provider.
 *
 * `defaultModel` of the config file belongs to the chat commands (`chat`,
 * `delegate`): `research` selects a model only when it is asked to
 * (`--model`), and `image` has no model selection at all — a model that was
 * set for a chat must not change the other commands (see
 * `docs/config-contract.md`).
 */
export function chatModel(
  flagModel: string | undefined,
  configModel: string | undefined,
  providerDefaultModel: string | undefined,
): string | undefined {
  return flagModel ?? configModel ?? providerDefaultModel;
}
