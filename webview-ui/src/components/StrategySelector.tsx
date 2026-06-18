import React from 'react';
import type { RoutingStrategy } from '../types';

interface Props {
  value: RoutingStrategy;
  onChange: (value: RoutingStrategy) => void;
  disabled?: boolean;
}

const STRATEGY_LABELS: Record<RoutingStrategy, string> = {
  failover: 'Failover (strict priority order)',
  round_robin: 'Round Robin (weighted distribution)',
  lowest_latency: 'Lowest Latency (fastest model wins)',
  highest_reliability: 'Highest Reliability (most successful model wins)',
};

/**
 * Dropdown selector for the routing strategy of a composite model.
 */
export default function StrategySelector({ value, onChange, disabled }: Props) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
        Routing Strategy
      </label>
      <select
        className="vscode-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as RoutingStrategy)}
        style={{ width: '100%' }}
      >
        {(['failover', 'round_robin', 'lowest_latency', 'highest_reliability'] as RoutingStrategy[]).map((s) => (
          <option key={s} value={s}>
            {STRATEGY_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}
