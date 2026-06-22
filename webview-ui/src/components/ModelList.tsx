import React from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ModelPicker from './ModelPicker';
import type { ModelRegistrySummary, UnderlyingModelEntry, RoutingStrategy } from '../types';

interface Props {
  models: UnderlyingModelEntry[];
  strategy: RoutingStrategy;
  modelRegistry: ModelRegistrySummary[];
  onChange: (models: UnderlyingModelEntry[]) => void;
}

/**
 * Sortable list of underlying models with drag-and-drop reordering.
 * For failover strategy, order = priority. For round_robin, each model has a weight.
 */
export default function ModelList({ models, strategy, modelRegistry, onChange }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = models.findIndex((m) => m.modelId === active.id);
    const newIndex = models.findIndex((m) => m.modelId === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(models, oldIndex, newIndex).map((m, i) => ({
      ...m,
      priority: i + 1,
    }));
    onChange(reordered);
  };

  const updateModel = (index: number, patch: Partial<UnderlyingModelEntry>) => {
    const updated = models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange(updated);
  };

  const removeModel = (index: number) => {
    onChange(models.filter((_, i) => i !== index));
  };

  const addModel = () => {
    const nextPriority = models.length + 1;
    onChange([
      ...models,
      { modelId: '', provider: '', weight: 1, priority: nextPriority },
    ]);
  };

  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
          Underlying Models
        </span>
        <button className="vscode-button" style={{ padding: '2px 8px', fontSize: '12px' }} onClick={addModel}>
          + Add Model
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={models.map((m) => m.modelId || `new-${m.priority}`)} strategy={verticalListSortingStrategy}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {models.map((model, index) => (
              <SortableModelItem
                key={model.modelId || `new-${model.priority}`}
                id={model.modelId || `new-${model.priority}`}
                model={model}
                index={index}
                strategy={strategy}
                modelRegistry={modelRegistry}
                onUpdate={(patch) => updateModel(index, patch)}
                onRemove={() => removeModel(index)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {models.length === 0 && (
        <div style={{ padding: '12px', textAlign: 'center', color: 'var(--vscode-descriptionForeground, #999)', fontSize: '12px' }}>
          No underlying models. Click "Add Model" to add one.
        </div>
      )}
    </div>
  );
}

// ─── Sortable item ──────────────────────────────────────────────

interface SortableItemProps {
  id: string;
  model: UnderlyingModelEntry;
  index: number;
  strategy: RoutingStrategy;
  modelRegistry: ModelRegistrySummary[];
  onUpdate: (patch: Partial<UnderlyingModelEntry>) => void;
  onRemove: () => void;
}

function SortableModelItem({ id, model, index, strategy, modelRegistry, onUpdate, onRemove }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: 'var(--vscode-editor-background)',
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
    borderRadius: '2px',
    padding: '8px',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          style={{
            cursor: 'grab',
            background: 'none',
            border: 'none',
            color: 'var(--vscode-descriptionForeground, #999)',
            padding: '2px',
            lineHeight: 1,
          }}
          title="Drag to reorder"
          aria-label="Drag to reorder model"
        >
          ⠿
        </button>

        {/* Priority / order number */}
        <span className="vscode-badge" style={{ flexShrink: 0 }}>
          #{index + 1}
        </span>

        {/* Model picker */}
        <div style={{ flex: 1 }}>
          <ModelPicker
            models={modelRegistry}
            value={model.modelId}
            onChange={(modelId, provider) => onUpdate({ modelId, provider })}
          />
        </div>

        {/* Weight (round_robin only) — compact inline input */}
        {strategy === 'round_robin' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
            <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)' }}>
              Wt
            </span>
            <input
              type="number"
              className="vscode-input"
              value={model.weight}
              min={1}
              max={100}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 100) onUpdate({ weight: v });
              }}
              style={{ width: '48px', padding: '2px 4px', fontSize: '11px' }}
            />
          </div>
        )}

        {/* Remove button */}
        <button
          onClick={onRemove}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--vscode-errorForeground, #f48771)',
            cursor: 'pointer',
            padding: '2px 4px',
            fontSize: '14px',
          }}
          title="Remove model"
          aria-label="Remove model"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
