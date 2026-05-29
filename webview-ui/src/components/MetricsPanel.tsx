import React from 'react';
import type { ModelMetrics, CompositeMetrics, MetricsPayload } from '../types';

interface Props {
  metrics: MetricsPayload | null;
}

/**
 * Metrics panel showing per-model cost, latency, availability,
 * token usage, and composite routing distribution.
 *
 * Mirrors the data exposed via the Prometheus /metrics endpoint
 * in a human-readable tabular format.
 */
export default function MetricsPanel({ metrics }: Props) {
  if (!metrics || metrics.modelMetrics.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyIcon}>📊</p>
        <p>No metrics collected yet.</p>
        <p style={styles.emptyHint}>
          Metrics are recorded automatically when LLM requests are made.
          Make some requests and come back.
        </p>
      </div>
    );
  }

  const sorted = [...metrics.modelMetrics].sort(
    (a, b) => b.totalCostUsd - a.totalCostUsd,
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Metrics Dashboard</h2>
        <span style={styles.windowLabel}>
          Window: {new Date(metrics.windowStart).toLocaleTimeString()} –{' '}
          {new Date(metrics.windowEnd).toLocaleTimeString()}
        </span>
      </div>

      {/* Per-model metrics */}
      <h3 style={styles.sectionTitle}>Per-Model Metrics</h3>
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Model</th>
              <th style={styles.th}>Reqs</th>
              <th style={styles.th}>Avail</th>
              <th style={styles.th}>TTFB p50</th>
              <th style={styles.th}>TTLB p50</th>
              <th style={styles.th}>TTLB p90</th>
              <th style={styles.th}>Tokens In</th>
              <th style={styles.th}>Tokens Out</th>
              <th style={styles.th}>Cache</th>
              <th style={styles.th}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.modelId} style={m.isComposite ? styles.compositeRow : undefined}>
                <td style={styles.td}>
                  <span style={styles.modelName}>{m.modelId}</span>
                  <span style={styles.providerTag}>{m.provider}</span>
                  {m.isComposite && <span style={styles.compositeTag}>composite</span>}
                </td>
                <td style={styles.td}>
                  <span style={styles.reqCount}>{m.requestCount}</span>
                  <span style={styles.reqDetail}>
                    {m.successCount}s / {m.errorCount}e / {m.timeoutCount}t
                  </span>
                </td>
                <td style={styles.td}>
                  <AvailabilityBadge value={m.availability} />
                </td>
                <td style={styles.td}>{m.ttfbP50}ms</td>
                <td style={styles.td}>{m.ttlbP50}ms</td>
                <td style={styles.td}>{m.ttlbP90}ms</td>
                <td style={styles.td}>{formatTokens(m.totalPromptTokens)}</td>
                <td style={styles.td}>{formatTokens(m.totalCompletionTokens)}</td>
                <td style={styles.td}>
                  {m.cacheHitRatio > 0
                    ? `${(m.cacheHitRatio * 100).toFixed(0)}%`
                    : '—'}
                </td>
                <td style={styles.td}>
                  <span style={styles.cost}>${m.totalCostUsd.toFixed(4)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Composite distribution */}
      {metrics.compositeMetrics.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>Composite Model Distribution</h3>
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Composite</th>
                  <th style={styles.th}>Underlying Models</th>
                  <th style={styles.th}>Failovers</th>
                  <th style={styles.th}>Mid-Stream Fails</th>
                  <th style={styles.th}>Avg Attempts</th>
                </tr>
              </thead>
              <tbody>
                {metrics.compositeMetrics.map((c) => {
                  const totalReqs = Object.values(c.modelCounts).reduce(
                    (a, b) => a + b,
                    0,
                  );
                  return (
                    <tr key={c.compositeModelId}>
                      <td style={styles.td}>
                        <span style={styles.modelName}>{c.compositeModelId}</span>
                      </td>
                      <td style={styles.td}>
                        <div style={styles.distBars}>
                          {Object.entries(c.modelCounts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([model, count]) => (
                              <div key={model} style={styles.distRow}>
                                <span style={styles.distModel}>{model}</span>
                                <div style={styles.barContainer}>
                                  <div
                                    style={{
                                      ...styles.bar,
                                      width: `${totalReqs > 0 ? (count / totalReqs) * 100 : 0}%`,
                                    }}
                                  />
                                </div>
                                <span style={styles.distCount}>{count}</span>
                              </div>
                            ))}
                        </div>
                      </td>
                      <td style={styles.td}>{c.failoverCount}</td>
                      <td style={styles.td}>{c.midstreamFailureCount}</td>
                      <td style={styles.td}>
                        {totalReqs > 0
                          ? (c.totalAttempts / totalReqs).toFixed(2)
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Error breakdown */}
      <h3 style={styles.sectionTitle}>Error Breakdown</h3>
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Model</th>
              <th style={styles.th}>HTTP 4xx</th>
              <th style={styles.th}>HTTP 5xx</th>
              <th style={styles.th}>HTTP 429</th>
              <th style={styles.th}>Timeout</th>
              <th style={styles.th}>Network</th>
              <th style={styles.th}>Other</th>
            </tr>
          </thead>
          <tbody>
            {sorted
              .filter((m) => m.errorCount + m.timeoutCount > 0)
              .map((m) => (
                <tr key={m.modelId}>
                  <td style={styles.td}>{m.modelId}</td>
                  <td style={styles.td}>{m.errorTypes['http_4xx'] ?? 0}</td>
                  <td style={styles.td}>{m.errorTypes['http_5xx'] ?? 0}</td>
                  <td style={styles.td}>{m.errorTypes['http_429'] ?? 0}</td>
                  <td style={styles.td}>{m.errorTypes['timeout'] ?? 0}</td>
                  <td style={styles.td}>{m.errorTypes['network_error'] ?? 0}</td>
                  <td style={styles.td}>
                    {(m.errorCount + m.timeoutCount) -
                      ((m.errorTypes['http_4xx'] ?? 0) +
                        (m.errorTypes['http_5xx'] ?? 0) +
                        (m.errorTypes['http_429'] ?? 0) +
                        (m.errorTypes['timeout'] ?? 0) +
                        (m.errorTypes['network_error'] ?? 0))}
                  </td>
                </tr>
              ))}
            {sorted.filter((m) => m.errorCount + m.timeoutCount > 0).length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...styles.td, textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
                  No errors recorded in this window
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function AvailabilityBadge({ value }: { value: number }) {
  const pct = (value * 100).toFixed(1);
  const color =
    value >= 0.99 ? 'var(--vscode-testing-iconPassed, #73c991)' :
    value >= 0.95 ? 'var(--vscode-testing-iconQueued, #cca700)' :
    'var(--vscode-testing-iconFailed, #f14c4c)';

  return <span style={{ color, fontWeight: 600 }}>{pct}%</span>;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    maxWidth: '100%',
    overflowX: 'auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '16px',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  windowLabel: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    marginTop: '16px',
    marginBottom: '8px',
  },
  tableWrapper: {
    overflowX: 'auto',
    marginBottom: '4px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '11px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '4px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    color: 'var(--vscode-descriptionForeground)',
  },
  td: {
    padding: '3px 8px',
    borderBottom: '1px solid var(--vscode-panel-border, #333)',
    verticalAlign: 'top' as const,
  },
  compositeRow: {
    backgroundColor: 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.03))',
  },
  modelName: {
    fontWeight: 600,
    display: 'block',
  },
  providerTag: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    marginRight: '4px',
  },
  compositeTag: {
    fontSize: '9px',
    backgroundColor: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    padding: '1px 4px',
    borderRadius: '3px',
  },
  reqCount: {
    fontWeight: 600,
    display: 'block',
  },
  reqDetail: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
  },
  cost: {
    fontWeight: 600,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
  },
  distBars: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  distRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  distModel: {
    minWidth: '140px',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
  },
  barContainer: {
    flex: 1,
    height: '8px',
    backgroundColor: 'var(--vscode-panel-border)',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    backgroundColor: 'var(--vscode-charts-blue, #007acc)',
    borderRadius: '4px',
    transition: 'width 0.3s',
    minWidth: '2px',
  },
  distCount: {
    fontSize: '10px',
    minWidth: '24px',
    textAlign: 'right' as const,
    fontWeight: 600,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  },
  emptyIcon: {
    fontSize: '32px',
    margin: 0,
  },
  emptyHint: {
    fontSize: '11px',
    maxWidth: '300px',
  },
};
