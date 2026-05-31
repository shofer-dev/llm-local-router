import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
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
  | 'cost_cumulative'
  | 'requests'
  | 'errors'
  | 'tokens_total'
  | 'tokens_prompt'
  | 'tokens_completion'
  | 'latency_ttfb'
  | 'latency_ttlb'
  | 'cache_hit_ratio';

interface MetricDef {
  key: MetricKey;
  label: string;
  computeTotal: (pts: TimeSeriesPoint[]) => string;
}

const METRICS: MetricDef[] = [
  {
    key: 'cost', label: 'Cost',
    computeTotal: (pts) => `$${pts.reduce((s, d) => s + d.value, 0).toFixed(6)}`,
  },
  {
    key: 'cost_cumulative', label: 'Cost (Cumulative)',
    computeTotal: () => '',
  },
  {
    key: 'requests', label: 'Requests',
    computeTotal: (pts) => String(pts.reduce((s, d) => s + d.value, 0)),
  },
  {
    key: 'errors', label: 'Errors',
    computeTotal: (pts) => String(pts.reduce((s, d) => s + d.value, 0)),
  },
  {
    key: 'tokens_total', label: 'Tokens (Total)',
    computeTotal: (pts) => {
      const n = pts.reduce((s, d) => s + d.value, 0);
      return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    },
  },
  {
    key: 'tokens_prompt', label: 'Tokens (Prompt)',
    computeTotal: (pts) => {
      const n = pts.reduce((s, d) => s + d.value, 0);
      return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    },
  },
  {
    key: 'tokens_completion', label: 'Tokens (Completion)',
    computeTotal: (pts) => {
      const n = pts.reduce((s, d) => s + d.value, 0);
      return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    },
  },
  {
    key: 'latency_ttfb', label: 'Latency (TTFB)',
    computeTotal: (pts) => {
      if (pts.length === 0) return '—';
      return `${Math.round(pts.reduce((s, d) => s + d.value, 0) / pts.length)}ms`;
    },
  },
  {
    key: 'latency_ttlb', label: 'Latency (TTLB)',
    computeTotal: (pts) => {
      if (pts.length === 0) return '—';
      return `${Math.round(pts.reduce((s, d) => s + d.value, 0) / pts.length)}ms`;
    },
  },
  {
    key: 'cache_hit_ratio', label: 'Cache Hit Ratio',
    computeTotal: (pts) => {
      if (pts.length === 0) return '—';
      const avg = pts.reduce((s, d) => s + d.value, 0) / pts.length;
      return `${(avg * 100).toFixed(1)}%`;
    },
  },
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

const ALL_MODEL_KEY_COL = 'ALL';

function formatTick(value: number, metricKey: string): string {
  if (metricKey === 'cost' || metricKey === 'cost_cumulative') return `$${value.toFixed(4)}`;
  if (metricKey === 'cache_hit_ratio') return `${(value * 100).toFixed(0)}%`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function tooltipVal(value: number, metricKey: string): string {
  if (metricKey === 'cost' || metricKey === 'cost_cumulative') return `$${(value as number).toFixed(6)}`;
  if (metricKey === 'cache_hit_ratio') return `${((value as number) * 100).toFixed(1)}%`;
  if (metricKey === 'latency_ttfb' || metricKey === 'latency_ttlb') return `${Math.round(value as number)}ms`;
  return String(Math.round(value as number));
}

// ─── Single-chart sub-component ───────────────────────────────────

function MetricChart({
  metric, points, timeRange, modelsInData, visibleModels, loading,
}: {
  metric: MetricDef;
  points: TimeSeriesPoint[];
  timeRange: number;
  modelsInData: string[];
  visibleModels: string[];
  loading: boolean;
}) {
  const modelColors = new Map(modelsInData.map((m, i) => [m, COLORS[i % COLORS.length]]));
  const allLineKeys = modelsInData.length <= 1 ? modelsInData : [ALL_MODEL_KEY_COL, ...modelsInData];
  const allColors = new Map(allLineKeys.map((k, i) => [k, k === ALL_MODEL_KEY_COL ? '#ffffff' : COLORS[i % COLORS.length]]));
  const visibleKeysVal = visibleModels.length === 0 ? allLineKeys : allLineKeys.filter(k => visibleModels.includes(k));

  const chartData = React.useMemo(() => {
    const windowMap = new Map<string, Record<string, number>>();
    for (const pt of points) {
      if (!windowMap.has(pt.windowStart)) windowMap.set(pt.windowStart, {});
      windowMap.get(pt.windowStart)![pt.modelId] = pt.value;
    }
    const windows = [...windowMap.keys()].sort();

    function aggregate(row: Record<string, number | string>): number {
      const vals = Object.values(row).filter((v): v is number => typeof v === 'number');
      if (vals.length === 0) return 0;
      if (metric.key === 'latency_ttfb' || metric.key === 'latency_ttlb' || metric.key === 'cache_hit_ratio') {
        return vals.reduce((s, v) => s + v, 0) / vals.length;
      }
      return vals.reduce((s, v) => s + v, 0);
    }

    const raw: Array<Record<string, number | string>> = windows.map(w => {
      const vals = windowMap.get(w) ?? {};
      return { windowStart: w, ...vals };
    });

    if (metric.key === 'cost_cumulative') {
      const acc = new Map<string, number>();
      return raw.map(row => {
        const out: Record<string, number | string> = { windowStart: row.windowStart };
        for (const mid of modelsInData) {
          const d = (row[mid] as number | undefined) ?? 0;
          const r = (acc.get(mid) ?? 0) + d;
          acc.set(mid, r);
          out[mid] = r;
        }
        const allR = (acc.get(ALL_MODEL_KEY_COL) ?? 0) + aggregate(row);
        acc.set(ALL_MODEL_KEY_COL, allR);
        out[ALL_MODEL_KEY_COL] = allR;
        return out as Record<string, number | string> & { windowStart: string };
      });
    }

    return raw.map(row => ({
      ...row,
      [ALL_MODEL_KEY_COL]: aggregate(row),
    })) as unknown as Array<Record<string, number | string> & { windowStart: string }>;
  }, [points, metric.key, modelsInData]);

  if (points.length === 0 && !loading) return null;

  const total = metric.key === 'cost_cumulative' ? '' : metric.computeTotal(points);

  return (
    <div id={`metric-${metric.key}`} style={cs.section}>
      <div style={cs.header}>
        <span style={cs.title}>{metric.label}</span>
        {total && <span style={cs.total}>{total}</span>}
        {loading && <span style={cs.loading}>loading...</span>}
      </div>
      {points.length > 0 && (
        <div style={cs.chartWrap}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--vscode-panel-border, rgba(128,128,128,0.12))" strokeDasharray="3 3" />
              <XAxis dataKey="windowStart"
                tick={{ fontSize: 9, fill: 'var(--vscode-descriptionForeground, #999)' }}
                tickFormatter={(iso: string) => {
                  const d = new Date(iso);
                  if (timeRange <= 6) return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                  if (timeRange <= 24) return `${d.getHours().toString().padStart(2, '0')}h`;
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
                interval="preserveStartEnd" minTickGap={30} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--vscode-descriptionForeground, #999)' }}
                tickFormatter={(v: number) => formatTick(v, metric.key)} width={55} />
              <Tooltip contentStyle={{
                backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
                border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
                borderRadius: '4px', fontSize: '10px', fontFamily: 'var(--vscode-font-family)',
              }}
                labelFormatter={(iso: string) => {
                  const d = new Date(iso);
                  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                }}
                formatter={(value: number) => [tooltipVal(value, metric.key), '']} />
              {allLineKeys.map(key => (
                <Line key={key} type="monotone" dataKey={key} name={key}
                  stroke={allColors.get(key)!}
                  strokeWidth={key === ALL_MODEL_KEY_COL ? 2.5 : 1.5}
                  strokeDasharray={key === ALL_MODEL_KEY_COL ? '5 3' : undefined}
                  hide={!visibleKeysVal.includes(key)} dot={false} activeDot={{ r: 3 }}
                  connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {points.length === 0 && (
        <div style={cs.noData}>No data for this metric.</div>
      )}
    </div>
  );
}

// ─── Main panel ────────────────────────────────────────────────────

/**
 * Metrics dashboard showing all metric charts on a single page
 * with anchor-link navigation (Table of Contents style) at the top.
 */
export default function MetricsPanel({ metrics: _metrics }: Props) {
  const [timeRange, setTimeRange] = React.useState(24);
  const [allData, setAllData] = React.useState<Record<string, TimeSeriesPoint[]>>({});
  const [loading, setLoading] = React.useState(false);
  const [visibleModels, setVisibleModels] = React.useState<string[]>([]);
  const [showModelPicker, setShowModelPicker] = React.useState(false);
  const pickerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelPicker]);

  // Fire all metric queries when time range changes
  React.useEffect(() => {
    const since = new Date(Date.now() - timeRange * 3600 * 1000).toISOString();
    const until = new Date().toISOString();
    setLoading(true);

    // Collect responses sequentially via counter
    const keys = METRICS.map(m => m.key);
    const collected: Record<string, TimeSeriesPoint[]> = {};
    let received = 0;

    const unsub = onMessage((msg: any) => {
      if (msg.type === 'metricsQueryResponse') {
        // Match response by order — the host responds in request order
        if (received < keys.length) {
          collected[keys[received]] = msg.data;
          received++;
          if (received === keys.length) {
            setAllData({ ...collected });
            setLoading(false);
          }
        }
      }
    });

    // Fire all queries
    const id = setTimeout(() => {
      for (const m of METRICS) {
        postMessage({ type: 'queryMetrics', metric: m.key, modelIds: [], since, until });
      }
    }, 20);

    return () => { unsub(); clearTimeout(id); };
  }, [timeRange]);

  const allPoints = Object.values(allData).flat();
  const modelsInData = React.useMemo(() => [...new Set(allPoints.map(d => d.modelId))].sort(), [allPoints]);
  const modelColors = new Map(modelsInData.map((m, i) => [m, COLORS[i % COLORS.length]]));
  const allLineKeys = modelsInData.length <= 1 ? modelsInData : [ALL_MODEL_KEY_COL, ...modelsInData];
  const visibleCount = visibleModels.length === 0 ? allLineKeys.length : visibleModels.length;

  const toggleModel = (id: string) => {
    setVisibleModels(prev => {
      if (id === ALL_MODEL_KEY_COL) {
        return prev.includes(ALL_MODEL_KEY_COL) ? prev.filter(m => m !== ALL_MODEL_KEY_COL) : [...prev, ALL_MODEL_KEY_COL];
      }
      const next = prev.length === 0 ? allLineKeys : [...prev];
      if (next.includes(id)) return next.filter(m => m !== id);
      return [...next, id];
    });
  };

  const scrollTo = (key: string) => {
    document.getElementById(`metric-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={styles.container}>
      {/* Controls */}
      <div style={styles.controls}>
        <div style={styles.ctrlGrp}>
          <span style={styles.ctrlLabel}>Time</span>
          <div style={styles.timeBtns}>
            {TIME_RANGES.map(t => (
              <button key={t.hours}
                style={timeRange === t.hours ? styles.timeActive : styles.timeBtn}
                onClick={() => setTimeRange(t.hours)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div style={styles.ctrlGrp}>
          <span style={styles.ctrlLabel}>Lines</span>
          <div style={{ position: 'relative' }} ref={pickerRef}>
            <button style={styles.pickerBtn} onClick={() => setShowModelPicker(!showModelPicker)}>
              {visibleModels.length === 0 ? `All (${allLineKeys.length})` : `${visibleCount} of ${allLineKeys.length}`}
              {showModelPicker ? ' ▴' : ' ▾'}
            </button>
            {showModelPicker && (
              <div style={styles.dropdown}>
                {allLineKeys.map(m => {
                  const vis = visibleModels.length === 0 || visibleModels.includes(m);
                  return (
                    <div key={m} style={{ ...styles.opt, fontWeight: vis ? 600 : 400 }} onClick={() => toggleModel(m)}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6,
                        backgroundColor: modelColors.get(m) ?? '#888', flexShrink: 0, opacity: vis ? 1 : 0.3 }}/>
                      {m}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div style={styles.summary}>
        {loading && <span style={styles.loadingTxt}>Loading metrics...</span>}
        {!loading && (
          <span style={styles.sumItem}>
            Windows: <strong>{Object.values(allData)[0]?.length ?? 0}</strong>
            &nbsp;|&nbsp; Models: <strong>{modelsInData.length}</strong>
          </span>
        )}
      </div>

      {/* ToC */}
      <div style={styles.toc}>
        {METRICS.map(m => {
          const hasData = (allData[m.key]?.length ?? 0) > 0;
          return (
            <button key={m.key}
              style={{ ...styles.tocBtn, opacity: hasData ? 1 : 0.4, fontWeight: hasData ? 600 : 400 }}
              onClick={() => scrollTo(m.key)}>{m.label}</button>
          );
        })}
      </div>

      {/* All charts stacked */}
      <div style={styles.charts}>
        {METRICS.map(m => (
          <MetricChart key={m.key} metric={m}
            points={allData[m.key] ?? []} timeRange={timeRange}
            modelsInData={modelsInData} visibleModels={visibleModels} loading={loading} />
        ))}
      </div>

      {!loading && allPoints.length === 0 && (
        <div style={styles.empty}>
          <p style={styles.emptyIcon}>📊</p>
          <p>No metrics data for the selected time range.</p>
          <p style={styles.emptySub}>Send some requests to populate the dashboard.</p>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '16px', fontFamily: 'var(--vscode-font-family)', fontSize: '12px', color: 'var(--vscode-foreground)', height: '100%', overflowY: 'auto' },
  controls: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px', padding: '8px 12px', border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))', borderRadius: '4px', background: 'var(--vscode-editor-background)', position: 'sticky', top: 0, zIndex: 10 },
  ctrlGrp: { display: 'flex', alignItems: 'center', gap: '8px' },
  ctrlLabel: { fontSize: '11px', fontWeight: 600, color: 'var(--vscode-descriptionForeground, #999)', textTransform: 'uppercase' },
  timeBtns: { display: 'flex', gap: '2px' },
  timeBtn: { padding: '2px 8px', fontSize: '11px', border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))', borderRadius: '3px', background: 'none', color: 'var(--vscode-descriptionForeground, #999)', cursor: 'pointer', fontFamily: 'var(--vscode-font-family)' },
  timeActive: { padding: '2px 8px', fontSize: '11px', border: '1px solid var(--vscode-focusBorder, #007acc)', borderRadius: '3px', background: 'var(--vscode-list-activeSelectionBackground)', color: 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: 600, fontFamily: 'var(--vscode-font-family)' },
  pickerBtn: { padding: '2px 8px', fontSize: '11px', border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))', borderRadius: '3px', background: 'none', color: 'var(--vscode-foreground)', cursor: 'pointer', fontFamily: 'var(--vscode-font-family)' },
  dropdown: { position: 'absolute', top: '100%', left: 0, marginTop: '4px', minWidth: '200px', maxHeight: '300px', overflowY: 'auto', background: 'var(--vscode-dropdown-background)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '3px', zIndex: 100, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' },
  opt: { padding: '4px 10px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center' },
  summary: { display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '4px 0 8px', borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))', marginBottom: '8px' },
  sumItem: { fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)' },
  loadingTxt: { fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', fontStyle: 'italic' },
  toc: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px', position: 'sticky', top: 52, zIndex: 9, padding: '6px 0', background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))' },
  tocBtn: { padding: '3px 10px', fontSize: '11px', border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))', borderRadius: '3px', background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', cursor: 'pointer', fontFamily: 'var(--vscode-font-family)' },
  charts: { display: 'flex', flexDirection: 'column', gap: '16px' },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', color: 'var(--vscode-descriptionForeground)', textAlign: 'center' },
  emptyIcon: { fontSize: '32px', margin: '0 0 8px' },
  emptySub: { fontSize: '11px', margin: '4px 0 0', opacity: 0.7 },
};

const cs: Record<string, React.CSSProperties> = {
  section: { border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))', borderRadius: '4px', background: 'var(--vscode-editor-background)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.1))' },
  title: { fontSize: '12px', fontWeight: 600 },
  total: { fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)' },
  loading: { fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', fontStyle: 'italic' },
  chartWrap: { padding: '4px 2px' },
  noData: { padding: '20px', textAlign: 'center', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)' },
};
