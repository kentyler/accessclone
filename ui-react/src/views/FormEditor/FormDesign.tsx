import { useState, useRef, useCallback, useMemo } from 'react';
import { useFormStore } from '@/store/form';
import { useUiStore } from '@/store/ui';
import {
  controlStyle, displayText, snapToGrid, getSectionControls, getSectionHeight
} from '@/lib/utils';
import { CONTROL_DEFAULTS } from './ControlPalette';
import type { Control, FormDefinition, ControlType, ColumnInfo } from '@/api/types';

// ============================================================
// Design control — single control on the canvas
// ============================================================

function DesignControl({
  ctrl, idx, section, selected, onSelect, onDelete, gridSize
}: {
  ctrl: Control;
  idx: number;
  section: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  gridSize: number;
}) {
  const store = useFormStore();
  const style = controlStyle(ctrl);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-control-idx', String(idx));
    e.dataTransfer.setData('application/x-section', section);
    const rect = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setData('application/x-offset', JSON.stringify({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }));
  };

  return (
    <div
      className={`form-control ${ctrl.type || 'label'}${selected ? ' selected' : ''}`}
      style={style}
      draggable
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onDragStart={handleDragStart}
    >
      {displayText(ctrl)}
      {selected && (
        <button className="control-delete" onClick={e => { e.stopPropagation(); onDelete(); }}>&times;</button>
      )}
    </div>
  );
}

// ============================================================
// Section — header, detail, or footer
// ============================================================

