import { useState, useEffect, useCallback } from 'react';
import { useFormStore } from '@/store/form';
import type { Control, FormDefinition } from '@/api/types';

interface Props {
  ctrl: Control;
  currentRecord: Record<string, unknown>;
}

interface SubformColumn {
  field: string;
  caption: string;
  type: string;
  locked?: boolean;
  'row-source'?: string;
  'bound-column'?: number;
  'column-widths'?: string;
}

function normalizeSourceForm(s: string | undefined): string | undefined {
  return s ? s.replace(/^[Ff][Oo][Rr][Mm]\./, '') : undefined;
}

function splitLinkFields(v: unknown): string[] | null {
  if (!v) return null;
  if (typeof v === 'string') return v.split(';').map(s => s.trim());
  if (Array.isArray(v)) return v.flatMap(item =>
    typeof item === 'string' ? item.split(';').map(s => s.trim()) : [String(item)]
  );
  return null;
}

function extractSubformColumns(definition: FormDefinition | null): SubformColumn[] {
  if (!definition) return [];
  const detailCtrls = definition.detail?.controls ?? [];
  const headerLabels = (definition.header?.controls ?? [])
    .filter(c => c.type === 'label');

  // Build bound controls
  const bound = detailCtrls
    .filter(c => (c['control-source'] || c.field) && (c.visible ?? 1) !== 0)
    .sort((a, b) => (((a as Record<string, unknown>)['tab-index'] as number) ?? 999) - (((b as Record<string, unknown>)['tab-index'] as number) ?? 999) || ((a.x ?? 0) as number) - ((b.x ?? 0) as number));

  return bound.map(c => {
    const cs = c['control-source'] as string | undefined;
    const fieldName = cs?.startsWith('=')
      ? `_calc_${(c.name || 'expr').toLowerCase()}`
      : (cs || c.field || '').toLowerCase();

    // Match header label by x proximity
    const ctrlX = (c.x ?? 0) as number;
    let headerText: string | undefined;
    if (headerLabels.length > 0) {
      const best = headerLabels.reduce((prev, curr) =>
        Math.abs(((curr.x ?? 0) as number) - ctrlX) < Math.abs(((prev.x ?? 0) as number) - ctrlX) ? curr : prev
      );
      if (Math.abs(((best.x ?? 0) as number) - ctrlX) <= 20) {
        headerText = (best as Record<string, unknown>).text as string || best.caption;
      }
    }

    const col: SubformColumn = {
      field: fieldName,
      caption: headerText || c.caption || c.name || cs || c.field || '',
      type: c.type || 'text-box',
    };

    if (c['row-source']) col['row-source'] = c['row-source'] as string;
    if (c['bound-column']) col['bound-column'] = c['bound-column'] as number;
    if (c['column-widths']) col['column-widths'] = c['column-widths'] as string;
    if (cs?.startsWith('=') || c.locked) col.locked = true;

    return col;
  });
}

