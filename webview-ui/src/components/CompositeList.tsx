import React from 'react';
import type { CompositeModelConfig } from '../types';

interface Props {
  compositeModels: CompositeModelConfig[];
  selectedId: string | null;
  onSelect: (modelId: string) => void;
  onAdd: () => void;
  onDelete: (modelId: string) => void;
}

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
              onClick={() => onSelect(cm.modelId)}
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
                  {cm.strategy === 'failover' ? 'Failover' : 'Round Robin'} · {cm.underlyingModels.length} model{cm.underlyingModels.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button
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
