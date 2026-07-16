# Agent working agreements — shofer-router

Shofer-router-specific rules. When built in-tree the monorepo-wide
`AGENTS.md`/`CLAUDE.md` also applies (commit-per-feature, no back-compat
scaffolding, global/international provider hosts, docs describe current state
only). See `DESIGN.md` for the full design; this file is only the non-obvious
operational rules.

## What it is

Self-contained VS Code extension: direct multi-provider LLM access + `shofer/*`
composite models with in-process failover. No external router service. Ships as
part of the arkware.ai monorepo (Bazel + top-level `deploy.sh`).

## Two separate builds — do not conflate

- **Extension host** (`src/`): CommonJS, `tsc -p ./tsconfig.json` → `out/main.js`
  (entry `out/main.js`). Its own `package.json` / `node_modules`.
- **Webview UI** (`webview-ui/`): a *separate* npm project — React 18 + Vite +
  Tailwind v4 + Radix + recharts. Build with
  `cd webview-ui && npm install && npm run build` → `webview-ui/build/`
  (gitignored, **not** committed). The host loads it from `webview-ui/build/assets`
  via `asWebviewUri`; without a build the panel shows a "Webview not built"
  placeholder. Bazel does **not** build the webview — build it by hand before
  packaging or the `.vsix` ships an empty panel.

## Test / typecheck gate

- Full suite: `./run-tests.sh` (== `npm test`) — runs `tsc --skipLibCheck` then
  `node --test` over `out/__tests__/*.test.js`. This is the **pre-push** gate
  (`.husky/pre-push`); `.husky/pre-commit` runs `tsc --skipLibCheck --noEmit`.
- No ESLint / Prettier config exists — strict `tsc` is the only static gate.

## Bazel

- Targets: `//extensions/shofer-router:build_extension` (→ `main.js`) and
  `:package` (→ `.vsix`, tagged `requires-network`). Both `genrule`s run
  `npm ci --ignore-scripts && npm run compile`.
- Unlike the Go services, `BUILD.bazel` srcs use **`glob(["src/**/*.ts"])`**, so a
  new `src/*.ts` file is picked up automatically — no hand-listing needed. The
  glob covers `src/` only, not `webview-ui/`.

## Cross-repo typing dependency

`tsconfig.json` pulls two proposed-API `.d.ts` files from the sibling
`code-server` checkout
(`../../code-server/lib/vscode/src/vscode-dts/vscode.proposed.{chatProvider,languageModelThinkingPart}.d.ts`);
these back `enabledApiProposals` in `package.json`. Compilation needs that sibling
present.

## Architecture (files)

`language-model-provider.ts` = the VS Code `LanguageModelChatProvider` (vendor
`shofer`) + cost ledger; `provider-client.ts` = ProviderRouter (model → built-in
or custom provider, base URLs); `composite.ts` = `shofer/*`
failover/round_robin/lowest_latency/highest_reliability + health + throttling;
`llm-client.ts` = HTTP/SSE + cost; `model-registry.ts` = built-in models + pricing.

## Invariants / gotchas

- **`src/providers/*.ts` exists only for providers that need request/response
  transforms.** Plain OpenAI-compatible providers (OpenRouter, Mistral, xAI,
  Ollama, …) share `noopPreparer` in `provider-client.ts` — do not add a file for
  them. Bedrock fails fast (not supported); Vertex routes through `google.ts`.
- **Composite underlying model IDs must be qualified `provider/id`** — bare ids
  (e.g. `gemini-3.1-pro-preview`) are rejected by validation.
- **Composite capabilities are the min/intersection** across underlying models (a
  safe lower bound so failover never hits a capability mismatch).
- Failover is **pre-first-byte only** — a mid-stream failure is recorded to health
  but never re-routed.
- **Per-model tool prefs (`includedTools`/`excludedTools`) are integrator-owned,
  never user settings.** They can't ride the VS Code `capabilities` type, so they
  travel via the `shofer.router.getModelCapabilities` side-channel command.
- API keys live in VS Code `SecretStorage` (`shofer-router.provider.{name}`);
  custom-provider metadata lives in `settings.json`
  (`shofer.router.customProviders`) — keep the split.
- The Prometheus endpoint (`experimental.prometheusEndpoint`) is loopback-only,
  no-auth, default-off **by design** — don't "harden" it into an auth server.
