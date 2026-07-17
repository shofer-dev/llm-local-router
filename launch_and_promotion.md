# LLM Local Router — Launch & Promotion

A single working doc for launching **LLM Local Router** on the VS Code Marketplace. Same shape as
`claude-code/launch_and_promotion.md` in the arkware.ai monorepo: a phased plan (§3–§6) where every
step carries its ready-to-post copy inline, plus a master venue table (§2), positioning (§7) and a
playbook (§8).

The crucial difference from the Claude Code plugin launch: **the audience and distribution are the
VS Code extension ecosystem**, not MCP directories. The canonical install surface is the
**Marketplace** (plus Open VSX for the forks), and the highest-leverage discovery channels are
**Marketplace search, Reddit and HN** — not registries.

**Contents**

1. [What we're launching](#1-what-were-launching)
2. [Master publishing table](#2-master-publishing-table)
3. [Phase 1 — Foundations & assets](#3-phase-1--foundations--assets)
4. [Phase 2 — The core launch](#4-phase-2--the-core-launch)
5. [Phase 3 — Directories & aggregators](#5-phase-3--directories--aggregators)
6. [Phase 4 — Reddit & dev platforms](#6-phase-4--reddit--dev-platforms)
7. [Positioning & competitive landscape](#7-positioning--competitive-landscape)
8. [Launch playbook](#8-launch-playbook)

---

## 1. What we're launching

One **standalone** VS Code extension. It is not a chat UI and not a fork of one — it is a
**Language Model provider**, so it adds models to tools people already use.

| | |
|---|---|
| **Name** | LLM Local Router (`Shoferdev.llm-local-router`) |
| **One-liner** | **Bring your own models to Copilot Chat — with failover and a real cost dashboard. No proxy, no gateway, no account in the middle.** |
| **Stack** | TypeScript · VS Code LM API (`registerLanguageModelChatProvider`) · React/Vite webview |
| **Repo** | [`shofer-dev/llm-local-router`](https://github.com/shofer-dev/llm-local-router) |
| **Marketplace** | [Shoferdev.llm-local-router](https://marketplace.visualstudio.com/items?itemName=Shoferdev.llm-local-router) |
| **Open VSX** | [Shoferdev/llm-local-router](https://open-vsx.org/extension/Shoferdev/llm-local-router) |
| **License** | AGPL-3.0-only |

**The numbers that are true today** (keep these honest — verify before every post):

- **24 built-in providers**, **72 models**, plus user-registered custom providers.
- **4 composite strategies**: failover, weighted round-robin, lowest-latency, highest-reliability.
- **9 metric charts**: cost, requests, errors, 3× tokens, TTFB, TTLB, cache-hit ratio.
- **0 external services.** Requests go editor → provider. Keys live in VS Code SecretStorage.
- Requires **VS Code 1.104+** (where `registerLanguageModelChatProvider` was finalized).

**Install:**

```text
code --install-extension Shoferdev.llm-local-router
```

---

## 2. Master publishing table

| # | Venue | Type | Effort | Why it matters | Status |
|---|-------|------|--------|----------------|--------|
| 1 | VS Code Marketplace listing | Canonical | — | The install surface. README **is** the landing page. | ✅ published |
| 2 | Open VSX | Canonical | — | VSCodium / Cursor / Windsurf / Gitpod users. | ✅ published |
| 3 | LinkedIn | Social | Low | Highest-signal channel for this author. Post first. | ⬜ |
| 4 | Show HN | Launch | Med | The "no middleman" thesis is HN-shaped. | ⬜ |
| 5 | X / Twitter thread | Social | Low | Screenshots carry it. | ⬜ |
| 6 | r/vscode | Reddit | Low | Directly the audience. Read the rules — no pure self-promo. | ⬜ |
| 7 | r/LocalLLaMA | Reddit | Low | Ollama/LM Studio failover angle lands here. | ⬜ |
| 8 | r/ChatGPTCoding | Reddit | Low | Copilot-adjacent tooling crowd. | ⬜ |
| 9 | dev.to / Hashnode | Blog | Med | Long-tail SEO for "use Claude/DeepSeek in Copilot Chat". | ⬜ |
| 10 | VS Code extension newsletters/roundups | Aggregator | Low | Cheap fan-out once the listing is polished. | ⬜ |

---

## 3. Phase 1 — Foundations & assets

### Step 1: The listing is the product — ✅ DONE

The Marketplace renders the README. It has: the one-liner, three screenshots (Status, Config,
Metrics), a **Works with** table (Copilot Chat / any `vscode.lm` extension / your own code), install,
and the composite-model JSON. Screenshots are served from the repo — vsce rewrites relative links to
`raw/HEAD` URLs, so they must stay committed.

### Step 2: Roadmap — ✅ DONE

[`ROADMAP.md`](ROADMAP.md) exists and is honest, including a **Not doing** section (no chat UI, no
hosted gateway, no telemetry, keys never exported by default). A public "not doing" list is a
credibility signal and pre-empts the top HN questions.

### Step 3: A 20-second demo — ⬜ TODO

The single most shareable moment: **a composite failing over live**. Key two providers, define
`local/code` with `strategy: failover`, revoke/blackhole the first, ask Copilot Chat a question,
show it answer anyway — then the Metrics tab showing the failover and the cost. That clip is the
whole pitch in one loop. GIF, not video (autoplays inline everywhere).

---

## 4. Phase 2 — The core launch

### Step 4: LinkedIn — ⬜ READY TO POST

Lead with the problem, not the feature list. Copy-paste:

---

I kept hitting the same wall in VS Code: Copilot Chat is excellent, but I'm stuck with the models it
offers. Meanwhile I have keys for DeepSeek, Claude, Gemini, GLM and a local Ollama — and no way to
use them in the tool I actually live in.

The usual answer is to route everything through a hosted gateway. That means my traffic and my keys
go through someone else's service, and I pay a margin on every token. For a fix to a plumbing
problem, that's a lot to give up.

So I built LLM Local Router — a VS Code extension that registers as a Language Model provider.

→ 24 providers, 72 models, plus any OpenAI/Anthropic/Google-compatible endpoint you add yourself.
→ They appear in Copilot Chat — and in any extension using the vscode.lm API. It's a provider, not
   another chat window.
→ Composite models: declare local/code as "DeepSeek, fall back to Claude, then GPT" and it fails
   over in-process, before the first byte. Also weighted round-robin, lowest-latency, and
   highest-reliability routing.
→ A real cost dashboard: cost, tokens, errors, TTFB/TTLB latency, cache-hit ratio, per model.
→ No proxy. No gateway. No account in the middle. Requests go straight from your editor to the
   provider, and your keys stay in VS Code's SecretStorage.

The part I find most useful day to day isn't the failover — it's finally *seeing* the cost per model
while I work.

Free and open source (AGPL-3.0). Install: code --install-extension Shoferdev.llm-local-router

Marketplace: https://marketplace.visualstudio.com/items?itemName=Shoferdev.llm-local-router
Source: https://github.com/shofer-dev/llm-local-router

What would you route where?

---

> **Attach:** the Metrics screenshot (the cost chart is the hook — it's the least-expected thing in a
> "model router" post). LinkedIn crops to ~1.91:1; check the crop before posting.
> **Do not** put the link in the first comment — this is a technical audience, the link in-body is fine.

### Step 5: Show HN — ⬜ READY TO POST

**Title:** `Show HN: Use any LLM provider in Copilot Chat, with failover, from inside VS Code`

**Body:**

---

Copilot Chat only offers Copilot's models. If you want DeepSeek or your own Ollama in there, the
usual route is a hosted gateway — which puts a third party between your editor and the provider, and
takes a cut.

VS Code finalized `registerLanguageModelChatProvider` in 1.104, which means an extension can publish
models into Copilot Chat directly. This is that: 24 providers and 72 models, plus any
OpenAI/Anthropic/Google-compatible endpoint you register yourself, exposed under the vendor `local`
so any extension calling `vscode.lm` can use them too.

The routing lives in the extension host — no service, no port, no container. You can declare
composite models (`local/code` = DeepSeek → Claude → GPT) with failover, weighted round-robin,
lowest-latency or highest-reliability strategies, plus per-model health tracking and throttling.
Failover is pre-first-byte only; a mid-stream failure is recorded but never re-routed, because
silently restarting a half-streamed answer is worse than failing.

It also tracks cost/latency/errors per model with a dashboard and an optional Prometheus endpoint
(loopback-only, off by default).

Keys are in VS Code SecretStorage and never leave except to the provider you chose. Config export
deliberately reports *which* providers are keyed, never the values.

AGPL-3.0. Source: https://github.com/shofer-dev/llm-local-router

---

> **Timing:** Tue–Thu, 08:00–10:00 ET. **Be present for the first 2 hours** — HN judges the author's
> replies as much as the post.
> **Expect these three questions; answer honestly:**
> 1. *"Why not LiteLLM/OpenRouter?"* → Both are good. They're a service you run or a service you pay.
>    This is neither: it's in-process in the editor. If you already run LiteLLM, register it as a
>    custom OpenAI-compatible provider and use this for the failover + cost view.
> 2. *"Why AGPL?"* → Answer plainly; don't get defensive.
> 3. *"Does it work outside Copilot?"* → Yes — any `vscode.lm` consumer. That's the whole design.

### Step 6: X / Twitter thread — ⬜ READY TO POST

1/ Copilot Chat is great. Being stuck with Copilot's models isn't.

VS Code 1.104 finalized the LM provider API — so I shipped an extension that puts *any* provider's
models into Copilot Chat. 24 providers, 72 models. No gateway. 🧵

2/ It's a provider, not another chat window. Your models show up in Copilot Chat and in any
extension calling vscode.lm. Nothing to switch to. [Status screenshot]

3/ Composite models. Declare `local/code` = DeepSeek → Claude → GPT and it fails over in-process,
before the first byte. Also weighted round-robin / lowest-latency / highest-reliability. [Config
screenshot]

4/ And it tells you what you spent. Cost, tokens, errors, TTFB/TTLB, cache-hit ratio — per model.
This is the part I use most. [Metrics screenshot]

5/ No proxy, no service, no account in the middle. Editor → provider, with your keys in VS Code
SecretStorage.

Free, AGPL-3.0:
code --install-extension Shoferdev.llm-local-router
https://marketplace.visualstudio.com/items?itemName=Shoferdev.llm-local-router

---

## 5. Phase 3 — Directories & aggregators

The Marketplace **is** the directory here — there's no MCP-registry equivalent, so this phase is
thin by design. What's worth doing:

- **Marketplace metadata hygiene.** `categories` (AI, Chat) and `keywords` decide search hits. We
  currently carry `local, router, llm, composite, failover, ai, coding, mcp, deepseek, openai`.
  Consider adding `copilot`, `anthropic`, `gemini`, `ollama` — people search by the model they own.
- **Open VSX** is already published; it's the only real second surface.
- **VS Code extension roundups / newsletters** — cheap fan-out once the listing is polished.
- **awesome-vscode**-style lists — PR into the AI section.

---

## 6. Phase 4 — Reddit & dev platforms

**Read each subreddit's self-promo rules first.** The pattern that works: lead with the problem and
the technical detail, link at the bottom, and be in the comments.

- **r/vscode** — *"I got DeepSeek/Claude/Ollama models into Copilot Chat via the LM provider API"*.
  Lead with the 1.104 API, not the extension. The API detail is the interesting part to this crowd.
- **r/LocalLLaMA** — angle: **your local model as a failover target for a cloud model**, or the
  reverse. Ollama and LM Studio are built in. This crowd cares about not sending traffic through a
  middleman — lead there.
- **r/ChatGPTCoding** — the cost dashboard is the hook; that crowd is price-sensitive.

**dev.to / Hashnode long-form** — *"Using any LLM in Copilot Chat: VS Code's Language Model provider
API"*. Half tutorial (how the API works, how to register a provider), half product. This is the
long-tail SEO play; it should still be useful to someone who never installs the extension.

---

## 7. Positioning & competitive landscape

**Frame it as "extend the tool you use," not "switch to my tool."** It's a provider — it composes
with Copilot Chat, with agent extensions, with your own code. Same no-lock-in thesis as the rest of
the family, applied to the model layer.

- **vs. OpenRouter (and hosted gateways)** — those are a *service*: your traffic and keys pass
  through a third party, and there's a margin on every token. This is in-process in the editor,
  direct to each provider, with your keys. (Not either/or: OpenRouter is also one of the 24 built-in
  providers — use it *through* this when you want its breadth.)
- **vs. LiteLLM / a self-hosted proxy** — a process to deploy, port to manage, container to update.
  This has none. If you already run LiteLLM, register it as a custom OpenAI-compatible provider and
  use this for failover + cost.
- **vs. Copilot's own model picker** — Copilot gives you Copilot's curated models. This adds
  everything you have a key for *into the same picker*.
- **vs. Continue / Cline / Roo / Shofer** — those are chat UIs and agents. This isn't. It's the
  provider underneath — and it works with any of them that speak `vscode.lm`, which is precisely why
  it isn't tied to any one of them.
- **The honest gap:** it needs VS Code **1.104+**, and it isn't on the Marketplace's Copilot-model
  onboarding path — users must know to install a provider extension. That's a discovery problem, not
  a technical one, and it's what the launch is for.

**One-line positioning:** *Copilot Chat, with your models and your keys — and a bill you can actually
see.*

---

## 8. Launch playbook

What travels in this ecosystem (distinct from the Claude Code / MCP playbook):

- **Screenshots > prose.** A VS Code extension is judged on its listing images in about four
  seconds. The Metrics chart is the strongest asset because it's the least expected — every router
  claims routing; almost none show you the bill.
- **The API detail is the hook for developers.** "VS Code finalized the LM provider API in 1.104" is
  more interesting to r/vscode and HN than any feature list. Lead with the capability, land the
  extension.
- **"No middleman" is the thesis.** Every competitor in this space is a service. Being *not a
  service* is the differentiator — say it in the first two sentences, everywhere.
- **Cost is the sleeper feature.** People arrive for multi-provider access and stay for the cost
  dashboard. Watch which one the comments latch onto, and re-order the pitch accordingly.
- **Numbers must be true.** 24 providers / 72 models / 4 strategies / 9 charts — re-verify before
  each post (`PROVIDER_DEFAULTS` in `router-config-provider.ts`, the registry in
  `model-registry.ts`). A wrong number in a Show HN comment is the whole thread.
- **Don't oversell failover.** It's pre-first-byte only, by design. Say so before someone finds out;
  the reasoning (never silently restart a half-streamed answer) is a *good* answer and earns trust.

---

> **Status:** published to Marketplace + Open VSX; listing has screenshots and a roadmap. Next
> concrete action: Step 3 (the failover GIF) → Step 4 (LinkedIn) → Step 5 (Show HN).
