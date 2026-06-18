import React from 'react';

export default function HelpPanel() {
  return (
    <div style={styles.container}>
      <h2 style={styles.title}>🧭 Using Shofer Router</h2>

      <Section title="Getting Started">
        <p>
          Shofer Router is a VS Code extension that connects you to multiple LLM providers
          through a single interface. It implements the VS Code Language Model API, making
          it compatible with any extension or tool that uses <code>vscode.lm</code>.
        </p>
        <ol style={styles.list}>
          <li>Open the <strong>Config → Primary Providers</strong> tab and enter your API keys.</li>
          <li>Your models appear in VS Code's model picker and in the <strong>Status</strong> tab.</li>
          <li>Start chatting — Shofer Router handles provider routing automatically.</li>
        </ol>
      </Section>

      <Section title="Primary Providers">
        <p>
          Configure API keys, custom endpoints, and pricing overrides for each built-in
          provider (OpenAI, Anthropic, Google, DeepSeek, MiniMax, Moonshot, Xiaomi, Zhipu,
          OpenRouter). The green dot indicates a configured provider.
        </p>
        <p>
          <strong>Custom Primary Providers:</strong> Register your own LLM providers via
          the <strong>+ New</strong> button. Each custom provider specifies:
        </p>
        <ul style={styles.list}>
          <li>A unique <strong>Provider ID</strong> and display <strong>Label</strong></li>
          <li>An <strong>API Protocol</strong>: OpenAI-compatible, Anthropic-compatible, or Google-compatible</li>
          <li>An <strong>Endpoint URL</strong> and <strong>API Key</strong></li>
          <li>One or more <strong>Model definitions</strong> (id, name, context length, max output, image/tool/thinking support)</li>
          <li>Default <strong>Pricing</strong> per 1M tokens (prompt, completion, cache read)</li>
        </ul>
        <p>
          Custom provider metadata is stored in your workspace <code>settings.json</code>, while
          API keys are stored securely in VS Code's SecretStorage (OS keychain).
        </p>
      </Section>

      <Section title="Composite Models">
        <p>
          Create <strong>composite models</strong> (e.g. <code>shofer/code</code>) that combine
          multiple underlying models with configurable routing strategies. If one model fails,
          the next one takes over automatically.
        </p>
        <p>
          Go to <strong>Config → Composite Models</strong>, click <strong>+ New</strong>,
          add underlying models, and configure:
        </p>
        <ul style={styles.list}>
          <li><strong>Failover</strong>: Tries models in strict priority order. On failure, falls back to the next.</li>
          <li><strong>Round Robin</strong>: Smooth weighted round-robin (nginx-style). Each model has a configurable weight.</li>
          <li><strong>Lowest Latency</strong>: Always picks the model with the lowest average TTFB, computed over a configurable sliding window (default 10 minutes). When no latency data exists, falls back to equal-weight round-robin.</li>
          <li><strong>Highest Reliability</strong>: Always picks the model with the highest success ratio, computed over a configurable sliding window (default 10 minutes). When no reliability data exists, falls back to equal-weight round-robin.</li>
        </ul>
        <p>
          Each composite model also supports configurable <strong>health checks</strong>
          (degraded/unhealthy thresholds with automatic cooldown-based probing),
          <strong>throttling</strong> (concurrency and rate limits per window), and
          <strong>timeouts</strong> (streaming inactivity, per-attempt, and total budget).
        </p>
        <p>
          <strong>Capability intersection:</strong> Composite models advertised to VS Code
          report the minimum <code>maxInputTokens</code>/<code>maxOutputTokens</code> and
          the boolean AND of <code>imageInput</code>/<code>toolCalling</code>/<code>promptCache</code>
          across all underlying models — a safe lower bound that guarantees failover never
          hits a capability mismatch.
        </p>
      </Section>

      <Section title="Monitoring">
        <p>
          The <strong>Metrics</strong> tab shows all 10 metric charts stacked on a single
          scrollable page: Cost, Cost (Cumulative), Requests, Errors, Tokens (Total/Prompt/Completion),
          Latency (TTFB/TTLB), and Cache Hit Ratio.
        </p>
        <ul style={styles.list}>
          <li>Use the <strong>time range buttons</strong> (1h–30d) to change the view window.</li>
          <li>The <strong>Lines</strong> dropdown categorizes models into <strong>Primary</strong> and <strong>Composite</strong> groups with separate ALL toggles, preventing double-counting.</li>
          <li>Click a <strong>ToC button</strong> at the top to jump directly to a specific chart.</li>
          <li>Each chart shows a <strong>total summary</strong> in its header (total cost, total tokens, average latency, etc.).</li>
        </ul>
        <p>
          The <strong>Status</strong> tab shows connection health, configured providers,
          and available models with search.
        </p>
      </Section>

      <Section title="Status Bar">
        <p>
          The status bar icon (bottom-right corner) shows provider health at a glance:
        </p>
        <ul style={styles.list}>
          <li>🚀 <strong>Rocket</strong>: providers are healthy (e.g. "2/3 providers healthy")</li>
          <li>⚠️ <strong>Warning</strong>: no API keys configured, or connecting</li>
          <li>❌ <strong>Error</strong>: all configured providers are unreachable</li>
        </ul>
        <p>Click the icon to open the full dashboard.</p>
      </Section>

      <Section title="Custom Endpoints">
        <p>
          Each provider's API endpoint URL can be customized in
          <strong>Config → Primary Providers</strong>. This is useful for proxies,
          self-hosted models, AWS Bedrock, or region-specific endpoints.
        </p>
      </Section>

      <Section title="Commands">
        <p>Available commands in the VS Code Command Palette:</p>
        <ul style={styles.list}>
          <li><strong>Shofer Router: Configure</strong> — Open the full configuration dashboard</li>
          <li><strong>Shofer Router: Show Models</strong> — View status and available models</li>
          <li><strong>Shofer Router: Refresh Models</strong> — Reload model list</li>
          <li><strong>Shofer Router: Test Connection</strong> — Test API key configuration</li>
          <li><strong>Shofer Router: Show Metrics</strong> — Open the metrics dashboard</li>
          <li><strong>Shofer Router: Show Model Stats</strong> — Detailed stats for a specific model</li>
          <li><strong>Shofer Router: Export Metrics (Prometheus)</strong> — Export current metrics in Prometheus text format</li>
          <li><strong>Shofer Router: Show Composite Distribution</strong> — Load-balancing distribution for composite models</li>
          <li><strong>Shofer Router: Show Cost History</strong> — Cost breakdown by model across a selected time range</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      <div style={styles.sectionContent}>{children}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px 20px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '13px',
    color: 'var(--vscode-foreground)',
    lineHeight: 1.6,
    maxWidth: '700px',
    overflowY: 'auto',
    height: '100%',
  },
  title: {
    margin: '0 0 16px',
    fontSize: '18px',
    fontWeight: 600,
  },
  section: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 600,
    margin: '0 0 6px',
    color: 'var(--vscode-focusBorder, #007acc)',
  },
  sectionContent: {
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  list: {
    paddingLeft: '20px',
    margin: '4px 0',
  },
};
