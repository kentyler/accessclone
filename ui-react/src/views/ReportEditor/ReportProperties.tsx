import { useReportStore } from '@/store/report';
import { useUiStore } from '@/store/ui';
import type { ReportDefinition, Section, Control, GroupLevel } from '@/api/types';

// ============================================================
// Event flag map
// ============================================================

const EVENT_FLAG_KEYS: Record<string, string> = {
  'on-open': 'has-open-event',
  'on-close': 'has-close-event',
  'on-activate': 'has-activate-event',
  'on-deactivate': 'has-deactivate-event',
  'on-no-data': 'has-no-data-event',
  'on-page': 'has-page-event',
  'on-error': 'has-error-event',
  'on-format': 'has-format-event',
  'on-print': 'has-print-event',
  'on-retreat': 'has-retreat-event',
  'on-click': 'has-click-event',
  'on-dbl-click': 'has-dbl-click-event',
  'on-mouse-down': 'has-mouse-down-event',
  'on-mouse-move': 'has-mouse-move-event',
  'on-mouse-up': 'has-mouse-up-event',
};

function resolveEventValue(obj: Record<string, unknown>, key: string): string {
  const direct = obj[key];
  if (direct) return String(direct);
  const flagKey = EVENT_FLAG_KEYS[key];
  if (flagKey && obj[flagKey]) return '[Event Procedure]';
  return '';
}

// ============================================================
// Property definitions
// ============================================================

interface PropDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'yes-no' | 'select' | 'table-select' | 'field-select' | 'picture' | 'event' | 'color';
  options?: string[];
  category: 'format' | 'data' | 'event' | 'other';
}

const REPORT_PROPS: PropDef[] = [
  // Format
  { key: 'caption', label: 'Caption', type: 'text', category: 'format' },
  { key: 'width', label: 'Width', type: 'number', category: 'format' },
  { key: 'page-height', label: 'Page Height', type: 'number', category: 'format' },
  { key: 'page-width', label: 'Page Width', type: 'number', category: 'format' },
  { key: 'report-width', label: 'Report Width', type: 'number', category: 'format' },
  { key: 'margin-top', label: 'Top Margin', type: 'number', category: 'format' },
  { key: 'margin-bottom', label: 'Bottom Margin', type: 'number', category: 'format' },
  { key: 'margin-left', label: 'Left Margin', type: 'number', category: 'format' },
  { key: 'margin-right', label: 'Right Margin', type: 'number', category: 'format' },
  { key: 'page-header-setting', label: 'Page Header', type: 'select', options: ['All Pages', 'Not With Rpt Hdr', 'Not With Rpt Ftr', 'Not With Rpt Hdr/Ftr'], category: 'format' },
  { key: 'page-footer-setting', label: 'Page Footer', type: 'select', options: ['All Pages', 'Not With Rpt Hdr', 'Not With Rpt Ftr', 'Not With Rpt Hdr/Ftr'], category: 'format' },
  // Data
  { key: 'record-source', label: 'Record Source', type: 'table-select', category: 'data' },
  { key: 'filter', label: 'Filter', type: 'text', category: 'data' },
  { key: 'filter-on', label: 'Filter On', type: 'yes-no', category: 'data' },
  { key: 'order-by', label: 'Order By', type: 'text', category: 'data' },
  { key: 'order-by-on', label: 'Order By On', type: 'yes-no', category: 'data' },
  // Event
  { key: 'on-open', label: 'On Open', type: 'event', category: 'event' },
  { key: 'on-close', label: 'On Close', type: 'event', category: 'event' },
  { key: 'on-activate', label: 'On Activate', type: 'event', category: 'event' },
  { key: 'on-deactivate', label: 'On Deactivate', type: 'event', category: 'event' },
  { key: 'on-no-data', label: 'On No Data', type: 'event', category: 'event' },
  { key: 'on-error', label: 'On Error', type: 'event', category: 'event' },
  { key: 'on-page', label: 'On Page', type: 'event', category: 'event' },
  // Other
  { key: 'name', label: 'Name', type: 'text', category: 'other' },
  { key: 'tag', label: 'Tag', type: 'text', category: 'other' },
];

