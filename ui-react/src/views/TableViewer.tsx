import { useEffect } from 'react';
import { useTableStore, type TableState, type TableActions } from '@/store/table';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';

type Store = TableState & TableActions;

interface Props {
  tableName: string;
}

export default function TableViewer({ tableName }: Props) {
  const store = useTableStore();
  const tables = useUiStore(s => s.objects.tables);

  useEffect(() => {
    const table = tables.find(t => t.name === tableName) || { name: tableName };
    store.loadTableForViewing(table);
  }, [tableName]);

  const { tableInfo, records, viewMode, setViewMode, loading } = store;

  return (
    <div className="table-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(tableName)}</h3>
        <div className="view-toggle">
          <button className={viewMode === 'datasheet' ? 'active' : ''} onClick={() => setViewMode('datasheet')}>
            Datasheet View
          </button>
          <button className={viewMode === 'design' ? 'active' : ''} onClick={() => setViewMode('design')}>
            Design View
          </button>
        </div>
      </div>

      {loading && <div className="loading-indicator">Loading...</div>}

      {viewMode === 'datasheet' && tableInfo && (
        <DatasheetView
          fields={tableInfo.fields}
          records={records}
          store={store}
        />
      )}

      {viewMode === 'design' && tableInfo && (
        <DesignView store={store} />
      )}
    </div>
  );
}

