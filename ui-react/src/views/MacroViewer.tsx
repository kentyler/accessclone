import { useEffect, useCallback } from 'react';
import { useUiStore } from '@/store/ui';
import * as api from '@/api/client';
import { filenameToDisplayName } from '@/lib/utils';

const STATUS_OPTIONS = [
  ['pending', 'Pending'],
  ['translated', 'Translated'],
  ['needs-review', 'Needs Review'],
  ['complete', 'Complete'],
] as const;

interface Props {
  macroName: string;
}

export default function MacroViewer({ macroName }: Props) {
  const { macroViewer, loadMacroForViewing, objects } = useUiStore();
  const { macroInfo, loading } = macroViewer;

  useEffect(() => {
    const macro = objects.macros.find(m => m.name === macroName);
    if (macro) loadMacroForViewing(macro);
  }, [macroName]);

  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!macroInfo) return;
    await api.put(`/api/macros/${encodeURIComponent(macroInfo.name)}`, {
      status: newStatus,
    });
    // Reload to reflect server state
    const macro = objects.macros.find(m => m.name === macroName);
    if (macro) loadMacroForViewing(macro);
  }, [macroInfo, macroName, objects.macros, loadMacroForViewing]);

  if (loading) return <div className="loading-indicator">Loading macro...</div>;
  if (!macroInfo) return <div className="empty-viewer">Macro not found</div>;

  const status = macroInfo.status || 'pending';

  return (
    <div className="macro-viewer">
      {/* Toolbar */}
      <div className="module-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-label">Access Macro</span>
        </div>
      </div>

      {/* Info panel */}
      <div className="module-info-panel">
        <div className="info-row">
          <span className="info-label">Macro:</span>
          <span className="info-value">{filenameToDisplayName(macroName)}</span>
        </div>
        {macroInfo.version != null && (
          <div className="info-row">
            <span className="info-label">Version:</span>
            <span className="info-value">v{macroInfo.version}</span>
          </div>
        )}
        {macroInfo.created_at && (
          <div className="info-row">
            <span className="info-label">Imported:</span>
            <span className="info-value">
              {new Date(macroInfo.created_at).toLocaleDateString()}{' '}
              {new Date(macroInfo.created_at).toLocaleTimeString()}
            </span>
          </div>
        )}
        <div className="info-row">
          <span className="info-label">Status:</span>
          <select
            className="status-select"
            value={status}
            onChange={e => handleStatusChange(e.target.value)}
          >
            {STATUS_OPTIONS.map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Macro XML */}
      <pre className="macro-source">{macroInfo.macro_xml || '(no macro definition)'}</pre>

      {macroInfo.description && (
        <div className="module-description">
          <strong>Description:</strong> {macroInfo.description}
        </div>
      )}
    </div>
  );
}
