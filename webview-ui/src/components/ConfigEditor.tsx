import React from 'react';
import CompositeList from './CompositeList';
import CompositeEditor from './CompositeEditor';
import ActionBar from './ActionBar';
import JsonPreview from './JsonPreview';
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
 * Main layout: left panel (composite list), right panel (editor),
 * bottom bar (actions).
 */
export default function ConfigEditor({ initialModels, modelRegistry }: Props) {
  const [compositeModels, setCompositeModels] = React.useState<CompositeModelConfig[]>(initialModels);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialModels.length > 0 ? initialModels[0].modelId : null,
  );
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<string[] | undefined>();

  const vscode = getVsCodeApi();

  const selectedModel = compositeModels.find((m) => m.modelId === selectedId) ?? null;

  const handleSelect = (modelId: string) => {
    setSelectedId(modelId);
    setErrors(undefined);
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
    setCompositeModels(compositeModels.map((m) => (m.modelId === updated.modelId ? updated : m)));
  };

  const handleSave = () => {
    setSaving(true);
    setErrors(undefined);
    vscode.postMessage({ type: 'saveConfig', compositeModels });
  };

  const handleExport = () => {
    vscode.postMessage({ type: 'exportConfig', compositeModels });
  };

  const handleImport = () => {
    vscode.postMessage({ type: 'importConfig' });
  };

  const handleValidate = () => {
    vscode.postMessage({ type: 'validateConfig', compositeModels });
  };

  // Handle messages from host (for save confirmation, import, validation errors)
  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      switch (msg.type) {
        case 'configSaved':
          setSaving(false);
          break;
        case 'validationError':
          setErrors(msg.errors);
          break;
        case 'configImported':
          setCompositeModels(msg.compositeModels);
          if (msg.compositeModels.length > 0) {
            setSelectedId(msg.compositeModels[0].modelId);
          }
          break;
      }
    });
    return unsub;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left panel: composite list */}
        <div
          style={{
            width: '260px',
            minWidth: '200px',
            borderRight: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
            overflowY: 'auto',
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
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <CompositeEditor
              composite={selectedModel}
              modelRegistry={modelRegistry}
              onChange={handleUpdateSelected}
            />

            {selectedModel && (
              <div style={{ padding: '0 12px 12px' }}>
                <CapabilityPreview composite={selectedModel} modelRegistry={modelRegistry} />
                <JsonPreview composite={selectedModel} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      <ActionBar
        errors={errors}
        saving={saving}
        onSave={handleSave}
        onExport={handleExport}
        onImport={handleImport}
        onValidate={handleValidate}
      />
    </div>
  );
}