function DatasheetView({ fields, records, store }: {
  fields: Array<{ name: string; type: string; pk?: boolean }>;
  records: Record<string, unknown>[];
  store: Store;
}) {
  const { selected, editing, startEditing, stopEditing, saveCell, selectCell, moveToNextCell } = store;

  const handleCellDblClick = (row: number, col: string) => {
    startEditing(row, col);
  };

  const handleKeyDown = (e: React.KeyboardEvent, row: number, col: string) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (editing) {
        const input = e.target as HTMLInputElement;
        saveCell(input.value);
      }
      moveToNextCell(e.shiftKey);
    } else if (e.key === 'Enter') {
      if (editing) {
        const input = e.target as HTMLInputElement;
        saveCell(input.value);
      }
    } else if (e.key === 'Escape') {
      stopEditing();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    store.showContextMenu(e.clientX, e.clientY);
  };

  return (
    <div className="datasheet" onContextMenu={handleContextMenu}>
      <table className="data-table">
        <thead>
          <tr>
            {fields.map(f => (
              <th key={f.name} className={f.pk ? 'pk-col' : ''}>
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, rowIdx) => (
            <tr key={rowIdx} className={selected?.row === rowIdx ? 'selected-row' : ''}>
              {fields.map(f => {
                const isSelected = selected?.row === rowIdx && selected?.col === f.name;
                const isEditing = editing?.row === rowIdx && editing?.col === f.name;
                const value = record[f.name];

                return (
                  <td
                    key={f.name}
                    className={`${isSelected ? 'selected-cell' : ''}${isEditing ? ' editing-cell' : ''}`}
                    onClick={() => selectCell(rowIdx, f.name)}
                    onDoubleClick={() => handleCellDblClick(rowIdx, f.name)}
                  >
                    {isEditing ? (
                      <input
                        className="cell-editor"
                        defaultValue={value == null ? '' : String(value)}
                        autoFocus
                        onBlur={e => saveCell(e.target.value)}
                        onKeyDown={e => handleKeyDown(e, rowIdx, f.name)}
                      />
                    ) : (
                      <span className="cell-value">{value == null ? '' : String(value)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {store.contextMenu.visible && (
        <div
          className="context-menu"
          style={{ left: store.contextMenu.x, top: store.contextMenu.y }}
        >
          <div className="context-menu-item" onClick={() => { store.newRecord(); store.hideContextMenu(); }}>
            New Record
          </div>
          <div className="context-menu-item" onClick={() => { store.deleteRecord(); store.hideContextMenu(); }}>
            Delete Record
          </div>
          <hr />
          <div className="context-menu-item" onClick={() => { store.copyCell(); store.hideContextMenu(); }}>
            Copy
          </div>
          <div className="context-menu-item" onClick={() => { store.cutCell(); store.hideContextMenu(); }}>
            Cut
          </div>
          <div className="context-menu-item" onClick={() => { store.pasteCell(); store.hideContextMenu(); }}>
            Paste
          </div>
        </div>
      )}
    </div>
  );
}

function DesignView({ store }: { store: Store }) {
  const {
    designFields, selectedField, selectDesignField,
    updateDesignField, addDesignField, removeDesignField,
    toggleDesignPk, designDirty, designErrors,
    saveTableDesign, revertDesign,
    tableDescription, updateTableDescription,
    newTable, newTableName, setNewTableName, saveNewTable,
  } = store;

  if (!designFields) return null;

  return (
    <div className="design-view">
      <div className="design-split">
        <div className="design-upper">
          {newTable && (
            <div className="new-table-name-row">
              <label>Table Name:</label>
              <input
                className="text-input"
                value={newTableName}
                onChange={e => setNewTableName(e.target.value)}
                placeholder="Enter table name"
                autoFocus
              />
            </div>
          )}
          <table className="design-grid">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Field Name</th>
                <th>Data Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {designFields.map((field: import('@/store/table').DesignField, idx: number) => (
                <tr
                  key={idx}
                  className={selectedField === idx ? 'selected' : ''}
                  onClick={() => selectDesignField(idx)}
                >
                  <td className="pk-indicator" onClick={e => { e.stopPropagation(); toggleDesignPk(idx); }}>
                    {field.isPrimaryKey ? 'PK' : ''}
                  </td>
                  <td>
                    <input
                      className="design-input"
                      value={field.name}
                      onChange={e => updateDesignField(idx, 'name', e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      className="design-select"
                      value={field.type}
                      onChange={e => updateDesignField(idx, 'type', e.target.value)}
                    >
                      <option>Short Text</option>
                      <option>Long Text</option>
                      <option>Number</option>
                      <option>Date/Time</option>
                      <option>Yes/No</option>
                      <option>OLE Object</option>
                      <option>AutoNumber</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="design-input"
                      value={field.description || ''}
                      onChange={e => updateDesignField(idx, 'description', e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="design-actions">
            <button className="btn-sm" onClick={addDesignField}>Add Field</button>
            {selectedField != null && (
              <button className="btn-sm" onClick={() => removeDesignField(selectedField)}>Remove Field</button>
            )}
          </div>
        </div>

        <div className="design-lower">
          <div className="option-row">
            <label>Table Description</label>
            <input
              className="text-input"
              value={tableDescription || ''}
              onChange={e => updateTableDescription(e.target.value)}
            />
          </div>

          {selectedField != null && designFields[selectedField] && (
            <div className="field-properties">
              <h4>Field Properties: {designFields[selectedField].name}</h4>
              <div className="option-row">
                <label>Required</label>
                <select
                  value={designFields[selectedField].nullable ? 'No' : 'Yes'}
                  onChange={e => updateDesignField(selectedField, 'nullable', e.target.value === 'No')}
                >
                  <option>No</option>
                  <option>Yes</option>
                </select>
              </div>
              {designFields[selectedField].type === 'Short Text' && (
                <div className="option-row">
                  <label>Field Size</label>
                  <input
                    className="text-input"
                    type="number"
                    value={designFields[selectedField].maxLength ?? 255}
                    onChange={e => updateDesignField(selectedField, 'maxLength', parseInt(e.target.value, 10))}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {designErrors && (
        <div className="design-errors">
          {designErrors.map((err: { message: string }, i: number) => (
            <div key={i} className="error-item">{err.message}</div>
          ))}
        </div>
      )}

      <div className="design-footer">
        {designDirty && (
          <>
            <button className="primary-btn" onClick={() => newTable ? saveNewTable() : saveTableDesign()}>
              Save
            </button>
            {!newTable && <button className="secondary-btn" onClick={revertDesign}>Revert</button>}
          </>
        )}
      </div>
    </div>
  );
}
