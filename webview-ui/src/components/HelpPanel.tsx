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

      <Section title="Composite Models">
        <p>
          Create <strong>composite models</strong> (e.g. <code>shofer/code</code>) that combine
          multiple underlying models with failover or round-robin routing. If one model fails,
          the next one takes over automatically.
        </p>
        <p>
          Go to <strong>Config → Composite Models</strong>, click <strong>+ New</strong>,
          add underlying models, and configure strategy, health checks, and timeouts.
        </p>
      </Section>

      <Section title="Monitoring">
        <p>
          The <strong>Metrics</strong> tab shows real-time charts for cost, requests, tokens,
          latency, and cache hit ratio. Use the time range selector and model filter to explore
          your usage patterns.
        </p>
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
          self-hosted models, or region-specific endpoints.
        </p>
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
    margin: '0 0 ' + '6px',
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
