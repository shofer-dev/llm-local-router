import React from 'react';
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

type MetricKey = 'cost' | 'requests' | 'errors' | 'tokens_total' | 'tokens_prompt' | 'tokens_completion' | 'latency_ttfb' | 'latency_ttlb' | 'cache_hit_ratio';

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

const COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1', '#fff176', '#f06292', '#a1887f', '#90a4ae'];

export default function MetricsPanel({ metrics }: Props) {
  const [timeRange, setTimeRange] = React.useState(24);
  const [metricKey, setMetricKey] = React.useState<MetricKey>('cost');
  const [selectedModels, setSelectedModels] = React.useState<string[]>([]);
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);
  const [data, setData] = React.useState<TimeSeriesPoint[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [showModelPicker, setShowModelPicker] = React.useState(false);

  const metric = METRICS.find(m => m.key === metricKey)!;

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

  // Group data by window
  const windows = [...new Set(data.map(d => d.windowStart))].sort();
  const modelsInData = [...new Set(data.map(d => d.modelId))];
  const modelColors = new Map(modelsInData.map((m, i) => [m, COLORS[i % COLORS.length]]));

  // Compute chart dimensions
  const chartW = 700;
  const chartH = 300;
  const pad = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = chartW - pad.left - pad.right;
  const plotH = chartH - pad.top - pad.bottom;

  const maxVal = Math.max(1, ...data.map(d => d.value));
  const yScale = (v: number) => pad.top + plotH * (1 - v / maxVal);
  const xScale = (i: number) => pad.left + (plotW / Math.max(1, windows.length - 1)) * i;

  // Per-model polylines
  const polylines = modelsInData.map(modelId => {
    const points = windows.map((w, i) => {
      const pt = data.find(d => d.windowStart === w && d.modelId === modelId);
      return `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(pt?.value ?? 0).toFixed(1)}`;
    });
    const color = modelColors.get(modelId)!;
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  });

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (maxVal / yTicks) * i;
    const y = yScale(v);
    return `<text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--vscode-descriptionForeground, #999)">${metricKey === 'cost' ? '$' + v.toFixed(4) : metricKey === 'cache_hit_ratio' ? (v * 100).toFixed(0) + '%' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v))}</text>`;
  });

  const xLabels = windows.length > 1 ? windows.map((w, i) => {
    const d = new Date(w);
    const label = timeRange <= 6
      ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      : timeRange <= 24
        ? `${d.getHours().toString().padStart(2, '0')}h`
        : `${d.getMonth() + 1}/${d.getDate()}`;
    return `<text x="${xScale(i)}" y="${chartH - 4}" text-anchor="middle" font-size="9" fill="var(--vscode-descriptionForeground, #999)">${label}</text>`;
  }) : [];

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
              Windows: <strong>{windows.length}</strong>
            </span>
            <span style={styles.summaryItem}>
              Models: <strong>{modelsInData.length}</strong>
            </span>
            {metricKey === 'cost' && (
              <span style={styles.summaryItem}>
                Total: <strong>${data.reduce((s, d) => s + d.value, 0).toFixed(6)}</strong>
              </span>
            )}
            {metricKey === 'requests' && (
              <span style={styles.summaryItem}>
                Total: <strong>{data.reduce((s, d) => s + d.value, 0)}</strong>
              </span>
            )}
          </>
        )}
      </div>

      {/* Chart */}
      {data.length > 0 && (
        <div style={styles.chartContainer}>
          {/* Legend */}
          {modelsInData.length > 1 && (
            <div style={styles.legend}>
              {modelsInData.map(m => (
                <div key={m} style={styles.legendItem}>
                  <span style={{ ...styles.legendSwatch, backgroundColor: modelColors.get(m) }}/>
                  <span style={styles.legendLabel}>{m}</span>
                </div>
              ))}
            </div>
          )}

          <svg viewBox={`0 0 ${chartW} ${chartH}`} style={styles.svg}>
            {/* Grid lines */}
            {Array.from({ length: yTicks + 1 }, (_, i) => {
              const y = yScale((maxVal / yTicks) * i);
              return <line key={i} x1={pad.left} y1={y} x2={chartW - pad.right} y2={y} stroke="var(--vscode-panel-border, rgba(128,128,128,0.15))" strokeWidth="1"/>;
            })}

            {/* Y axis labels */}
            {yLabels.map((l, i) => <g key={`yl-${i}`} dangerouslySetInnerHTML={{ __html: l }}/>)}

            {/* X axis labels */}
            {xLabels.map((l, i) => <g key={`xl-${i}`} dangerouslySetInnerHTML={{ __html: l }}/>)}

            {/* Data lines */}
            {polylines.map((p, i) => <g key={`line-${i}`} dangerouslySetInnerHTML={{ __html: p }}/>)}
          </svg>
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
  },
  legend: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
    marginBottom: '8px',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  legendSwatch: {
    width: '12px',
    height: '12px',
    borderRadius: '2px',
    flexShrink: 0,
  },
  legendLabel: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  svg: {
    width: '100%',
    height: 'auto',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))',
    borderRadius: '4px',
    background: 'var(--vscode-editor-background)',
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
