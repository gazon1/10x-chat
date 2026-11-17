# The transports

A prompt reaches a provider in one of two ways:

| Transport | How the prompt is sent | What it needs |
|---|---|---|
| `browser` (the default) | the web app of the provider is driven by a browser (Playwright/CloakBrowser) | a logged-in session in a browser profile |
| `api` | the HTTP API of the provider is called with an API key | an API key in the secrets store |

The transport is chosen explicitly: `10x-chat chat --transport api`. Without the
flag the browser is used — an existing run keeps working the way it worked
before the API transport existed.

## What the API transport does differently

| | `browser` | `api` |
|---|---|---|
| Browser | started, closed at the end | never started |
| Login | `10x-chat login <provider>` before the run | not needed — the API key is the credential |
| Profile / cookies | the profile of the provider | not used |
| Credential | the session of the profile | the secret of `providerKeys.<provider>` |
| Proxy | the effective proxy (see [config-contract.md](config-contract.md#5-the-proxy)) | the same effective proxy |
| Session, bundle, response | saved | saved — the same files, the same commands |
| `--attach` | uploaded to the composer | **rejected** — the run fails with an error |
| `--headed` / `--headless` / `--profile` | they decide the browser | **rejected** — an API run has no browser |
| `--model` | picked in the UI of the provider | sent as the model of the request |
| Streaming | the answer is printed while it is generated | not supported — the whole answer is printed at once |
| Cancellation | the browser is closed | not supported — the request runs until it is answered or the timeout is reached |
| Generated images | downloaded from the page | not supported — an API run produces no images |

A capability that the transport does not have is **rejected**, never silently
ignored: a prompt that is sent without its attachment is worse than a run that
fails.

## The setup

The API key lives in the secrets store — never in the config file, never in the
command line (see [secrets.md](secrets.md)):

```bash
10x-chat secrets set deepseek-key          # the value is read from stdin
```

The config file refers to the secret by name:

```json5
{
  providerKeys: { deepseek: 'deepseek-key' }
}
```

Then the prompt goes to the API:

```bash
10x-chat chat -p "Explain this" --provider deepseek --transport api
```

A provider without an API transport fails with an error — it never falls back
to the browser behind the back of the user.

## The providers with an API transport

| Provider | API | Notes |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/chat/completions` | the OpenAI-compatible chat completion |

## The failures

The API failures are normalized into the same model as the browser failures
([`FailureKind`](../src/core/failures.ts)):

| Situation | Kind | What the user can do |
|---|---|---|
| No API key is configured | `missing-credential` | create the secret and refer to it in `providerKeys` |
| HTTP 401 / 403 | `unauthorized` | check the key in the secrets store |
| HTTP 5xx | `unavailable` | check the network and the proxy |
| The deadline of the request is over | — (the session is marked `timeout`) | raise `--timeout` |
| The body of the answer is not the expected JSON | — (the session is marked `failed`) | the provider answered something else |

The key never reaches an error message or a log: the value of the secret is
replaced with `***` in every message of a failed run, and the headers of the
request are never part of a message.

## Writing an API transport

An API transport implements the `ApiTransport` interface — it is independent of
the browser: no selectors, no login check, no page.

```ts
export const myApiTransport: ApiTransport = {
  capabilities: { attachments: false, streaming: false, cancellation: false },
  async send(req) {
    const response = await req.client.request({
      url: 'https://api.example/v1/chat',
      method: 'POST',
      headers: { authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({ model: req.model, prompt: req.prompt }),
      timeoutMs: req.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ApiRequestError(response.status, `HTTP ${response.status}`);
    }
    return { text: '…', markdown: '…', truncated: false };
  },
};
```

It is registered in `src/providers/api/registry.ts`. The HTTP client
(`req.client`) is shared: it honors the effective proxy and the timeout, and it
is an interface — a transport is tested with a fake client, without a network
and without a browser (`tests/api-transport.test.ts`).