const SECTION_PROPS: PropDef[] = [
  { key: 'height', label: 'Height', type: 'number', category: 'format' },
  { key: 'visible', label: 'Visible', type: 'yes-no', category: 'format' },
  { key: 'back-color', label: 'Back Color', type: 'color', category: 'format' },
  { key: 'can-grow', label: 'Can Grow', type: 'yes-no', category: 'format' },
  { key: 'can-shrink', label: 'Can Shrink', type: 'yes-no', category: 'format' },
  { key: 'keep-together', label: 'Keep Together', type: 'yes-no', category: 'format' },
  { key: 'force-new-page', label: 'Force New Page', type: 'select', options: ['None', 'Before Section', 'After Section', 'Before & After'], category: 'format' },
  { key: 'picture', label: 'Picture', type: 'picture', category: 'format' },
  { key: 'picture-size-mode', label: 'Size Mode', type: 'select', options: ['clip', 'stretch', 'zoom'], category: 'format' },
  // Event
  { key: 'on-format', label: 'On Format', type: 'event', category: 'event' },
  { key: 'on-print', label: 'On Print', type: 'event', category: 'event' },
  { key: 'on-retreat', label: 'On Retreat', type: 'event', category: 'event' },
  // Other
  { key: 'name', label: 'Name', type: 'text', category: 'other' },
];

const GROUP_PROPS: PropDef[] = [
  { key: 'field', label: 'Field/Expression', type: 'field-select', category: 'data' },
  { key: 'sort-order', label: 'Sort Order', type: 'select', options: ['Ascending', 'Descending'], category: 'data' },
  { key: 'group-on', label: 'Group On', type: 'select', options: ['Each Value', 'Prefix', 'Interval', 'Year', 'Quarter', 'Month', 'Week', 'Day', 'Hour', 'Minute'], category: 'data' },
  { key: 'group-interval', label: 'Group Interval', type: 'number', category: 'data' },
  { key: 'group-header', label: 'Group Header', type: 'yes-no', category: 'data' },
  { key: 'group-footer', label: 'Group Footer', type: 'yes-no', category: 'data' },
  { key: 'keep-together', label: 'Keep Together', type: 'select', options: ['No', 'Whole Group', 'With First Detail'], category: 'data' },
];

const CONTROL_PROPS: PropDef[] = [
  // Format
  { key: 'left', label: 'Left', type: 'number', category: 'format' },
  { key: 'top', label: 'Top', type: 'number', category: 'format' },
  { key: 'width', label: 'Width', type: 'number', category: 'format' },
  { key: 'height', label: 'Height', type: 'number', category: 'format' },
  { key: 'visible', label: 'Visible', type: 'yes-no', category: 'format' },
  { key: 'fore-color', label: 'Fore Color', type: 'color', category: 'format' },
  { key: 'back-color', label: 'Back Color', type: 'color', category: 'format' },
  { key: 'back-style', label: 'Back Style', type: 'select', options: ['0', '1'], category: 'format' },
  { key: 'border-style', label: 'Border Style', type: 'select', options: ['0', '1', '2'], category: 'format' },
  { key: 'border-color', label: 'Border Color', type: 'color', category: 'format' },
  { key: 'font-name', label: 'Font Name', type: 'text', category: 'format' },
  { key: 'font-size', label: 'Font Size', type: 'number', category: 'format' },
  { key: 'font-weight', label: 'Font Weight', type: 'number', category: 'format' },
  { key: 'font-italic', label: 'Font Italic', type: 'yes-no', category: 'format' },
  { key: 'font-underline', label: 'Font Underline', type: 'yes-no', category: 'format' },
  { key: 'text-align', label: 'Text Align', type: 'select', options: ['General', 'Left', 'Center', 'Right'], category: 'format' },
  { key: 'can-grow', label: 'Can Grow', type: 'yes-no', category: 'format' },
  { key: 'can-shrink', label: 'Can Shrink', type: 'yes-no', category: 'format' },
  { key: 'caption', label: 'Caption', type: 'text', category: 'format' },
  // Data
  { key: 'control-source', label: 'Control Source', type: 'field-select', category: 'data' },
  { key: 'running-sum', label: 'Running Sum', type: 'select', options: ['No', 'Over Group', 'Over All'], category: 'data' },
  // Event
  { key: 'on-click', label: 'On Click', type: 'event', category: 'event' },
  { key: 'on-dbl-click', label: 'On Dbl Click', type: 'event', category: 'event' },
  { key: 'on-format', label: 'On Format', type: 'event', category: 'event' },
  { key: 'on-print', label: 'On Print', type: 'event', category: 'event' },
  // Other
  { key: 'name', label: 'Name', type: 'text', category: 'other' },
  { key: 'type', label: 'Control Type', type: 'text', category: 'other' },
  { key: 'tag', label: 'Tag', type: 'text', category: 'other' },
];

