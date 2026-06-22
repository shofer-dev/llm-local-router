import React from 'react';
import type { CompositeModelConfig, RoutingStrategy } from '../types';

interface Props {
  compositeModels: CompositeModelConfig[];
  selectedId: string | null;
  onSelect: (modelId: string) => void;
  onAdd: () => void;
  onDelete: (modelId: string) => void;
}

/** Short subtitle labels for each routing strategy. */
const STRATEGY_SHORT_LABELS: Record<RoutingStrategy, string> = {
  failover: 'Failover',
  round_robin: 'Round Robin',
  lowest_latency: 'Lowest Latency',
  highest_reliability: 'Highest Reliability',
};

/**
 * Left panel: list of composite models with add/delete.
 */
export default function CompositeList({ compositeModels, selectedId, onSelect, onAdd, onDelete }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
          Composite Models
        </span>
        <button className="vscode-button" style={{ padding: '2px 8px', fontSize: '12px' }} onClick={onAdd}>
          + New
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {compositeModels.length === 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--vscode-descriptionForeground, #999)', fontSize: '12px' }}>
            No composite models configured.
            <br />
            Click "+ New" to create one.
          </div>
        )}

        {compositeModels.map((cm) => {
          const isSelected = cm.modelId === selectedId;
          return (
            <div
              key={cm.modelId}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onClick={() => onSelect(cm.modelId)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(cm.modelId); } }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                cursor: 'pointer',
                background: isSelected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
                borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.1))',
              }}
            >
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cm.modelId}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
                  {STRATEGY_SHORT_LABELS[cm.strategy] ?? cm.strategy} · {cm.underlyingModels.length} model{cm.underlyingModels.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button
                aria-label={`Delete composite model ${cm.modelId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(cm.modelId);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--vscode-descriptionForeground, #999)',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  fontSize: '12px',
                  flexShrink: 0,
                  marginLeft: '8px',
                }}
                title="Delete composite model"
              >
                🗑
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
