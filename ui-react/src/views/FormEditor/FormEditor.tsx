import { useEffect, useState } from 'react';
import { useFormStore } from '@/store/form';
import { useUiStore } from '@/store/ui';
import FormView from './FormView';
import FormDesign from './FormDesign';
import FormProperties from './FormProperties';
import ControlPalette from './ControlPalette';
import type { ControlType } from '@/api/types';

interface Props {
  formName: string;
}

export default function FormEditor({ formName }: Props) {
  const store = useFormStore();
  const forms = useUiStore(s => s.objects.forms);
  const closeTab = useUiStore(s => s.closeTab);
  const propsOpen = useUiStore(s => s.propertiesPanelOpen);
  const toggleProps = useUiStore(s => s.togglePropertiesPanel);
  const [activeTool, setActiveTool] = useState<ControlType | null>(null);

  useEffect(() => {
    const form = forms.find(f => f.name === formName);
    if (form && form.id !== store.formId) {
      store.loadFormForEditing(form as { id: number; name: string; filename: string; definition?: import('@/api/types').FormDefinition });
    }
  }, [formName]);

  const viewMode = store.viewMode;
  const dirty = store.dirty;
  const definition = store.current;
  const lintErrors = store.lintErrors;

  const popup = definition && (definition as Record<string, unknown>).popup !== 0;
  const modal = popup && (definition as Record<string, unknown>).modal !== 0;

  return (
    <div className="form-editor">
      {/* Toolbar */}
      <div className="form-toolbar">
        <div className="toolbar-left">
          <button className={`toolbar-btn${viewMode === 'design' ? ' active' : ''}`}
            title="Design View" onClick={() => store.setViewMode('design')}>Design</button>
          <button className={`toolbar-btn${viewMode === 'view' ? ' active' : ''}`}
            title="Form View" onClick={() => store.setViewMode('view')}>View</button>
          {viewMode === 'design' && (
            <button className={`toolbar-btn${(definition?.header?.visible ?? 1) !== 0 ? ' active' : ''}`}
              title="Toggle Header/Footer"
              onClick={() => {
                if (!definition) return;
                const newDef = { ...definition };
                const hdrVis = (newDef.header?.visible ?? 1) !== 0;
                newDef.header = { ...(newDef.header ?? {}), visible: hdrVis ? 0 : 1 } as typeof newDef.header;
                newDef.footer = { ...(newDef.footer ?? {}), visible: hdrVis ? 0 : 1 } as typeof newDef.footer;
                store.setFormDefinition(newDef);
              }}>Header/Footer</button>
          )}
        </div>
        <div className="toolbar-right">
          <button className="secondary-btn" disabled={!dirty}
            onClick={() => { if (store.original) store.setFormDefinition(store.original); }}>Undo</button>
          <button className="primary-btn" disabled={!dirty}
            onClick={() => store.saveForm()}>Save</button>
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
            <span className="lint-errors-title">Form Validation Errors</span>
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
      {viewMode === 'view' ? (
        popup ? (
          <div className="editor-body view-mode">
            <div className={`popup-overlay${modal ? ' modal' : ''}`}>
              <div className="popup-window">
                <div className="popup-title-bar">
                  <span className="popup-title">{definition?.caption || definition?.name || 'Form'}</span>
                  <button className="popup-close" onClick={() => closeTab('forms', store.formId!)}>&#10005;</button>
                </div>
                <FormView />
              </div>
            </div>
          </div>
        ) : (
          <div className="editor-body view-mode">
            <div className="editor-center"><FormView /></div>
          </div>
        )
      ) : (
        <div className="editor-body">
          <div className="editor-center">
            <FormDesign activeTool={activeTool} onToolPlaced={() => setActiveTool(null)} />
          </div>
          <div className={`editor-right${!propsOpen ? ' collapsed' : ''}`}>
            <div className="properties-header">
              <span className="properties-header-title">Properties</span>
              <button className="properties-toggle" onClick={toggleProps}>
                {propsOpen ? '\u00BB' : '\u00AB'}
              </button>
            </div>
            {propsOpen && <FormProperties />}
          </div>
        </div>
      )}
    </div>
  );
}
