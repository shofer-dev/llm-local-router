import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { MetricsPayload } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

interface Props {
  metrics: MetricsPayload | null;
}

interface TimeSeriesPoint {
  windowStart: string;
  modelId: string;
  value: number;
}

type MetricKey =
  | 'cost'
  | 'requests'
  | 'errors'
  | 'tokens_total'
  | 'tokens_prompt'
  | 'tokens_completion'
  | 'latency_ttfb'
  | 'latency_ttlb'
  | 'cache_hit_ratio';

const METRICS: Array<{ key: MetricKey; label: string; unit: string }> = [
  { key: 'cost', label: 'Cost', unit: '$' },
  { key: 'requests', label: 'Requests', unit: '' },
  { key: 'errors', label: 'Errors', unit: '' },
  { key: 'tokens_total', label: 'Tokens (Total)', unit: '' },
  { key: 'tokens_prompt', label: 'Tokens (Prompt)', unit: '' },
  { key: 'tokens_completion', label: 'Tokens (Completion)', unit: '' },
  { key: 'latency_ttfb', label: 'Latency (TTFB)', unit: 'ms' },
  { key: 'latency_ttlb', label: 'Latency (TTLB)', unit: 'ms' },
  { key: 'cache_hit_ratio', label: 'Cache Hit Ratio', unit: '%' },
];

const TIME_RANGES: Array<{ label: string; hours: number }> = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

const COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4dd0e1', '#fff176', '#f06292', '#a1887f', '#90a4ae',
];

/**
 * Format a tick value based on the metric type.
 */
