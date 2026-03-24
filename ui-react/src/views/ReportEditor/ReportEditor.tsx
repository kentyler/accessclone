import { useEffect, useState } from 'react';
import { useReportStore } from '@/store/report';
import { useUiStore } from '@/store/ui';
import ReportView from './ReportView';
import ReportDesign, { FieldList } from './ReportDesign';
import ReportProperties from './ReportProperties';
import ControlPalette from '@/views/FormEditor/ControlPalette';
import type { ControlType } from '@/api/types';

interface Props {
  reportName: string;
}

export default function ReportEditor({ reportName }: Props) {
  const store = useReportStore();
  const reports = useUiStore(s => s.objects.reports);
  const propsOpen = useUiStore(s => s.propertiesPanelOpen);
  const toggleProps = useUiStore(s => s.togglePropertiesPanel);
  const [activeTool, setActiveTool] = useState<ControlType | null>(null);

  useEffect(() => {
    const report = reports.find(r => r.name === reportName);
    if (report && report.id !== store.reportId) {
      store.loadReportForEditing(report as { id: number; name: string; filename: string; definition?: import('@/api/types').ReportDefinition });
    }
  }, [reportName]);

  const viewMode = store.viewMode;
  const dirty = store.dirty;
  const current = store.current;
  const lintErrors = store.lintErrors;

  return (
    <div className="form-editor">
      {/* Toolbar */}
      <div className="form-toolbar">
        <div className="toolbar-left">
          <button className={`toolbar-btn${viewMode === 'design' ? ' active' : ''}`}
            onClick={() => store.setViewMode('design')}>Design</button>
          <button className={`toolbar-btn${viewMode === 'preview' ? ' active' : ''}`}
            onClick={() => store.setViewMode('preview')}>Preview</button>
          {viewMode === 'design' && (
            <>
              <button className="toolbar-btn" onClick={() => store.addGroupLevel()}>+Group</button>
              <button className="toolbar-btn" onClick={() => store.removeGroupLevel()}
                disabled={!current?.grouping?.length}>-Group</button>
            </>
          )}
        </div>
        <div className="toolbar-right">
          <button className="secondary-btn" disabled={!dirty}
            onClick={() => { if (store.original) store.setReportDefinition(store.original); }}>Undo</button>
          <button className="primary-btn" disabled={!dirty}
            onClick={() => store.saveReport()}>Save</button>
        </div>
      </div>

      {/* Palette (design mode only) */}
      {viewMode === 'design' && (
        <ControlPalette activeTool={activeTool} onToolSelect={setActiveTool} />
      )}

      {/* Lint errors panel */}
      {lintErrors && lintErrors.length > 0 && (
        <div className="lint-errors-panel">
          <div className="lint-errors-header">
            <span className="lint-errors-title">Report Validation Errors</span>
            <button className="lint-errors-close" onClick={() => store.clearLintErrors()}>&times;</button>
          </div>
          <ul className="lint-errors-list">
            {lintErrors.map((err, idx) => (
              <li key={idx} className="lint-error">
                <span className="error-message">{err.message}</span>
              </li>
            ))}
          </ul>
          <div className="lint-errors-actions">
            <button className="secondary-btn" onClick={() => store.clearLintErrors()}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Editor body */}
      {viewMode === 'preview' ? (
        <div className="editor-body view-mode">
          <div className="editor-center"><ReportView /></div>
        </div>
      ) : (
        <div className="editor-body">
          <div className="editor-center">
            <ReportDesign activeTool={activeTool} onToolPlaced={() => setActiveTool(null)} />
          </div>
          <div className={`editor-right${!propsOpen ? ' collapsed' : ''}`}>
            <div className="properties-header">
              <span className="properties-header-title">Properties</span>
              <button className="properties-toggle" onClick={toggleProps}>
                {propsOpen ? '\u00BB' : '\u00AB'}
              </button>
            </div>
            {propsOpen && <ReportProperties />}
            {propsOpen && current && <FieldList reportDef={current} />}
          </div>
        </div>
      )}
    </div>
  );
}