export default function SubFormControl({ ctrl, currentRecord }: Props) {
  const sourceForm = normalizeSourceForm(
    (ctrl as Record<string, unknown>)['source-form'] as string ??
    (ctrl as Record<string, unknown>)['source_form'] as string
  );
  const linkChild = splitLinkFields((ctrl as Record<string, unknown>)['link-child-fields'] ?? (ctrl as Record<string, unknown>)['link_child_fields']);
  const linkMaster = splitLinkFields((ctrl as Record<string, unknown>)['link-master-fields'] ?? (ctrl as Record<string, unknown>)['link_master_fields']);

  const fetchSubformDef = useFormStore(s => s.fetchSubformDefinition);
  const fetchSubformRecords = useFormStore(s => s.fetchSubformRecords);
  const saveSubformCell = useFormStore(s => s.saveSubformCell);
  const newSubformRecord = useFormStore(s => s.newSubformRecord);
  const deleteSubformRecord = useFormStore(s => s.deleteSubformRecord);
  const subformCache = useFormStore(s => s.subformCache);

  const [selected, setSelected] = useState<{ row: number; col: string } | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    if (sourceForm) fetchSubformDef(sourceForm);
  }, [sourceForm]);

  const cached = sourceForm ? subformCache[sourceForm] : undefined;
  const definition = cached?.definition as FormDefinition | null ?? null;
  const records = (cached?.records as Record<string, unknown>[] | undefined) ?? [];

  const childRs = definition?.['record-source'] || (definition as Record<string, unknown> | null)?.['record_source'] as string | undefined;

  useEffect(() => {
    if (sourceForm && childRs) {
      fetchSubformRecords(
        sourceForm, childRs,
        (linkChild ?? []).join(';'),
        (linkMaster ?? []).join(';'),
        currentRecord
      );
    }
  }, [sourceForm, childRs, currentRecord]);

  const cols = extractSubformColumns(definition);
  const allowEdits = definition ? (definition['allow-edits'] ?? 1) !== 0 : false;
  const allowAdditions = definition ? (definition['allow-additions'] ?? 1) !== 0 : false;
  const allowDeletions = definition ? (definition['allow-deletions'] ?? 1) !== 0 : false;
  const showNav = definition ? (definition['navigation-buttons'] ?? 1) !== 0 : false;

  const commitEdit = useCallback(() => {
    if (!editing || !sourceForm) return;
    const { row, col } = editing;
    if (typeof row === 'number') {
      const oldVal = String(records[row]?.[col] ?? '');
      if (oldVal !== editValue) {
        saveSubformCell(sourceForm, row, col, editValue);
      }
    }
    setEditing(null);
  }, [editing, editValue, sourceForm, records, saveSubformCell]);

  const commitNewRow = useCallback((colName: string, colValue: string) => {
    setEditing(null);
    if (!colValue.trim() || !sourceForm) return;
    newSubformRecord(sourceForm, (linkChild ?? []).join(';'), (linkMaster ?? []).join(';'));
  }, [sourceForm, linkChild, linkMaster, currentRecord, newSubformRecord]);

  if (!sourceForm) return <div className="view-subform"><span>Subform (no source)</span></div>;
  if (!cached || !definition) return <div className="view-subform"><span className="subform-loading">Loading...</span></div>;

  const total = records.length;
  const curIdx = selected?.row ?? -1;

  return (
    <div className="view-subform">
      {/* Header section if present */}
      {definition.header && (definition.header.controls?.length ?? 0) > 0 && (
        <div className="view-section header">
          <div className="view-controls-container">
            {/* Simple header render — labels only */}
          </div>
        </div>
      )}

      {/* Datasheet */}
      {cols.length > 0 && (records.length > 0 || allowAdditions) ? (
        <div className="subform-datasheet">
          <table className="subform-table">
            <thead>
              <tr>
                {cols.map((col, i) => <th key={i}>{col.caption}</th>)}
              </tr>
            </thead>
            <tbody>
              {records.map((rec, idx) => (
                <tr
                  key={idx}
                  className={selected?.row === idx ? 'selected-row' : ''}
                  onClick={() => { commitEdit(); setSelected({ row: idx, col: cols[0]?.field ?? '' }); }}
                >
                  {cols.map((col, ci) => {
                    const isEditing = editing?.row === idx && editing?.col === col.field;
                    const rawVal = rec[col.field] ?? '';
                    return (
                      <td
                        key={ci}
                        className={`${selected?.row === idx && selected?.col === col.field ? 'selected' : ''} ${isEditing ? 'editing' : ''}`}
                        onDoubleClick={e => {
                          e.stopPropagation();
                          if (allowEdits && !col.locked) {
                            setSelected({ row: idx, col: col.field });
                            setEditing({ row: idx, col: col.field });
                            setEditValue(String(rawVal));
                          }
                        }}
                      >
                        {isEditing ? (
                          <input
                            className="subform-cell-input"
                            type="text"
                            autoFocus
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={() => commitEdit()}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEdit();
                              else if (e.key === 'Escape') setEditing(null);
                            }}
                          />
                        ) : (
                          String(rawVal)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {allowAdditions && (
                <tr className="new-record-row">
                  {cols.map((col, ci) => (
                    <td
                      key={ci}
                      className="new-row-cell"
                      onClick={() => {
                        if (!col.locked) {
                          setSelected({ row: -1, col: col.field });
                          setEditing({ row: -1, col: col.field });
                          setEditValue('');
                        }
                      }}
                    >
                      {editing?.row === -1 && editing?.col === col.field ? (
                        <input
                          className="subform-cell-input"
                          type="text"
                          autoFocus
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={() => commitNewRow(col.field, editValue)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitNewRow(col.field, editValue);
                            else if (e.key === 'Escape') { setEditing(null); setSelected(null); }
                          }}
                        />
                      ) : ''}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : records.length === 0 && !allowAdditions ? (
        <div className="subform-datasheet"><span className="subform-loading">(No records)</span></div>
      ) : (
        <div className="subform-datasheet"><span className="subform-loading">Loading...</span></div>
      )}

      {/* Nav bar */}
      {showNav && (
        <div className="subform-nav-bar">
          <span className="nav-label">Record:</span>
          <button className="nav-btn" disabled={total < 1 || curIdx <= 0} onClick={() => setSelected({ row: 0, col: selected?.col ?? '' })}>|&#9664;</button>
          <button className="nav-btn" disabled={total < 1 || curIdx <= 0} onClick={() => setSelected({ row: Math.max(0, curIdx - 1), col: selected?.col ?? '' })}>&#9664;</button>
          <span className="record-counter">{curIdx >= 0 ? `${curIdx + 1} of ${total}` : `0 of ${total}`}</span>
          <button className="nav-btn" disabled={total < 1 || curIdx >= total - 1} onClick={() => setSelected({ row: Math.min(total - 1, curIdx + 1), col: selected?.col ?? '' })}>&#9654;</button>
          <button className="nav-btn" disabled={total < 1 || curIdx >= total - 1} onClick={() => setSelected({ row: total - 1, col: selected?.col ?? '' })}>&#9654;|</button>
          {allowAdditions && (
            <button className="nav-btn" onClick={() => setSelected({ row: -1, col: cols[0]?.field ?? '' })}>&#9654;*</button>
          )}
          {allowDeletions && (
            <button className="nav-btn delete-btn" disabled={curIdx < 0} onClick={() => {
              if (curIdx >= 0 && sourceForm && confirm('Delete this record?')) {
                deleteSubformRecord(sourceForm, curIdx);
                setSelected(null);
                setEditing(null);
              }
            }}>&#10005;</button>
          )}
        </div>
      )}
    </div>
  );
}
