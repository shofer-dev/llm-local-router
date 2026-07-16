# LLM Local Router — Integration Test Plan

Manual / live tests that can't be covered by the unit suite (`./run-tests.sh`) because
they need real provider API keys, a running VS Code + extension, or the webview. Each item
notes the change it validates (IDs from the code review / `TODO.md`). Please run through
these and check off / annotate results.

## Setup

```bash
cd extensions/llm-local-router
npm run compile                 # or: npm run package  → install the .vsix
cd webview-ui && npm install && npm run build && cd ..
```

Install the extension in VS Code (or `code --install-extension llm-local-router-*.vsix`),
then add at least one provider API key via **Command Palette → "LLM Local Router: Configure"
→ Config → Primary Providers**. Open the output channel "LLM Local Router" to watch logs.

---

## 1. Provider matrix (Basic / Tools / Thinking / Image)

For each provider with a key, run a simple chat, a tool-calling turn, a thinking/reasoning
turn, and (if supported) an image input. Record Y/N/NA.

- [ ] OpenAI
- [ ] Anthropic
- [ ] Google (Gemini)
- [ ] DeepSeek
- [ ] MiniMax
- [ ] Moonshot / Kimi
- [ ] Xiaomi MiMo
- [ ] Zhipu GLM / Z.ai
- [ ] OpenRouter
- [ ] A **custom provider** (register via webview → + New)
- [ ] Drive it all through **GitHub Copilot Chat** (vendor `local`) end-to-end

## 2. Streaming correctness (validates #P3, #P6, #P7)

