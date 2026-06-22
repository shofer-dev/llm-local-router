# Shofer Router — Integration Test Plan

Manual / live tests that can't be covered by the unit suite (`./run-tests.sh`) because
they need real provider API keys, a running VS Code + extension, or the webview. Each item
notes the change it validates (IDs from the code review / `TODO.md`). Please run through
these and check off / annotate results.

## Setup

```bash
cd extensions/shofer-router
npm run compile                 # or: npm run package  → install the .vsix
cd webview-ui && npm install && npm run build && cd ..
```

Install the extension in VS Code (or `code --install-extension shofer-router-*.vsix`),
then add at least one provider API key via **Command Palette → "Shofer Router: Configure"
→ Config → Primary Providers**. Open the output channel "Shofer Router" to watch logs.

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
- [ ] Drive it all through **GitHub Copilot Chat** (vendor `shofer`) end-to-end

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
  **"Shofer Router: Show Cost History"** / check the Metrics dashboard — Anthropic and Gemini
  rows must show real USD cost (previously $0). Gemini cached-token requests should reflect
  the cache discount.
- [ ] **Metrics dashboard** populates: open **Metrics** tab; all charts render; time-range
  switch (1h/6h/24h) refetches; the Primary/Composite model picker filters lines.
- [ ] **Percentiles** (#M6): latency p50/p90/p99 appear and look sane under load — verify the
  values still update correctly now that they're computed lazily.
- [ ] **Persistence** (#M5): generate metrics, **reload the window**, reopen Metrics — history
  survives. (Writes are debounced ~1.5s; a clean reload flushes synchronously.)

## 4. Composite models (validates #C1, #C2, #C3, #C4, #C16, #C18)

Define composites in `shofer.router.compositeModelsConfig` or the **Composite Models** tab.

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

- [ ] **Onboarding popup** (#E1): first install shows "Shofer Router is ready! 👋 …" with a
  real wave emoji (not `\u{1F44B}`).
- [ ] **Activation** (#E8): extension activates on startup; opening a `.json`/`.md` file no
  longer eagerly activates it before startup.
- [ ] **Prometheus endpoint** (#E5): set `shofer.router.experimental.prometheusEndpoint: true`,
  reload, then `curl -s 127.0.0.1:30098/metrics` — returns Prometheus text including
  `shofer_router_*` series (and `shofer_router_composite_midstream_failure_total`). Confirm it
  is **not** reachable from another host. Toggle off → endpoint closes; toggle on again →
  it restarts (no `EADDRINUSE`).
- [ ] **Clean teardown**: disable the extension / reload repeatedly — no lingering port, no
  dangling reconnect timers (health-checker), metrics flushed.

## 8. Regression guard for deferred refactors

When the deferred webview splits (#W10 `ProvidersPanel`, #W11 `MetricsPanel`) are eventually
done, re-run **§3** (metrics dashboard) and **§6** (provider config + advanced fields +
keyboard nav) to confirm no behavioral regression, since those components have no automated
runtime coverage.
