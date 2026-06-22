# Shofer Router — TODO

## Provider verification

Test each provider end-to-end (Basic = simple completion, Tools = tool calling,
Thinking = reasoning content, Image = image input):

- OpenRouter — Basic:? Tools: Thinking: Image:
- OpenAI — Basic:Y Tools: Thinking: Image:
- Anthropic — Basic:Y Tools: Thinking: Image:
- Google — Basic:N Tools: Thinking: Image:
- Minimax — Basic:Y Tools: Thinking: Image:
- Moonshot — Basic:N Tools: Thinking: Image:
- Deepseek — Basic:Y Tools:Y Thinking:Y Image:NA
- Xiaomi — Basic:Y Tools: Thinking: Image:
- Zhipu — Basic:Y Tools: Thinking: Image:
- Test with Copilot

## P2

- Port Gemini and other functionality back to llm-router

---

## Remaining from the code review

A three-pass code review fixed all confirmed correctness bugs plus the safe cleanups,
perf wins, provider-layer refactors (shared SSE reader, stub consolidation), webview
bugs/a11y, and type-safety hardening (see `git log` on `master`). The items below were
**deliberately deferred** — each is a larger refactor, a design decision, a back-compat
risk, or low-value polish that's better done as focused, individually-scoped work (ideally
with the extension running) rather than blind. IDs match the original review.

### Webview refactors (large; best done with the extension running — see TODO-testing.md)
- [ ] **#W10** — split `ProvidersPanel.tsx` (~894 lines) into `BuiltInProviderForm` /
  `ModelPricingEditor` / `ProviderList`; hoist inline style objects to module scope.
- [ ] **#W11** — split `MetricsPanel.tsx` (~558 lines): extract a `useMetricsData(timeRange)`
  hook, a `MetricsModelPicker`, and metric definitions/formatters; fix the broken memos
  (`visibleKeysVal`/`allLineKeys`/`allColors` rebuilt each render).
- [ ] **#W13** — dedupe provider-list-item / panel-header markup (part of #W10).
- [ ] **#W14** — centralize per-metric formatting in the `MetricDef` (part of #W11).
- [ ] **#W3** — MetricsPanel query effect re-registers a listener + 20ms timeout per
  `timeRange` change; rework alongside #W11 (single mount-once listener + request-id).

### Metrics perf / durability
- [ ] **#M7** — `getAllModelSummaries` materializes every sample across all windows per
  model; cache per range or aggregate without materializing. Read-time (dashboard refresh),
  so lower priority than the now-fixed per-request path (#M6).
- [ ] **#M1** — up to one window (~5 min) of in-memory raw metrics is lost on a non-graceful
  shutdown (crash). Would need incremental raw-entry persistence; currently a documented
  tradeoff.

### Provider / core
- [ ] **#C7 (partial)** — per-model `throttling` is dropped on a webview round-trip
  (`WebviewCompositeModel.underlyingModels` has no throttling field). Needs a webview type +
  UI to edit it. _(The "weight 0 coerced to 1" half was a **false positive** — intended,
  test-asserted behavior for round_robin.)_
- [ ] **#P17** — `provideTokenCount` uses a `length/4` heuristic and ignores image / thinking /
  tool-result parts; wire a real tokenizer or document it as an estimate.
- [ ] **#P5** — harden Anthropic streaming token accounting (read all `usage` fields on
  `message_delta`, not just gated ones). _(verify — low confidence)_

### Done since the review (this session)
- ✅ **#C16** — composite validation now rejects ambiguous bare model IDs (require `provider/id`).
- ✅ **#C18** — added `metricsWindowMs` (with `latencyWindowMs` back-compat alias).
- ✅ **#W20** — keyboard operability completed across composite/provider rows, metric options, tab bar, icon buttons, inputs.
- ✅ **#M6** — latency percentiles now computed lazily at read/persist, not per request.

### Intentionally not doing
- **#M8** — the Prometheus endpoint has no auth. Left per maintainer decision; it stays
  loopback-only (`127.0.0.1`) and default-off.
- **#C8** — dev-mode webview CSP includes `'unsafe-inline'`. Minimal real risk (CSP3 ignores
  it when a nonce is present, and dev mode is local-only); removing it could break Vite HMR.
