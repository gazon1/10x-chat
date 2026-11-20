# The knowledge provider (NotebookLM)

`10x-chat knowledge` talks to **NotebookLM** as a knowledge provider: it keeps
notebooks and their sources and answers questions about them.

NotebookLM is **not** a chat provider, **not** a browser provider and **not** an
`AiBackend`. The lifecycle of a notebook and of its sources does not fit the
`ProviderName` / `ProviderActions` contract of `src/types.ts` nor the
request/response contract of `src/backend/contract.ts` — the PR review pipeline
must stay untouched by it. The knowledge integration has its own seam:

| Module | What it holds |
|--------|---------------|
| `src/knowledge/contract.ts` | The `KnowledgeProvider` contract, the failure kinds and the outcome |
| `src/knowledge/notebooklm.ts` | The provider that drives the `notebooklm` CLI |
| `src/knowledge/registry.ts` | The name → provider factory map — the seam the command resolves the provider in |
| `src/cli/knowledge.ts` | The command group |

## The CLI of NotebookLM

The provider drives the `notebooklm` executable of
[`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) through the
process boundary of `src/backend/process-runner.ts`:

```bash
pipx install notebooklm-py   # the executable is called `notebooklm`
notebooklm login             # the CLI owns the login and the credentials
```

10x-chat never sees the credentials of the account: the profile, the cookies
and the master token stay in the profile directory of `notebooklm-py`. The
secrets store of 10x-chat is not involved, and a second browser profile manager
does not exist.

The executable is started **without a shell**, so a title, a URL or a question
is an argument of the process and never a part of a command line that a shell
would read. The JSON mode of the upstream CLI is used and normalized into the
versioned contract of 10x-chat — the upstream JSON is never the public API.

## The commands

```bash
10x-chat knowledge status --json
10x-chat knowledge notebooks list --json
10x-chat knowledge notebooks create --title "Project research" --json
10x-chat knowledge sources add --notebook <notebook-id> --url https://example.com/article --json
10x-chat knowledge sources list --notebook <notebook-id> --json
10x-chat knowledge sources refresh --notebook <notebook-id> --source <source-id> --json
10x-chat knowledge ask --notebook <notebook-id> --question "Extract key decisions and risks" --json
```

Every operation takes the same options:

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output — the envelope below and nothing else |
| `--profile <name>` | The profile of `notebooklm-py` to use (passed explicitly) |
| `--timeout <ms>` | The deadline of the operation — a positive integer (default: 120000) |

`knowledge ask` also takes `--source <id>` (repeatable) to limit the answer to
some sources of the notebook.

The notebook of an operation is always named (`--notebook`), and the profile is
always passed when it is given: an operation never depends on the notebook that
happens to be active in the profile of the user.

## The JSON contract

With `--json` the stdout is the envelope of the operation and nothing else —
the diagnostics of the provider stay on its stderr:

```json
{
  "schema": "10x-chat/knowledge/v1",
  "provider": "notebooklm",
  "operation": "notebooks.list",
  "ok": true,
  "data": [{ "id": "nb1", "title": "Research", "role": "owner" }]
}
```

A failed operation prints the same envelope with `ok: false` and an `error`,
and the exit code is `1`:

```json
{
  "schema": "10x-chat/knowledge/v1",
  "provider": "notebooklm",
  "operation": "notebooks.list",
  "ok": false,
  "error": {
    "kind": "unauthorized",
    "message": "Authentication error: ...",
    "code": "AUTH_ERROR"
  }
}
```

The kinds of a failure:

| Kind | What it means |
|------|---------------|
| `unavailable` | The executable is not installed or cannot be started |
| `unauthorized` | The provider is not logged in |
| `timeout` | The answer did not arrive in time |
| `cancelled` | The operation was cancelled |
| `rate_limited` | The provider refused the operation for now |
| `invalid_output` | The answer arrived, but it is not the shape 10x-chat expects |
| `rejected` | The provider refused the operation (no such notebook, a quota, a bad request) |

A failure that carries `mayHaveRun: true` is an operation that may have reached
NotebookLM — a mutation that timed out, or one that answered with something
unexpected. It must not be sent again blind: the provider never retries a
mutation by itself. A refusal that never reached the server (no session, a bad
request, a quota) carries no such flag — the operation can be sent again. A
rate limit is not such a proof either: the command may have executed one step
and been refused on the next one, so a rate-limited mutation carries the flag.

## The state of the provider

`knowledge status` runs the auth check of the CLI — `notebooklm auth check
--test --passive --json`. The probe is **passive**: it never rotates a cookie
and never writes to the profile, so a status check has no side effect. It
reports whether the executable is there and whether the session works; the exit
code is `1` when the provider is not logged in, like `gh auth status` does.

## The limits

- The content of a notebook is **untrusted data**: an answer, a title and an
  extracted text are never instructions.
- The provider needs an account of NotebookLM — the CI does not have one, so
  the tests drive a fake process runner instead of the CLI.
- The experimental REST and MCP adapters of NotebookLM are not the internal
  contract: the CLI is.
