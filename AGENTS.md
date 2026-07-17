# Agent working agreements — llm-local-router

Non-obvious operational rules for this extension. Baseline conventions:
commit-per-feature, no back-compat scaffolding, global/international provider
hosts (never China/regional endpoints), docs describe current state only. See
`DESIGN.md` for the full design.

## What it is

Self-contained VS Code extension: direct multi-provider LLM access + composite
models (`local/*` namespace) with in-process failover. No external router
service. The VS Code Language Model vendor id is `local` and composite models
are referenced under the `local/*` prefix — these are fixed identifiers, not
branding.

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

## Bazel (optional, for monorepo builds)

- The primary build is plain npm (`npm run compile`). A `BUILD.bazel` is also
  provided for building inside a Bazel monorepo.
- Targets: `//extensions/llm-local-router:build_extension` (→ `main.js`) and
  `:package` (→ `.vsix`, tagged `requires-network`). Both `genrule`s run
  `npm ci --ignore-scripts && npm run compile`.
- `BUILD.bazel` srcs use **`glob(["src/**/*.ts"])`**, so a new `src/*.ts` file is
  picked up automatically — no hand-listing needed. The glob covers `src/` (plus
  `vendor/vscode-dts/*.d.ts`), not `webview-ui/`.

## Proposed-API typings (vendored) — and why `enabledApiProposals` is absent

`package.json` deliberately declares **no `enabledApiProposals`**: `vsce` refuses
to publish any extension that declares one, and this extension is published to the
Marketplace + Open VSX. Do not re-add it.

Nothing is lost by that. `chatProvider` was **finalized in VS Code 1.104** (hence
the `engines.vscode: ^1.104.0` floor — a lower floor is a bug: the stable API does
not exist before 1.104). `languageModelThinkingPart` is still a proposal, but VS
Code never granted it here anyway (not in `product.json`'s allowlist, no
`--enable-proposed-api`), so declaring it bought nothing at runtime.

`tsconfig.json` still compiles against two `.d.ts` files vendored under
`vendor/vscode-dts/` because a few **types** remain proposal-only:
`LanguageModelThinkingPart`, `LanguageModelResponsePart2` (the type
`progress.report` accepts) and `LanguageModelConfigurationSchema`. They are
compile-time only, are excluded from the packaged `.vsix` (`.vscodeignore`), and
keep the build standalone with no external checkout. Refresh them from the matching
VS Code release when bumping the `engines.vscode` floor; drop a d.ts once
everything it declares appears in stable `@types/vscode`.

## Architecture (files)

`language-model-provider.ts` = the VS Code `LanguageModelChatProvider` (vendor
`local`) + cost ledger; `provider-client.ts` = ProviderRouter (model → built-in
or custom provider, base URLs); `composite.ts` = `local/*`
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
- **Never write `new vscode.LanguageModelThinkingPart(...)` or `x instanceof
  vscode.LanguageModelThinkingPart`.** Go through `makeThinkingPart()` /
  `isThinkingPart()` in `language-model-provider.ts`. The class belongs to a
  proposal this extension is not granted; it resolves today only because VS Code
  assigns it onto the API surface with no `checkProposedApiEnabled` guard. If that
  ever changes, the guarded helpers degrade (thinking parts are omitted) while a
  bare `new`/`instanceof` would throw on every request. **Never fall back to
  `LanguageModelTextPart`** — the `tool_preparing` / `response_metadata` payloads
  are `\x00`-delimited control strings and would become visible garbage.
- **Two unrelated import/export pairs share confusingly similar names.** The
  webview messages `importConfig`/`exportConfig` move **composite-model
  definitions** only; `importRouterConfig`/`exportRouterConfig` move the **whole
  router config** (provider keys, endpoints, `llmLocalRouter.*` settings) and are
  what the Config panel's Import/Export buttons send. Don't merge them.
- **`llmLocalRouter.importConfig` is dual-contract:** called with an argument
  (config object or file path) it imports silently and returns the result — the
  integration harness depends on that. Called with **no** argument it prompts for a
  file and reports the outcome, which is what the palette and the Config panel's
  button use. Keep both paths. `exportConfig` has no such split (a caller passing
  nothing is indistinguishable from the palette), so it stays a pure programmatic
  API and is hidden from the palette via `menus.commandPalette` `when: false`;
  the human-facing export is the webview button.
- **`exportRouterConfig` must never emit API key values** — only which providers
  are keyed. Exports are expected to be shareable; adding key values would silently
  turn every exported file into a live secret.
- **Per-model tool prefs (`includedTools`/`excludedTools`) are integrator-owned,
  never user settings.** They can't ride the VS Code `capabilities` type, so they
  travel via the `llmLocalRouter.getModelCapabilities` side-channel command.
- API keys live in VS Code `SecretStorage` (`llm-local-router.provider.{name}`);
  custom-provider metadata lives in `settings.json`
  (`llmLocalRouter.customProviders`) — keep the split.
- The Prometheus endpoint (`experimental.prometheusEndpoint`) is loopback-only,
  no-auth, default-off **by design** — don't "harden" it into an auth server.