function DesignSection({
  section, formDef, gridSize, activeTool, onToolPlaced
}: {
  section: 'header' | 'detail' | 'footer';
  formDef: FormDefinition;
  gridSize: number;
  activeTool: ControlType | null;
  onToolPlaced: () => void;
}) {
  const store = useFormStore();
  const sectionData = formDef[section];
  const height = getSectionHeight(formDef as Record<string, unknown>, section);
  const controls = getSectionControls(formDef as Record<string, unknown>, section);
  const visible = (sectionData?.visible ?? 1) !== 0;

  if (!visible && section !== 'detail') return null;

  const selectedIdx = store.selectedSection === section ? store.selectedControl : null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    // Check drop type
    const paletteType = e.dataTransfer.getData('application/x-palette-type');
    const controlIdx = e.dataTransfer.getData('application/x-control-idx');
    const fieldData = e.dataTransfer.getData('application/x-field');

    if (paletteType) {
      // New control from palette
      const defaults = CONTROL_DEFAULTS[paletteType] || { width: 100, height: 24 };
      const newCtrl: Control = {
        type: paletteType as ControlType,
        name: `${paletteType}_${Date.now()}`,
        left: snapToGrid(rawX, false, gridSize),
        top: snapToGrid(rawY, false, gridSize),
        width: defaults.width,
        height: defaults.height,
        caption: defaults.caption,
      };
      const newDef = { ...formDef } as Record<string, unknown>;
      const sec = { ...(newDef[section] as Record<string, unknown> ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setFormDefinition(newDef as unknown as FormDefinition);
      store.selectControl((sec.controls as Control[]).length - 1);
      store.selectSection(section);
      onToolPlaced();
    } else if (controlIdx && e.dataTransfer.getData('application/x-section')) {
      // Moving existing control
      const fromSection = e.dataTransfer.getData('application/x-section');
      const fromIdx = parseInt(controlIdx, 10);
      const offset = JSON.parse(e.dataTransfer.getData('application/x-offset') || '{"x":0,"y":0}');
      const left = snapToGrid(rawX - offset.x, false, gridSize);
      const top = snapToGrid(rawY - offset.y, false, gridSize);

      if (fromSection === section) {
        // Same section — update position
        store.updateControl(section, fromIdx, 'left', left);
        store.updateControl(section, fromIdx, 'top', top);
      } else {
        // Cross-section move — remove from old, add to new
        const newDef = { ...formDef } as Record<string, unknown>;
        const fromSec = { ...(newDef[fromSection] as Record<string, unknown> ?? { controls: [] }) };
        const fromCtrls = [...(fromSec.controls as Control[] ?? [])];
        const [moved] = fromCtrls.splice(fromIdx, 1);
        fromSec.controls = fromCtrls;
        newDef[fromSection] = fromSec;

        const toSec = { ...(newDef[section] as Record<string, unknown> ?? { controls: [] }) };
        const toCtrls = [...(toSec.controls as Control[] ?? []), { ...moved, left, top }];
        toSec.controls = toCtrls;
        newDef[section] = toSec;
        store.setFormDefinition(newDef as unknown as FormDefinition);
        store.selectControl(toCtrls.length - 1);
        store.selectSection(section);
      }
    } else if (fieldData) {
      // Field dragged from field list
      const field = JSON.parse(fieldData) as { name: string; type: string };
      const defaults = CONTROL_DEFAULTS['text-box'] || { width: 150, height: 24 };
      const newCtrl: Control = {
        type: 'text-box',
        name: field.name,
        field: field.name,
        'control-source': field.name,
        left: snapToGrid(rawX, false, gridSize),
        top: snapToGrid(rawY, false, gridSize),
        width: defaults.width,
        height: defaults.height,
      };
      const newDef = { ...formDef } as Record<string, unknown>;
      const sec = { ...(newDef[section] as Record<string, unknown> ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setFormDefinition(newDef as unknown as FormDefinition);
      store.selectControl((sec.controls as Control[]).length - 1);
      store.selectSection(section);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // Click on empty space with palette tool active — place control
    if (activeTool) {
      const rect = e.currentTarget.getBoundingClientRect();
      const left = snapToGrid(e.clientX - rect.left, false, gridSize);
      const top = snapToGrid(e.clientY - rect.top, false, gridSize);
      const defaults = CONTROL_DEFAULTS[activeTool] || { width: 100, height: 24 };
      const newCtrl: Control = {
        type: activeTool,
        name: `${activeTool}_${Date.now()}`,
        left, top,
        width: defaults.width,
        height: defaults.height,
        caption: defaults.caption,
      };
      const newDef = { ...formDef } as Record<string, unknown>;
      const sec = { ...(newDef[section] as Record<string, unknown> ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setFormDefinition(newDef as unknown as FormDefinition);
      store.selectControl((sec.controls as Control[]).length - 1);
      store.selectSection(section);
      onToolPlaced();
    } else {
      // Deselect control, select section
      store.selectControl(null);
      store.selectSection(section);
    }
  };

  return (
    <div className={`form-section ${section}`}>
      <div className="section-divider">
        <span className="section-label">{section.charAt(0).toUpperCase() + section.slice(1)}</span>
      </div>
      <div
        className="section-body"
        style={{
          height,
          backgroundSize: `${gridSize}px ${gridSize}px`,
          cursor: activeTool ? 'crosshair' : undefined,
        }}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        {controls.length === 0 && (
          <div className="section-empty">Drop controls here</div>
        )}
        <div className="controls-container">
          {controls.map((ctrl: Control, idx: number) => (
            <DesignControl
              key={idx}
              ctrl={ctrl}
              idx={idx}
              section={section}
              selected={selectedIdx === idx}
              gridSize={gridSize}
              onSelect={() => { store.selectControl(idx); store.selectSection(section); }}
              onDelete={() => store.deleteControl(section, idx)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Field list panel
// ============================================================

function FieldList({ formDef }: { formDef: FormDefinition }) {
  const recordSource = (formDef as Record<string, unknown>)['record-source'] as string | undefined;
  const tables = useUiStore(s => s.objects.tables);
  const queries = useUiStore(s => s.objects.queries);

  const fields: ColumnInfo[] = useMemo(() => {
    if (!recordSource) return [];
    const rsLower = recordSource.toLowerCase();
    const table = tables.find(t => t.name.toLowerCase() === rsLower);
    if (table) return table.fields ?? [];
    const query = queries.find(q => q.name.toLowerCase() === rsLower);
    if (query) return query.fields ?? [];
    return [];
  }, [recordSource, tables, queries]);

  if (!recordSource) return <div className="field-list-panel"><span>No record source</span></div>;

  return (
    <div className="field-list-panel">
      <div className="panel-header">Fields: {recordSource}</div>
      {fields.length === 0 ? (
        <div style={{ color: '#999', padding: 4, fontSize: 12 }}>No fields found</div>
      ) : (
        <div className="field-list-items">
          {fields.map(f => (
            <div
              key={f.name}
              className="field-list-item"
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('application/x-field', JSON.stringify({ name: f.name, type: f.type }));
              }}
            >
              <span className="field-name">{f.name}</span>
              <span className="field-type">{f.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main design canvas
// ============================================================

export default function FormDesign({ activeTool, onToolPlaced }: {
  activeTool: ControlType | null;
  onToolPlaced: () => void;
}) {
  const store = useFormStore();
  const gridSize = useUiStore(s => s.config.formDesigner.gridSize) || 8;
  const current = store.current;

  if (!current) return null;

  const showHeader = current.header && (current.header.visible ?? 1) !== 0;
  const showFooter = current.footer && (current.footer.visible ?? 1) !== 0;

  return (
    <div className="form-canvas">
      <div className="canvas-header">
        <span>Design View</span>
      </div>
      <div className="canvas-body sections-container">
        <div className="sections-inner">
          {showHeader && (
            <DesignSection section="header" formDef={current} gridSize={gridSize}
              activeTool={activeTool} onToolPlaced={onToolPlaced} />
          )}
          <DesignSection section="detail" formDef={current} gridSize={gridSize}
            activeTool={activeTool} onToolPlaced={onToolPlaced} />
          {showFooter && (
            <DesignSection section="footer" formDef={current} gridSize={gridSize}
              activeTool={activeTool} onToolPlaced={onToolPlaced} />
          )}
        </div>
      </div>
    </div>
  );
}
