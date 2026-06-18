import React from 'react';

interface Props {
  /** Extension version, supplied by the host via initConfig. */
  version?: string;
}

export default function AboutPanel({ version }: Props) {
  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Shofer Router</h2>
      <p style={styles.version}>Version {version || 'unknown'}</p>

      <div style={styles.section}>
        <p>
          A VS Code extension providing direct access to multiple LLM providers
          with composite model failover — self-contained, no external router service required.
        </p>
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Supported Providers</h3>
        <div style={styles.grid}>
          {[
            'OpenAI (GPT-5.x)',
            'Anthropic (Claude)',
            'Google Gemini',
            'DeepSeek',
            'MiniMax',
            'Moonshot / Kimi',
            'Xiaomi MiMo',
            'Zhipu GLM',
            'OpenRouter',
          ].map(p => (
            <span key={p} style={styles.tag}>{p}</span>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Links</h3>
        <p>
          <a
            href="https://shofer.dev/router"
            target="_blank"
            rel="noreferrer"
            style={styles.link}
          >
            🌐 Website — shofer.dev/router
          </a>
        </p>
        <p>
          <a
            href="https://github.com/shofer-dev/shofer-router"
            target="_blank"
            rel="noreferrer"
            style={styles.link}
          >
            📦 Source Code — github.com/shofer-dev/shofer-router
          </a>
        </p>
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>License</h3>
        <p>
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.en.html"
            target="_blank"
            rel="noreferrer"
            style={styles.link}
          >
            GNU Affero General Public License v3.0
          </a>
        </p>
      </div>

      <div style={styles.footer}>
        <p>Shofer Router &copy; {new Date().getFullYear()} Shofer.dev</p>
      </div>
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
    maxWidth: '600px',
    overflowY: 'auto',
    height: '100%',
  },
  title: {
    margin: '0 0 2px',
    fontSize: '20px',
    fontWeight: 600,
  },
  version: {
    margin: '0 0 16px',
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  section: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    margin: '0 0 ' + '6px',
    color: 'var(--vscode-descriptionForeground, #999)',
    textTransform: 'uppercase',
  },
  grid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  tag: {
    padding: '2px 8px',
    fontSize: '11px',
    background: 'var(--vscode-badge-background, rgba(128,128,128,0.2))',
    color: 'var(--vscode-badge-foreground, #ccc)',
    borderRadius: '3px',
  },
  link: {
    color: 'var(--vscode-textLink-foreground, #3794ff)',
    textDecoration: 'none',
  },
  footer: {
    marginTop: '24px',
    paddingTop: '12px',
    borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
};
