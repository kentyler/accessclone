import { useEffect } from 'react';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';

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

  if (loading) return <div className="loading-indicator">Loading macro...</div>;
  if (!macroInfo) return <div className="empty-viewer">Macro not found</div>;

  return (
    <div className="macro-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(macroName)}</h3>
        <div className="module-info-bar">
          {macroInfo.status && (
            <span className={`status-badge ${macroInfo.status}`}>{macroInfo.status}</span>
          )}
          {macroInfo.version != null && (
            <span className="version-badge">v{macroInfo.version}</span>
          )}
        </div>
      </div>

      <pre className="macro-source">{macroInfo.macro_xml || '(no macro definition)'}</pre>

      {macroInfo.description && (
        <div className="module-description">
          <strong>Description:</strong> {macroInfo.description}
        </div>
      )}
    </div>
  );
}
