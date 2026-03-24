import { useState } from 'react';
import { parseHotkeyText, extractHotkey } from '@/lib/utils';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  allControls: Control[];
  currentRecord: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
  allowEdits: boolean;
  renderControl: (ctrl: Control, record: Record<string, unknown>, onChange: (f: string, v: unknown) => void, opts: Record<string, unknown>) => React.ReactNode;
}

export default function TabControl({ ctrl, allControls, currentRecord, onChange, allowEdits, renderControl }: Props) {
  const [activeTab, setActiveTab] = useState(0);
  const pageNames: string[] = (ctrl as Record<string, unknown>).pages as string[] ?? [];
  const activePageName = pageNames[activeTab] ?? null;

  const childControls = activePageName
    ? allControls.filter(c => (c as Record<string, unknown>)['parent-page'] === activePageName)
    : [];

  return (
    <div className="view-tab-control">
      <div className="view-tab-headers">
        {pageNames.length > 0 ? (
          pageNames.map((pname, idx) => {
            const page = allControls.find(c => c.type === 'page' && c.name === pname);
            const raw = page?.caption ?? pname;
            const hk = extractHotkey(raw);
            return (
              <div
                key={idx}
                className={`view-tab-header${idx === activeTab ? ' active' : ''}`}
                onClick={() => setActiveTab(idx)}
                data-hotkey={hk || undefined}
              >
                {parseHotkeyText(raw).map((seg, i) =>
                  typeof seg === 'string' ? <span key={i}>{seg}</span> : <u key={i}>{seg.char}</u>
                )}
              </div>
            );
          })
        ) : (
          <div className="view-tab-header active">Page 1</div>
        )}
      </div>
      <div className="view-tab-body">
        {childControls.length > 0 ? (
          childControls.map((child, idx) => (
            <div key={idx}>
              {renderControl(child, currentRecord, onChange, { allowEdits, allControls })}
            </div>
          ))
        ) : (
          !pageNames.length && <span>(Empty tab control)</span>
        )}
      </div>
    </div>
  );
}