- [ ] **Anthropic streaming finish reason** (#P3): stream a turn that ends in a tool call;
  confirm the final response's `finishReason` is `tool_calls` (not always `stop`). Stream a
  normal turn and confirm `stop`.
- [ ] **Gemini streaming tool calls** (#P6/#P7): trigger a Gemini turn with **parallel** or
  repeated calls to the same tool; confirm each tool call has a **unique id** and that all
  calls survive in the final aggregated response (not just the streamed deltas).
- [ ] **General streaming**: text streams incrementally for every provider; no dropped final
  line, no duplicated content (validates the shared `readSSE` reader, #P11/#P8).

## 3. Cost & metrics (validates #P1, #P2, #M5, #M6)

- [ ] **Cost is non-zero for Anthropic & Google** (#P1/#P2): after a few requests, run
  **"LLM Local Router: Show Cost History"** / check the Metrics dashboard — Anthropic and Gemini
  rows must show real USD cost (previously $0). Gemini cached-token requests should reflect
  the cache discount.
- [ ] **Metrics dashboard** populates: open **Metrics** tab; all charts render; time-range
  switch (1h/6h/24h) refetches; the Primary/Composite model picker filters lines.
- [ ] **Percentiles** (#M6): latency p50/p90/p99 appear and look sane under load — verify the
  values still update correctly now that they're computed lazily.
- [ ] **Persistence** (#M5): generate metrics, **reload the window**, reopen Metrics — history
  survives. (Writes are debounced ~1.5s; a clean reload flushes synchronously.)

## 4. Composite models (validates #C1, #C2, #C3, #C4, #C16, #C18)

Define composites in `llmLocalRouter.compositeModelsConfig` or the **Composite Models** tab.

- [ ] **Failover across strategies** (#C1/#C2): make a `round_robin` and a `lowest_latency`
  composite where the **first/preferred** model has a bad key (forces a pre-first-byte
  failure). Confirm the request **fails over** to the next model instead of erroring out.
- [ ] **failover** strategy: strict order; on first-model failure, next is used.
- [ ] **round_robin**: weighted distribution roughly matches weights over many requests
  (check "Show Composite Distribution").
- [ ] **lowest_latency**: picks the fastest model; after a model goes idle past the window,
  it's no longer preferred (windowed mean, not stale).
- [ ] **highest_reliability**: prefers the model with the best recent success ratio.
- [ ] **Mid-stream failure health** (#C3): if a model fails *after* first byte repeatedly,
  confirm it eventually gets marked degraded/unhealthy (no failover mid-stream, but health
  is still recorded).
- [ ] **Throttling** (#C4): set a low `requestsPerWindow`; confirm excess requests skip the
  throttled model (Metrics → throttle skips) and routing stays deterministic.
- [ ] **Ambiguous model ID** (#C16): add a composite underlying model `gemini-3.1-pro-preview`
  (bare). Validation should reject it and tell you to use `google/...` or `vertex/...`.
- [ ] **`metricsWindowMs` alias** (#C18): a composite using `metricsWindowMs` behaves the same
  as one using `latencyWindowMs`; both are honored.

## 5. Providers that fail fast / special auth (validates #P4, Vertex)

- [ ] **Bedrock** (#P4): selecting a Bedrock model returns a **clear "not yet supported"**
  error message (not a confusing HTTP error).
- [ ] **Vertex**: routes through the native Gemini path; document whether a bearer token
  works (full GoogleAuth/service-account is not yet wired).

## 6. Webview UI (validates #W1, #W4, #W5, #W6, #W20)

- [ ] **Advanced provider fields** (#W1): for a provider with advanced fields (e.g. Bedrock
  region, Ollama `num_ctx`), type values, Save, reopen — values **persist** (previously they
  were silently dropped).
- [ ] **Composite list strategy labels** (#W5): `lowest_latency` / `highest_reliability`
  composites show their real strategy name (not "Round Robin").
- [ ] **Metrics live data** (#W4): confirm the dashboard updates on time-range change /
  remount (the dead `metrics` prop pipeline was removed — verify nothing regressed).
- [ ] **Keyboard navigation** (#W20): Tab to composite rows, provider rows, metric model
  options, and the tab bar; Enter/Space activates them; screen-reader labels read on icon
  buttons and inputs.
- [ ] **Dev server fallback** (#W6): `npm run dev` in `webview-ui` (bare Vite) should not throw
  on first `postMessage` (uses the no-op stub outside VS Code).

## 7. Config, lifecycle, endpoint (validates #E1, #E5, #E8)

- [ ] **Onboarding popup** (#E1): first install shows "LLM Local Router is ready! 👋 …" with a
  real wave emoji (not `\u{1F44B}`).
- [ ] **Activation** (#E8): extension activates on startup; opening a `.json`/`.md` file no
  longer eagerly activates it before startup.
- [ ] **Prometheus endpoint** (#E5): set `llmLocalRouter.experimental.prometheusEndpoint: true`,
  reload, then `curl -s 127.0.0.1:30098/metrics` — returns Prometheus text including
  `llm_local_router_*` series (and `llm_local_router_composite_midstream_failure_total`). Confirm it
  is **not** reachable from another host. Toggle off → endpoint closes; toggle on again →
  it restarts (no `EADDRINUSE`).
- [ ] **Clean teardown**: disable the extension / reload repeatedly — no lingering port, no
  dangling reconnect timers (health-checker), metrics flushed.

## 8. Regression guard for deferred refactors

When the deferred webview splits (#W10 `ProvidersPanel`, #W11 `MetricsPanel`) are eventually
done, re-run **§3** (metrics dashboard) and **§6** (provider config + advanced fields +
keyboard nav) to confirm no behavioral regression, since those components have no automated
runtime coverage.

---

# Automated test coverage (to add)

Sections 1–8 above are the **manual / live** layer (need real provider keys, a
running VS Code, or the webview). Most of it can actually be **automated** because
the router talks to providers over plain **OpenAI-compatible HTTP** — so a **mock
provider server** is the deterministic stand-in for real keys, exactly as
`extensions/integration`'s **mock LLM** is for Shofer. Three layers:

- **L0 — Unit** (`./run-tests.sh`, mock `vscode`/`fetch`): pure logic.
- **L1 — Integration** (the router driven against **mock provider servers** that
  return scripted SSE / errors / latency / usage): routing, failover, streaming,
  cost, metrics, health — **deterministic, no real keys**. Plus **Playwright** for
  the webview-ui (in code-server via the [`extensions/integration`](../integration/DESIGN.md) harness).
- **L2 — Live** (real provider keys / real Copilot Chat / real Prometheus curl):
  the residue that mocks can't cover. Non-gating.

> Already automated (don't re-add): `composite` (strategy **selection** logic —
> failover/round-robin/highest-reliability/health-skip/throttle/cold-start),
> `config-converter`, `llm-client`, `metrics-collector`, `metrics-server`,
> `model-registry`, `providers`. The gaps below are the **untested files**
> (`provider-client`, `language-model-provider`, `health-checker`,
> `router-config-provider`, `secret-storage`, `metrics-storage`, `main`), the
> **full request pipeline** against mock providers, and the **webview-ui**.

## L0 — Unit (mock `vscode` / `fetch`)

- [ ] **U-PROVCLIENT** `provider-client.ts`: `getBaseUrl` per provider + custom
  `endpointUrl` + OpenRouter routing; request construction (auth header, model id,
  body) per provider adapter; the `providers/*` adapters' request/response mapping
  where not already in `providers.test.ts`.
- [ ] **U-LMPROVIDER** `language-model-provider.ts`: maps a VS Code LM request →
  router call → streams `LanguageModelChatResponse` parts; tool-call parts;
  finish-reason mapping (#P3); image-input pass-through; the response-metadata marker.
- [ ] **U-HEALTH** `health-checker.ts`: marks degraded/unhealthy on repeated
  failure, recovers on success; reconnect **backoff timers** are created and
  **cleared on dispose** (the §7 "no dangling reconnect timers" guard, automatable).
- [ ] **U-CFG** `router-config-provider.ts`: composite-config parse/validate —
  **ambiguous bare model id rejected** (#C16: `gemini-3.1-pro-preview` → "use
  `google/…`/`vertex/…`"), **`metricsWindowMs` alias** honored == `latencyWindowMs`
  (#C18), string vs `{model,weight}` lists, bad weights.
- [ ] **U-SECRET** `secret-storage.ts`: key store/get/delete; redaction; missing key path.
- [ ] **U-METSTORE** `metrics-storage.ts`: **debounced writes** + **synchronous
  flush on reload** so history survives (#M5); percentile data round-trips (#M6).
- [ ] **U-MAIN** `main.ts`: activation is **not eager** on opening `.json`/`.md`
  (#E8); status-bar item created/updated; **Prometheus toggle lifecycle** — on →
  binds, off → closes, on again → rebinds with **no `EADDRINUSE`** (#E5); onboarding
  popup string has a real emoji (#E1).

## L1 — Integration (router ⇄ mock provider servers; deterministic gate)

### Harness
- [ ] **I-H1 Mock provider server.** A local OpenAI-compatible HTTP server
  (`/chat/completions`, streaming + non-streaming) that, per test, scripts: SSE
  token streams, tool-call deltas, `finish_reason`, `usage` tokens, injected
  **errors** (pre-first-byte vs mid-stream), and **latency**. Point the router's
  provider `baseUrl`/`endpointUrl` at it (no real keys).
- [ ] **I-H2 Driver.** Exercise the pipeline either in-process (construct the
  router + call its chat path) or through `vscode.lm.sendChatRequest` in an
  extension-host test. Assert on streamed parts, the aggregated response, metrics,
  and routing decisions.

### Streaming correctness (automates §2)
- [ ] **I-S1** Anthropic-path finish reason is `tool_calls` when the turn ends in a
  tool call, `stop` otherwise (#P3).
- [ ] **I-S2** Gemini-path **parallel / repeated** tool calls each get a **unique id**
  and all survive aggregation (#P6/#P7).
- [ ] **I-S3** Text streams incrementally with no dropped final line / no dup, every
  adapter (shared `readSSE`, #P8/#P11).

### Composite routing + failover (automates §4, deterministically)
- [ ] **I-C1** `failover` strict order; first model returns a **pre-first-byte** error
  → next model used; all fail → error (#C1/#C2).
- [ ] **I-C2** `round_robin` weighted distribution over many requests ≈ weights.
- [ ] **I-C3** `lowest_latency` picks the fastest (mock latencies); a model idle past
  the window stops being preferred (windowed mean).
- [ ] **I-C4** `highest_reliability` prefers the model with the better recent success
  ratio (mock scripted success/fail).
- [ ] **I-C5** Health: a model failing **mid-stream** repeatedly is marked degraded
  (no mid-stream failover, but health recorded) (#C3).
- [ ] **I-C6** Throttling: low `requestsPerWindow` → excess requests **skip** the
  throttled model; routing stays deterministic (#C4).

### Cost, metrics, fail-fast (automates §3 + §5)
- [ ] **I-M1** Anthropic & Google requests yield **non-zero USD** cost from mock
  `usage`; Gemini cached-token discount applies (#P1/#P2).
- [ ] **I-M2** Metrics collector aggregates the mock runs; p50/p90/p99 computed (#M6).
- [ ] **I-M3** Bedrock model → clear **"not yet supported"** error, not a raw HTTP
  failure (#P4).

### Prometheus endpoint (automates the §7 #E5 curl)
- [ ] **I-P1** With the endpoint enabled, an HTTP GET `/metrics` returns Prometheus
  text incl. `llm_local_router_*` and `…_composite_midstream_failure_total`; it is
  **loopback-only** (a non-loopback bind/host is refused); toggle off closes it;
  toggle on rebinds (no `EADDRINUSE`).

## L1 — Playwright / component (webview-ui)

The dashboard is React+Vite (`webview-ui/`). Cheap **component tests** (vitest +
React Testing Library, mocked `postMessage`) cover most #W items without VS Code;
reserve **Playwright-in-code-server** (via the integration harness) for the true
end-to-end wiring.

- [ ] **W-C1** (component) Provider config form persists **advanced fields**
  (Bedrock region, Ollama `num_ctx`) through save/reopen (#W1).
- [ ] **W-C2** (component) Composite list shows the **real strategy label**
  (`lowest_latency`/`highest_reliability`, not "Round Robin") (#W5).
- [ ] **W-C3** (component) Metrics panel refetches on time-range change / remount;
  model picker filters lines (#W4, §3 dashboard).
- [ ] **W-C4** (component) **Keyboard nav / a11y**: Tab/Enter/Space reach and
  activate composite rows, provider rows, metric options, tab bar; aria labels on
  icon buttons/inputs (#W20).
- [ ] **W-C5** (build) Bare-Vite `npm run dev` doesn't throw on first `postMessage`
  (no-op stub outside VS Code) (#W6).
- [ ] **W-E1** (Playwright, code-server) Full round-trip: open the LLM Local Router
  webview, add a provider + key, save → persisted to secret storage → used by a
  mock-provider-backed request; the status-bar item reflects state. (Automates the
  live parts of §6 end-to-end.)

## Tooling / infra to stand up

- [ ] The **mock provider server** (reusable across all I-* cases — the single
  biggest unlock; converts most of §1–§4 from manual to gated).
- [ ] `vscode` + `fetch` mock shims for L0; vitest + RTL for webview-ui component tests.
- [ ] CI: L0 + L1(mock providers + component) gate every change; L2 (real keys,
  real Copilot Chat, real Prometheus from another host) stays manual/scheduled.
