import React from 'react';
import CompositeList from './CompositeList';
import CompositeEditor from './CompositeEditor';
import CapabilityPreview from './CapabilityPreview';
import type { CompositeModelConfig, ModelRegistrySummary } from '../types';
import { getVsCodeApi, onMessage } from '../utils/vscode';

interface Props {
  initialModels: CompositeModelConfig[];
  modelRegistry: ModelRegistrySummary[];
}

function generateModelId(): string {
  return `shofer/composite-${Date.now()}`;
}

function createDefaultComposite(modelId: string): CompositeModelConfig {
  return {
    modelId,
    strategy: 'failover',
    streamingTimeoutMs: 30000,
    nonStreamingTimeoutMs: 120000,
    totalTimeoutMs: 300000,
    underlyingModels: [],
  };
}

/**
 * Main layout: left panel (composite list), right panel (editor with Save at top).
 */
export default function ConfigEditor({ initialModels, modelRegistry }: Props) {
  const [compositeModels, setCompositeModels] = React.useState<CompositeModelConfig[]>(initialModels);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialModels.length > 0 ? initialModels[0].modelId : null,
  );
  const [saving, setSaving] = React.useState(false);

  const vscode = getVsCodeApi();

  const selectedModel = compositeModels.find((m) => m.modelId === selectedId) ?? null;

  const handleSelect = (modelId: string) => {
    setSelectedId(modelId);
  };

  const handleAdd = () => {
    const id = generateModelId();
    const newModel = createDefaultComposite(id);
    setCompositeModels([...compositeModels, newModel]);
    setSelectedId(id);
  };

  const handleDelete = (modelId: string) => {
    const filtered = compositeModels.filter((m) => m.modelId !== modelId);
    setCompositeModels(filtered);
    if (selectedId === modelId) {
      setSelectedId(filtered.length > 0 ? filtered[0].modelId : null);
    }
  };

  const handleUpdateSelected = (updated: CompositeModelConfig) => {
    setCompositeModels(compositeModels.map((m) => (m.modelId === selectedId ? updated : m)));
    if (updated.modelId !== selectedId) {
      setSelectedId(updated.modelId);
    }
  };

  const handleSave = () => {
    setSaving(true);
    vscode.postMessage({ type: 'saveConfig', compositeModels });
  };

  // Handle save confirmation from host
  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      if (msg.type === 'configSaved') {
        setSaving(false);
      } else if (msg.type === 'configImported') {
        setCompositeModels(msg.compositeModels);
        if (msg.compositeModels.length > 0) {
          setSelectedId(msg.compositeModels[0].modelId);
        }
      }
    });
    return unsub;
  }, []);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left panel: composite list */}
      <div
        style={{
          width: '260px',
          minWidth: '200px',
          borderRight: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          overflowY: 'auto',
          flexShrink: 0,
        }}
      >
        <CompositeList
          compositeModels={compositeModels}
          selectedId={selectedId}
          onSelect={handleSelect}
          onAdd={handleAdd}
          onDelete={handleDelete}
        />
      </div>

      {/* Right panel: editor */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Save button at top */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
            background: 'var(--vscode-titleBar-activeBackground, rgba(0,0,0,0.1))',
            flexShrink: 0,
          }}
        >
          <button className="vscode-button" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : '💾 Save'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)' }}>
            {compositeModels.length} composite model{compositeModels.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Editor content */}
        <CompositeEditor
          composite={selectedModel}
          modelRegistry={modelRegistry}
          onChange={handleUpdateSelected}
        />

        {selectedModel && (
          <div style={{ padding: '0 12px 12px' }}>
            <CapabilityPreview composite={selectedModel} modelRegistry={modelRegistry} />
          </div>
        )}
      </div>
    </div>
  );
}
