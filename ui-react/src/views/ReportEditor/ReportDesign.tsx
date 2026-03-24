import { useState, useCallback } from 'react';
import { useReportStore } from '@/store/report';
import { useUiStore } from '@/store/ui';
import {
  controlStyle, displayText, snapToGrid,
} from '@/lib/utils';
import { CONTROL_DEFAULTS } from '@/views/FormEditor/ControlPalette';
import { getAllSections, sectionDisplayName, getReportSectionHeight, getReportSectionControls } from './ReportView';
import type { Control, ReportDefinition, Section, ControlType } from '@/api/types';

// ============================================================
// Design control
// ============================================================

function DesignControl({
  ctrl, idx, section, selected, onSelect, onDelete,
}: {
  ctrl: Control;
  idx: number;
  section: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
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
// Report section (banded)
// ============================================================

function ReportDesignSection({
  section, reportDef, gridSize, activeTool, onToolPlaced,
  onStartResize,
}: {
  section: string;
  reportDef: ReportDefinition;
  gridSize: number;
  activeTool: ControlType | null;
  onToolPlaced: () => void;
  onStartResize: (section: string, startY: number) => void;
}) {
  const store = useReportStore();
  const height = getReportSectionHeight(reportDef, section);
  const controls = getReportSectionControls(reportDef, section);

  const selectedIdx = store.selectedControl?.section === section ? store.selectedControl.idx : undefined;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    const paletteType = e.dataTransfer.getData('application/x-palette-type');
    const controlIdx = e.dataTransfer.getData('application/x-control-idx');
    const fieldData = e.dataTransfer.getData('application/x-field');

    if (paletteType) {
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
      const newDef = { ...reportDef } as Record<string, unknown>;
      const sec = { ...((newDef[section] as Record<string, unknown>) ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setReportDefinition(newDef as unknown as ReportDefinition);
      store.selectControl({ section, idx: (sec.controls as Control[]).length - 1 });
      onToolPlaced();
    } else if (controlIdx && e.dataTransfer.getData('application/x-section')) {
      const fromSection = e.dataTransfer.getData('application/x-section');
      const fromIdx = parseInt(controlIdx, 10);
      const offset = JSON.parse(e.dataTransfer.getData('application/x-offset') || '{"x":0,"y":0}');
      const left = snapToGrid(rawX - offset.x, false, gridSize);
      const top = snapToGrid(rawY - offset.y, false, gridSize);

      if (fromSection === section) {
        store.updateControl(section, fromIdx, 'left', left);
        store.updateControl(section, fromIdx, 'top', top);
      } else {
        // Cross-section move
        const newDef = { ...reportDef } as Record<string, unknown>;
        const fromSec = { ...((newDef[fromSection] as Record<string, unknown>) ?? { controls: [] }) };
        const fromCtrls = [...(fromSec.controls as Control[] ?? [])];
        const [moved] = fromCtrls.splice(fromIdx, 1);
        fromSec.controls = fromCtrls;
        newDef[fromSection] = fromSec;

        const toSec = { ...((newDef[section] as Record<string, unknown>) ?? { controls: [] }) };
        const toCtrls = [...(toSec.controls as Control[] ?? []), { ...moved, left, top }];
        toSec.controls = toCtrls;
        newDef[section] = toSec;
        store.setReportDefinition(newDef as unknown as ReportDefinition);
        store.selectControl({ section, idx: toCtrls.length - 1 });
      }
    } else if (fieldData) {
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
      const newDef = { ...reportDef } as Record<string, unknown>;
      const sec = { ...((newDef[section] as Record<string, unknown>) ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setReportDefinition(newDef as unknown as ReportDefinition);
      store.selectControl({ section, idx: (sec.controls as Control[]).length - 1 });
    }
  };

  const handleClick = (e: React.MouseEvent) => {
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
      const newDef = { ...reportDef } as Record<string, unknown>;
      const sec = { ...((newDef[section] as Record<string, unknown>) ?? { controls: [] }) };
      sec.controls = [...(sec.controls as Control[] ?? []), newCtrl];
      newDef[section] = sec;
      store.setReportDefinition(newDef as unknown as ReportDefinition);
      store.selectControl({ section, idx: (sec.controls as Control[]).length - 1 });
      onToolPlaced();
    } else {
      store.selectControl({ section });
    }
  };

  return (
    <div className="form-section">
      <div
        className="section-divider"
        style={{ cursor: 'ns-resize' }}
        onMouseDown={e => { e.preventDefault(); onStartResize(section, e.clientY); }}
      >
        <span className="section-label">{sectionDisplayName(section)}</span>
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
              onSelect={() => store.selectControl({ section, idx })}
              onDelete={() => store.deleteControl(section, idx)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Field list for reports
// ============================================================

export function FieldList({ reportDef }: { reportDef: ReportDefinition }) {
  const recordSource = reportDef['record-source'];
  if (!recordSource) return <div className="field-list-panel"><span>No record source</span></div>;

  return (
    <div className="field-list-panel">
      <div className="panel-header">Fields: {recordSource}</div>
      <div style={{ color: '#999', padding: 4, fontSize: 12 }}>
        (Field list loaded from record source)
      </div>
    </div>
  );
}

// ============================================================
// Main report design canvas
// ============================================================

export default function ReportDesign({ activeTool, onToolPlaced }: {
  activeTool: ControlType | null;
  onToolPlaced: () => void;
}) {
  const store = useReportStore();
  const gridSize = useUiStore(s => s.config.formDesigner.gridSize) || 8;
  const current = store.current;

  // Section resize state
  const [resizing, setResizing] = useState<{ section: string; startY: number } | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!resizing || !current) return;
    const sec = (current as Record<string, unknown>)[resizing.section] as Section | undefined;
    const curHeight = sec?.height ?? 200;
    const delta = e.clientY - resizing.startY;
    const newHeight = Math.max(20, curHeight + delta);

    const newDef = { ...current } as Record<string, unknown>;
    const section = { ...((newDef[resizing.section] as Record<string, unknown>) ?? {}) };
    section.height = newHeight;
    newDef[resizing.section] = section;
    store.setReportDefinition(newDef as unknown as ReportDefinition);
    setResizing({ ...resizing, startY: e.clientY });
  }, [resizing, current, store]);

  const handleMouseUp = useCallback(() => {
    setResizing(null);
  }, []);

  if (!current) return null;

  const sections = getAllSections(current);

  return (
    <div
      className="form-canvas"
      onMouseMove={resizing ? handleMouseMove : undefined}
      onMouseUp={resizing ? handleMouseUp : undefined}
      onMouseLeave={resizing ? handleMouseUp : undefined}
    >
      <div className="canvas-header" onClick={() => store.selectControl(null)}>
        <span>Design View — {current.name || 'Report'}</span>
      </div>
      <div className="canvas-body sections-container">
        <div className="sections-inner">
          {sections.map(sectionKey => (
            <ReportDesignSection
              key={sectionKey}
              section={sectionKey}
              reportDef={current}
              gridSize={gridSize}
              activeTool={activeTool}
              onToolPlaced={onToolPlaced}
              onStartResize={(sec, y) => setResizing({ section: sec, startY: y })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