function formatTick(value: number, metricKey: MetricKey): string {
  if (metricKey === 'cost') return `$${value.toFixed(4)}`;
  if (metricKey === 'cache_hit_ratio') return `${(value * 100).toFixed(0)}%`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Metrics dashboard panel with time-series line charts rendered via Recharts.
 *
 * Replaces the previous hand-rolled SVG approach (which used dangerouslySetInnerHTML
 * to inject raw `<polyline points="M x y L x y..."/>` markup — React does not
 * reconcile innerHTML inside SVG elements, so the lines never rendered).
 */
export default function MetricsPanel({ metrics: _metrics }: Props) {
  const [timeRange, setTimeRange] = React.useState(24);
  const [metricKey, setMetricKey] = React.useState<MetricKey>('cost');
  const [selectedModels, setSelectedModels] = React.useState<string[]>([]);
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);
  const [data, setData] = React.useState<TimeSeriesPoint[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [showModelPicker, setShowModelPicker] = React.useState(false);

  // Fetch data when params change
  React.useEffect(() => {
    const since = new Date(Date.now() - timeRange * 3600 * 1000).toISOString();
    const until = new Date().toISOString();
    setLoading(true);
    postMessage({ type: 'queryMetrics', metric: metricKey, modelIds: selectedModels, since, until });
  }, [metricKey, selectedModels, timeRange]);

  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      if (msg.type === 'metricsQueryResponse') {
        setData(msg.data);
        setAvailableModels(msg.models);
        setLoading(false);
      }
    });
    return unsub;
  }, []);

  const toggleModel = (id: string) => {
    setSelectedModels(prev =>
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  };

  // Pivot flat TimeSeriesPoint[] into [{ windowStart, modelA, modelB, ... }]
  const modelsInData = [...new Set(data.map(d => d.modelId))];
  const modelColors = new Map(modelsInData.map((m, i) => [m, COLORS[i % COLORS.length]]));

  const chartData = React.useMemo(() => {
    const windowMap = new Map<string, Record<string, number>>();
    for (const pt of data) {
      if (!windowMap.has(pt.windowStart)) {
        windowMap.set(pt.windowStart, {});
      }
      windowMap.get(pt.windowStart)![pt.modelId] = pt.value;
    }
    const windows = [...windowMap.keys()].sort();
    return windows.map(w => ({
      windowStart: w,
      ...windowMap.get(w),
    }));
  }, [data]);

  // Compute summary values
  const totalValue = data.reduce((s, d) => s + d.value, 0);

  return (
    <div style={styles.container}>
      {/* Controls bar */}
      <div style={styles.controls}>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Metric</span>
          <select
            style={styles.select}
            value={metricKey}
            onChange={e => setMetricKey(e.target.value as MetricKey)}
          >
            {METRICS.map(m => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>

        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Time</span>
          <div style={styles.timeButtons}>
            {TIME_RANGES.map(t => (
              <button
                key={t.hours}
                style={timeRange === t.hours ? styles.timeBtnActive : styles.timeBtn}
                onClick={() => setTimeRange(t.hours)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Models</span>
          <div style={{ position: 'relative' }}>
            <button
              style={styles.modelPickerBtn}
              onClick={() => setShowModelPicker(!showModelPicker)}
            >
              {selectedModels.length === 0
                ? 'All models'
                : `${selectedModels.length} selected`}
              {' ▾'}
            </button>
            {showModelPicker && (
              <div style={styles.modelDropdown}>
                <div
                  style={{ ...styles.modelOption, fontWeight: selectedModels.length === 0 ? 600 : 400 }}
                  onClick={() => { setSelectedModels([]); setShowModelPicker(false); }}
                >
                  All models
                </div>
                {availableModels.map(m => (
                  <div
                    key={m}
                    style={{
                      ...styles.modelOption,
                      fontWeight: selectedModels.includes(m) ? 600 : 400,
                    }}
                    onClick={() => toggleModel(m)}
                  >
                    <span style={{
                      display: 'inline-block', width: '10px', height: '10px',
                      borderRadius: '2px', marginRight: '6px',
                      backgroundColor: modelColors.get(m) ?? '#888',
                      flexShrink: 0,
                    }}/>
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary bar */}
      <div style={styles.summary}>
        {loading && <span style={styles.loadingText}>Loading...</span>}
        {!loading && (
          <>
            <span style={styles.summaryItem}>
              Windows: <strong>{chartData.length}</strong>
            </span>
            <span style={styles.summaryItem}>
              Models: <strong>{modelsInData.length}</strong>
            </span>
            {metricKey === 'cost' && (
              <span style={styles.summaryItem}>
                Total: <strong>${totalValue.toFixed(6)}</strong>
              </span>
            )}
            {metricKey === 'requests' && (
              <span style={styles.summaryItem}>
                Total: <strong>{totalValue}</strong>
              </span>
            )}
          </>
        )}
      </div>

      {/* Chart */}
      {data.length > 0 && (
        <div style={styles.chartContainer}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            >
              <CartesianGrid
                stroke="var(--vscode-panel-border, rgba(128,128,128,0.15))"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="windowStart"
                tick={{
                  fontSize: 10,
                  fill: 'var(--vscode-descriptionForeground, #999)',
                }}
                tickFormatter={(iso: string) => {
                  const d = new Date(iso);
                  if (timeRange <= 6) {
                    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                  }
                  if (timeRange <= 24) {
                    return `${d.getHours().toString().padStart(2, '0')}h`;
                  }
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{
                  fontSize: 10,
                  fill: 'var(--vscode-descriptionForeground, #999)',
                }}
                tickFormatter={(v: number) => formatTick(v, metricKey)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
                  border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'var(--vscode-font-family)',
                }}
                labelFormatter={(iso: string) => {
                  const d = new Date(iso);
                  return d.toLocaleString(undefined, {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  });
                }}
                formatter={(value: number, _name: string) => {
                  if (metricKey === 'cost') return [`$${(value as number).toFixed(6)}`, ''];
                  if (metricKey === 'cache_hit_ratio') return [`${((value as number) * 100).toFixed(1)}%`, ''];
                  if (metricKey === 'latency_ttfb' || metricKey === 'latency_ttlb') return [`${Math.round(value as number)}ms`, ''];
                  return [String(Math.round(value as number)), ''];
                }}
              />
              {modelsInData.length > 1 && (
                <Legend
                  wrapperStyle={{
                    fontSize: '10px',
                    fontFamily: 'var(--vscode-font-family)',
                  }}
                />
              )}
              {modelsInData.map(modelId => (
                <Line
                  key={modelId}
                  type="monotone"
                  dataKey={modelId}
                  name={modelId}
                  stroke={modelColors.get(modelId)!}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!loading && data.length === 0 && (
        <div style={styles.empty}>
          <p style={styles.emptyIcon}>📊</p>
          <p>No metrics data for the selected time range.</p>
          <p style={styles.emptySub}>Send some requests to populate the dashboard.</p>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    height: '100%',
    overflowY: 'auto',
  },
  controls: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: '12px',
    padding: '8px 12px',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
    borderRadius: '4px',
    background: 'var(--vscode-editor-background)',
  },
  controlGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  controlLabel: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--vscode-descriptionForeground, #999)',
    textTransform: 'uppercase',
  },
  select: {
    padding: '3px 6px',
    fontSize: '12px',
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
  },
  timeButtons: {
    display: 'flex',
    gap: '2px',
  },
  timeBtn: {
    padding: '2px 8px',
    fontSize: '11px',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
    borderRadius: '3px',
    background: 'none',
    color: 'var(--vscode-descriptionForeground, #999)',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
  },
  timeBtnActive: {
    padding: '2px 8px',
    fontSize: '11px',
    border: '1px solid var(--vscode-focusBorder, #007acc)',
    borderRadius: '3px',
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontWeight: 600,
    fontFamily: 'var(--vscode-font-family)',
  },
  modelPickerBtn: {
    padding: '2px 8px',
    fontSize: '11px',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
    borderRadius: '3px',
    background: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
  },
  modelDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: '4px',
    minWidth: '200px',
    maxHeight: '300px',
    overflowY: 'auto',
    background: 'var(--vscode-dropdown-background)',
    border: '1px solid var(--vscode-dropdown-border)',
    borderRadius: '3px',
    zIndex: 100,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  modelOption: {
    padding: '4px 10px',
    fontSize: '11px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  summary: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap',
    padding: '6px 0',
    marginBottom: '8px',
    borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))',
  },
  summaryItem: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  loadingText: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #999)',
    fontStyle: 'italic',
  },
  chartContainer: {
    marginTop: '8px',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))',
    borderRadius: '4px',
    background: 'var(--vscode-editor-background)',
    padding: '8px 4px 4px 4px',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 0',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: '32px',
    margin: '0 0 8px',
  },
  emptySub: {
    fontSize: '11px',
    margin: '4px 0 0',
    opacity: 0.7,
  },
};
