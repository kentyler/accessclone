import { useState, useEffect, useRef, useMemo } from 'react';

export interface ColumnDropdownProps {
  column: string;
  records: Record<string, unknown>[];
  currentExcluded: unknown[];
  onSort: (col: string, dir: 'asc' | 'desc') => void;
  onSetFilter: (col: string, excludedValues: unknown[]) => void;
  onClearFilter: (col: string) => void;
  onClose: () => void;
}

export default function ColumnDropdown({
  column, records, currentExcluded, onSort, onSetFilter, onClearFilter, onClose,
}: ColumnDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Compute unique values from all records (before filtering)
  const uniqueValues = useMemo(() => {
    const seen = new Set<string>();
    const vals: unknown[] = [];
    let hasBlank = false;
    for (const rec of records) {
      const v = rec[column];
      if (v == null || v === '') {
        hasBlank = true;
      } else {
        const key = String(v);
        if (!seen.has(key)) {
          seen.add(key);
          vals.push(v);
        }
      }
    }
    vals.sort((a, b) => String(a).localeCompare(String(b)));
    return { values: vals, hasBlank };
  }, [records, column]);

  // Pending state: tracks excluded values while dropdown is open (OK/Cancel pattern)
  const [pendingExcluded, setPendingExcluded] = useState<Set<string>>(() => {
    return new Set(currentExcluded.map(v => v == null ? '__blank__' : String(v)));
  });

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, []);

  const allKeys = useMemo(() => {
    const keys: string[] = [];
    if (uniqueValues.hasBlank) keys.push('__blank__');
    for (const v of uniqueValues.values) keys.push(String(v));
    return keys;
  }, [uniqueValues]);

  const allChecked = pendingExcluded.size === 0;

  const toggleValue = (key: string) => {
    setPendingExcluded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allChecked) {
      setPendingExcluded(new Set(allKeys));
    } else {
      setPendingExcluded(new Set());
    }
  };

  const handleOk = () => {
    const excluded: unknown[] = [];
    for (const key of pendingExcluded) {
      excluded.push(key === '__blank__' ? null : key);
    }
    onSetFilter(column, excluded);
  };

  const handleCancel = () => {
    onClose();
  };

  const handleClearFilter = () => {
    onClearFilter(column);
  };

  const hasFilter = currentExcluded.length > 0;

  return (
    <div className="column-dropdown" ref={ref} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
      <div className="column-dropdown-item" onClick={() => onSort(column, 'asc')}>
        Sort A to Z
      </div>
      <div className="column-dropdown-item" onClick={() => onSort(column, 'desc')}>
        Sort Z to A
      </div>
      {hasFilter && (
        <>
          <div className="column-dropdown-separator" />
          <div className="column-dropdown-item clear-filter" onClick={handleClearFilter}>
            Clear filter from {column}
          </div>
        </>
      )}
      <div className="column-dropdown-separator" />
      <div className="column-dropdown-values">
        <label className="column-dropdown-value-row">
          <input type="checkbox" checked={allChecked} onChange={toggleAll} />
          <span>(Select All)</span>
        </label>
        {uniqueValues.hasBlank && (
          <label className="column-dropdown-value-row">
            <input
              type="checkbox"
              checked={!pendingExcluded.has('__blank__')}
              onChange={() => toggleValue('__blank__')}
            />
            <span className="blank-value">(Blanks)</span>
          </label>
        )}
        {uniqueValues.values.map((v, i) => {
          const key = String(v);
          return (
            <label key={i} className="column-dropdown-value-row">
              <input
                type="checkbox"
                checked={!pendingExcluded.has(key)}
                onChange={() => toggleValue(key)}
              />
              <span>{key}</span>
            </label>
          );
        })}
      </div>
      <div className="column-dropdown-footer">
        <button className="primary-btn" onClick={handleOk}>OK</button>
        <button className="secondary-btn" onClick={handleCancel}>Cancel</button>
      </div>
    </div>
  );
}