// ============================================================
// Property input widget
// ============================================================

function PropertyInput({ prop, value, onChange }: {
  prop: PropDef;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const tables = useUiStore(s => s.objects.tables);
  const queries = useUiStore(s => s.objects.queries);

  switch (prop.type) {
    case 'text':
      return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" value={value != null ? Number(value) : ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : undefined)} />;
    case 'yes-no':
      return (
        <select value={value != null ? Number(value) : 1} onChange={e => onChange(Number(e.target.value))}>
          <option value={1}>Yes</option>
          <option value={0}>No</option>
        </select>
      );
    case 'select':
      return (
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {(prop.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'table-select':
      return (
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
          {queries.map(q => <option key={q.name} value={q.name}>{q.name}</option>)}
        </select>
      );
    case 'field-select':
      // Simple text input for now (could be enhanced with column list)
      return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)} />;
    case 'color':
      return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value ? Number(e.target.value) : undefined)} />;
    case 'picture':
      return <input type="text" value={String(value ?? '')} readOnly />;
    case 'event':
      return <input type="text" value={String(value ?? '')} readOnly />;
    default:
      return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)} />;
  }
}

// ============================================================
// Property rows
// ============================================================

function PropertyRows({ props, getValue, onChange, tab }: {
  props: PropDef[];
  getValue: (key: string) => unknown;
  onChange: (key: string, value: unknown) => void;
  tab: string;
}) {
  const filtered = tab === 'all' ? props : props.filter(p => p.category === tab);
  if (filtered.length === 0) return <div style={{ padding: 8, color: '#999' }}>No properties</div>;

  return (
    <div className="properties-grid">
      {filtered.map(prop => (
        <div key={prop.key} className="property-row">
          <label className="property-label">{prop.label}</label>
          <div className="property-value">
            <PropertyInput prop={prop} value={getValue(prop.key)} onChange={v => onChange(prop.key, v)} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Grouping section
// ============================================================

function GroupingSection({ groupIdx, grouping, onChange }: {
  groupIdx: number;
  grouping: GroupLevel[];
  onChange: (key: string, value: unknown) => void;
}) {
  const group = grouping[groupIdx];
  if (!group) return null;

  return (
    <div className="grouping-section">
      <div className="grouping-header">Grouping (Level {groupIdx})</div>
      <div className="properties-grid">
        {GROUP_PROPS.map(prop => (
          <div key={prop.key} className="property-row">
            <label className="property-label">{prop.label}</label>
            <div className="property-value">
              <PropertyInput
                prop={prop}
                value={(group as Record<string, unknown>)[prop.key]}
                onChange={v => onChange(prop.key, v)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main properties panel
// ============================================================

export default function ReportProperties() {
  const store = useReportStore();
  const current = store.current;
  const selected = store.selectedControl;
  const tab = store.propertiesTab || 'format';

  if (!current) return null;

  // Determine selection type
  const isControl = selected != null && selected.idx != null;
  const isSection = selected != null && selected.idx == null;
  const isReport = selected == null;
  const sectionKey = selected?.section;

  // Group index (if group band selected)
  let groupIdx = -1;
  if (sectionKey) {
    const m = sectionKey.match(/^group-(header|footer)-(\d+)$/);
    if (m) groupIdx = parseInt(m[2], 10);
  }

  // Title
  let title = 'Report';
  if (isControl && sectionKey) {
    const sec = (current as Record<string, unknown>)[sectionKey] as Section | undefined;
    const ctrl = sec?.controls?.[selected.idx!];
    title = ctrl?.name || `Control ${selected.idx}`;
  } else if (isSection && sectionKey) {
    const m = sectionKey.match(/^group-(header|footer)-(\d+)$/);
    title = m ? `Group ${m[1]} ${m[2]}` : sectionKey.replace(/-/g, ' ');
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  // Get/set value helpers
  let props: PropDef[];
  let getValue: (key: string) => unknown;
  let onChange: (key: string, value: unknown) => void;

  if (isControl && sectionKey) {
    props = CONTROL_PROPS;
    const sec = (current as Record<string, unknown>)[sectionKey] as Section | undefined;
    const ctrl = sec?.controls?.[selected.idx!];
    getValue = (key) => {
      if (!ctrl) return undefined;
      if (EVENT_FLAG_KEYS[key]) return resolveEventValue(ctrl as Record<string, unknown>, key);
      return (ctrl as Record<string, unknown>)[key];
    };
    onChange = (key, value) => {
      store.updateControl(sectionKey, selected.idx!, key, value);
    };
  } else if (isSection && sectionKey) {
    props = SECTION_PROPS;
    const sec = (current as Record<string, unknown>)[sectionKey] as Section | undefined;
    getValue = (key) => {
      if (!sec) return undefined;
      if (EVENT_FLAG_KEYS[key]) return resolveEventValue(sec as Record<string, unknown>, key);
      return (sec as Record<string, unknown>)[key];
    };
    onChange = (key, value) => {
      const newDef = { ...current } as Record<string, unknown>;
      const section = { ...((newDef[sectionKey] as Record<string, unknown>) ?? {}) };
      (section as Record<string, unknown>)[key] = value;
      newDef[sectionKey] = section;
      store.setReportDefinition(newDef as unknown as ReportDefinition);
    };
  } else {
    props = REPORT_PROPS;
    getValue = (key) => {
      if (EVENT_FLAG_KEYS[key]) return resolveEventValue(current as Record<string, unknown>, key);
      return (current as Record<string, unknown>)[key];
    };
    onChange = (key, value) => {
      const newDef = { ...current, [key]: value } as ReportDefinition;
      store.setReportDefinition(newDef);
    };
  }

  // Group onChange
  const onGroupChange = (key: string, value: unknown) => {
    if (groupIdx < 0 || !current.grouping) return;
    const newGrouping = [...current.grouping];
    newGrouping[groupIdx] = { ...newGrouping[groupIdx], [key]: value };
    store.setReportDefinition({ ...current, grouping: newGrouping });
  };

  const tabs = ['format', 'data', 'event', 'other', 'all'];

  return (
    <div className="form-properties">
      <div className="properties-selection">{title}</div>
      <div className="properties-tabs">
        {tabs.map(t => (
          <button
            key={t}
            className={`properties-tab${tab === t ? ' active' : ''}`}
            onClick={() => store.setPropertiesTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="properties-body" style={{ overflowY: 'auto', flex: 1 }}>
        <PropertyRows props={props} getValue={getValue} onChange={onChange} tab={tab} />
        {groupIdx >= 0 && current.grouping && (tab === 'data' || tab === 'all') && (
          <GroupingSection groupIdx={groupIdx} grouping={current.grouping} onChange={onGroupChange} />
        )}
      </div>
    </div>
  );
}
