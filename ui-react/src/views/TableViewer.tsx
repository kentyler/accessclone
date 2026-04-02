import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTableStore, type TableState, type TableActions } from '@/store/table';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';
import ColumnDropdown from '@/components/ColumnDropdown';

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
          <button className={viewMode === 'intents' ? 'active' : ''} onClick={() => setViewMode('intents')}>
            Intents
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

      {viewMode === 'intents' && (
        <IntentsView store={store} />
      )}
    </div>
  );
}

function IntentsView({ store }: { store: Store }) {
  const { intents, intentsLoading } = store;

  if (intentsLoading) {
    return <div className="intents-view"><div className="loading-indicator">Loading intents...</div></div>;
  }

  if (!intents || intents.length === 0) {
    return (
      <div className="intents-view">
        <div className="no-intents-message">No intents extracted for this table.</div>
      </div>
    );
  }

  return (
    <div className="intents-view">
      {intents.map((intent, i) => (
        <pre key={i} className="intent-json">{JSON.stringify(intent, null, 2)}</pre>
      ))}
    </div>
  );
}

// ColumnDropdown imported from @/components/ColumnDropdown

// ============================================================
// Datasheet
// ============================================================

function DatasheetView({ fields, records, store }: {
  fields: Array<{ name: string; type: string; pk?: boolean }>;
  records: Record<string, unknown>[];
  store: Store;
}) {
  const { selected, editing, startEditing, stopEditing, saveCell, selectCell, moveToNextCell,
    sortColumn, sortDirection, filters, activeFilterColumn } = store;

  const filteredRecords = store.getFilteredRecords();

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

  const toggleDropdown = useCallback((col: string, e: React.MouseEvent) => {
    e.stopPropagation();
    store.setActiveFilterColumn(activeFilterColumn === col ? null : col);
  }, [activeFilterColumn]);

  return (
    <div className="datasheet" onContextMenu={handleContextMenu}>
      <table className="data-table">
        <thead>
          <tr>
            {fields.map(f => {
              const isSorted = sortColumn === f.name;
              const isFiltered = !!(filters[f.name] && filters[f.name].length > 0);
              return (
                <th key={f.name} className={`${f.pk ? 'pk-col' : ''} ${isFiltered ? 'filtered-col' : ''}`}>
                  <div className="column-header" onClick={e => toggleDropdown(f.name, e)}>
                    <span className="column-header-name">
                      {f.name}
                      {isSorted && <span className="sort-indicator">{sortDirection === 'asc' ? ' \u2191' : ' \u2193'}</span>}
                      {isFiltered && <span className="filter-indicator">{' \u0192'}</span>}
                    </span>
                    <span className="column-header-arrow">{'\u25BC'}</span>
                  </div>
                  {activeFilterColumn === f.name && (
                    <ColumnDropdown
                      column={f.name}
                      records={records}
                      currentExcluded={filters[f.name] || []}
                      onSort={(col, dir) => store.sortBy(col, dir)}
                      onSetFilter={(col, excl) => store.setFilter(col, excl)}
                      onClearFilter={(col) => store.clearFilter(col)}
                      onClose={() => store.setActiveFilterColumn(null)}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {filteredRecords.map((record, rowIdx) => (
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

      {Object.keys(filters).length > 0 && (
        <div className="filter-status-bar">
          Filtered: {filteredRecords.length} of {records.length} records
          <button className="clear-all-filters-btn" onClick={() => store.clearFilter()}>Clear All Filters</button>
        </div>
      )}

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

function PropertyRow({ label, value, na }: { label: string; value?: string | null; na?: boolean }) {
  return (
    <div className="field-property-row">
      <div className="field-property-label">{label}</div>
      <div className={`field-property-value${na ? ' property-na' : ''}`}>
        {na ? '' : (value ?? '')}
      </div>
    </div>
  );
}

function EditablePropertyRow({ label, value, onChange, options, type }: {
  label: string;
  value?: string | number | null;
  onChange: (v: string) => void;
  options?: string[];
  type?: string;
}) {
  return (
    <div className="field-property-row">
      <div className="field-property-label">{label}</div>
      <div className="field-property-value">
        {options ? (
          <select value={value ?? ''} onChange={e => onChange(e.target.value)}>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input type={type || 'text'} value={value ?? ''} onChange={e => onChange(e.target.value)} />
        )}
      </div>
    </div>
  );
}

function FieldPropertiesSheet({ field, fieldIdx, updateDesignField }: {
  field: import('@/store/table').DesignField;
  fieldIdx: number;
  updateDesignField: (idx: number, prop: string, value: unknown) => void;
}) {
  return (
    <div className="field-properties">
      <div className="field-properties-header">Field Properties</div>
      <div className="field-properties-tab">General</div>
      <div className="field-properties-body">
        {(field.type === 'Short Text' || field.type === 'character varying') && (
          <EditablePropertyRow label="Field Size" value={field.maxLength ?? 255}
            onChange={v => updateDesignField(fieldIdx, 'maxLength', parseInt(v, 10) || 255)} type="number" />
        )}
        {field.type === 'Number' && (
          <EditablePropertyRow label="Field Size" value="Long Integer"
            onChange={() => {}} options={['Byte', 'Integer', 'Long Integer', 'Single', 'Double', 'Decimal']} />
        )}
        <PropertyRow label="New Values" na />
        <PropertyRow label="Format" na />
        <PropertyRow label="Input Mask" na />
        <EditablePropertyRow label="Caption" value={field.description}
          onChange={v => updateDesignField(fieldIdx, 'description', v)} />
        <EditablePropertyRow label="Default Value" value={field.defaultValue}
          onChange={v => updateDesignField(fieldIdx, 'defaultValue', v)} />
        <PropertyRow label="Validation Rule" />
        <PropertyRow label="Validation Text" na />
        <EditablePropertyRow label="Required" value={field.nullable ? 'No' : 'Yes'}
          onChange={v => updateDesignField(fieldIdx, 'nullable', v === 'No')}
          options={['No', 'Yes']} />
        <PropertyRow label="Allow Zero Length" na />
        <EditablePropertyRow label="Indexed"
          value={field.indexed === 'unique' ? 'Yes (No Duplicates)' : field.indexed === 'yes' ? 'Yes (Duplicates OK)' : (field.indexed ? 'Yes (Duplicates OK)' : 'No')}
          onChange={v => updateDesignField(fieldIdx, 'indexed',
            v === 'Yes (Duplicates OK)' ? 'yes' : v === 'Yes (No Duplicates)' ? 'unique' : null)}
          options={['No', 'Yes (Duplicates OK)', 'Yes (No Duplicates)']} />
        <PropertyRow label="Primary Key" value={field.isPrimaryKey ? 'Yes' : 'No'} />
        <PropertyRow label="Unicode Compression" na />
        <PropertyRow label="IME Mode" na />
        <PropertyRow label="Text Align" na />
      </div>
    </div>
  );
}

function TablePropertiesSheet({ fields, tableDescription, updateTableDescription }: {
  fields: import('@/store/table').DesignField[];
  tableDescription: string | null;
  updateTableDescription: (desc: string) => void;
}) {
  const pkName = fields.find(f => f.isPrimaryKey)?.name || '';
  return (
    <div className="field-properties">
      <div className="field-properties-header">Table Properties</div>
      <div className="field-properties-tab">General</div>
      <div className="field-properties-body">
        <EditablePropertyRow label="Description" value={tableDescription}
          onChange={v => updateTableDescription(v)} />
        <PropertyRow label="Primary Key" value={pkName} />
        <PropertyRow label="Column Count" value={String(fields.length)} />
      </div>
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

  const selectedFieldData = selectedField != null ? designFields[selectedField] : null;

  return (
    <div className="table-design-view">
      {newTable && (
        <div className="new-table-name-bar">
          <label>Table Name: </label>
          <input
            className="design-field-input"
            value={newTableName}
            onChange={e => setNewTableName(e.target.value)}
            placeholder="my_table_name"
            autoFocus
          />
        </div>
      )}

      {designErrors && (
        <div className="design-errors">
          {designErrors.map((err: { message: string }, i: number) => (
            <div key={i} className="error-item">{err.message}</div>
          ))}
        </div>
      )}

      <div className="design-upper-pane">
        <table className="structure-table">
          <thead>
            <tr>
              <th>Field Name</th>
              <th>Data Type</th>
              <th>Description</th>
              <th className="col-actions-header"></th>
            </tr>
          </thead>
          <tbody>
            {designFields.map((field: import('@/store/table').DesignField, idx: number) => (
              <tr
                key={idx}
                className={`${field.isPrimaryKey ? 'pk-row ' : ''}${selectedField === idx ? 'selected-field' : ''}`}
                onClick={() => selectDesignField(idx)}
              >
                <td className="col-name">
                  {field.isPrimaryKey && <span className="pk-icon" title="Primary Key">&#x1F511;</span>}
                  <input
                    className="design-field-input"
                    value={field.name}
                    onClick={e => { e.stopPropagation(); selectDesignField(idx); }}
                    onChange={e => updateDesignField(idx, 'name', e.target.value)}
                  />
                </td>
                <td className="col-type">
                  <select
                    className="design-type-select"
                    value={field.type}
                    onClick={e => e.stopPropagation()}
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
                <td className="col-description">
                  <input
                    className="design-field-input"
                    value={field.description || ''}
                    onClick={e => { e.stopPropagation(); selectDesignField(idx); }}
                    onChange={e => updateDesignField(idx, 'description', e.target.value)}
                  />
                </td>
                <td className="col-actions">
                  <button
                    className="delete-field-btn"
                    title="Delete field"
                    onClick={e => { e.stopPropagation(); removeDesignField(idx); }}
                  >&times;</button>
                </td>
              </tr>
            ))}
            <tr className="ghost-row" onClick={addDesignField}>
              <td colSpan={4} style={{ color: 'var(--gray-400)', cursor: 'pointer', fontStyle: 'italic' }}>
                Click to add a new field...
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="design-lower-pane">
        {selectedFieldData ? (
          <FieldPropertiesSheet field={selectedFieldData} fieldIdx={selectedField!} updateDesignField={updateDesignField} />
        ) : (
          <TablePropertiesSheet fields={designFields} tableDescription={tableDescription} updateTableDescription={updateTableDescription} />
        )}
      </div>

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
