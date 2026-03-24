import { useEffect } from 'react';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';

interface Props {
  moduleName: string;
}

export default function ModuleViewer({ moduleName }: Props) {
  const { moduleViewer, loadModuleForViewing, objects } = useUiStore();
  const { moduleInfo, loading } = moduleViewer;

  useEffect(() => {
    const mod = objects.modules.find(m => m.name === moduleName);
    if (mod) loadModuleForViewing(mod);
  }, [moduleName]);

  if (loading) return <div className="loading-indicator">Loading module...</div>;
  if (!moduleInfo) return <div className="empty-viewer">Module not found</div>;

  return (
    <div className="module-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(moduleName)}</h3>
        <div className="module-info-bar">
          {moduleInfo.status && (
            <span className={`status-badge ${moduleInfo.status}`}>{moduleInfo.status}</span>
          )}
          {moduleInfo.version != null && (
            <span className="version-badge">v{moduleInfo.version}</span>
          )}
        </div>
      </div>

      <div className="module-split">
        <div className="module-vba-panel">
          <div className="panel-header">VBA Source</div>
          <pre className="vba-source">{moduleInfo.vba_source || '(no VBA source)'}</pre>
        </div>

        <div className="module-js-panel">
          <div className="panel-header">JS Handlers</div>
          {moduleInfo.js_handlers && Object.keys(moduleInfo.js_handlers).length > 0 ? (
            <div className="handlers-list">
              {Object.entries(moduleInfo.js_handlers).map(([key, handler]) => (
                <div key={key} className="handler-entry">
                  <div className="handler-key">
                    <span className="handler-event">{handler.event}</span>
                    {handler.control && <span className="handler-control">{handler.control}</span>}
                    {handler.confidence && (
                      <span className={`confidence-badge ${handler.confidence}`}>{handler.confidence}</span>
                    )}
                  </div>
                  {handler.js && (
                    <pre className="handler-js">{handler.js}</pre>
                  )}
                  {handler.notes && (
                    <div className="handler-notes">{handler.notes}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-panel">No JS handlers generated</div>
          )}
        </div>
      </div>

      {moduleInfo.description && (
        <div className="module-description">
          <strong>Description:</strong> {moduleInfo.description}
        </div>
      )}
    </div>
  );
}
