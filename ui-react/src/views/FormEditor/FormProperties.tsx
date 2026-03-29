import { useMemo } from 'react';
import { useFormStore } from '@/store/form';
import { useUiStore } from '@/store/ui';
import type { Control, FormDefinition } from '@/api/types';

// ============================================================
// Property definitions
// ============================================================

interface PropDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'yes-no' | 'select' | 'table-select' | 'field-select' | 'picture' | 'event' | 'color';
  options?: Array<{ value: string | number; label: string }>;
}

const YES_NO: PropDef['options'] = [
  { value: 1, label: 'Yes' },
  { value: 0, label: 'No' },
];

const controlPropertyDefs: Record<string, PropDef[]> = {
  format: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'caption', label: 'Caption', type: 'text' },
    { key: 'visible', label: 'Visible', type: 'yes-no' },
    { key: 'width', label: 'Width', type: 'number' },
    { key: 'height', label: 'Height', type: 'number' },
    { key: 'x', label: 'Left', type: 'number' },
    { key: 'y', label: 'Top', type: 'number' },
    { key: 'back-color', label: 'Back Color', type: 'color' },
    { key: 'fore-color', label: 'Fore Color', type: 'color' },
    { key: 'font-name', label: 'Font Name', type: 'text' },
    { key: 'font-size', label: 'Font Size', type: 'number' },
    { key: 'font-bold', label: 'Font Bold', type: 'yes-no' },
    { key: 'font-italic', label: 'Font Italic', type: 'yes-no' },
    { key: 'text-align', label: 'Text Align', type: 'select', options: [
      { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' },
    ]},
  ],
  data: [
    { key: 'control-source', label: 'Control Source', type: 'field-select' },
    { key: 'input-mask', label: 'Input Mask', type: 'text' },
    { key: 'default-value', label: 'Default Value', type: 'text' },
    { key: 'enabled', label: 'Enabled', type: 'yes-no' },
    { key: 'locked', label: 'Locked', type: 'yes-no' },
  ],
  event: [
    { key: 'on-click', label: 'On Click', type: 'event' },
    { key: 'on-dbl-click', label: 'On Dbl Click', type: 'event' },
    { key: 'on-change', label: 'On Change', type: 'event' },
    { key: 'on-got-focus', label: 'On Got Focus', type: 'event' },
    { key: 'on-lost-focus', label: 'On Lost Focus', type: 'event' },
    { key: 'on-enter', label: 'On Enter', type: 'event' },
    { key: 'on-exit', label: 'On Exit', type: 'event' },
  ],
  other: [
    { key: 'tab-index', label: 'Tab Index', type: 'number' },
    { key: 'tab-stop', label: 'Tab Stop', type: 'yes-no' },
    { key: 'control-tip-text', label: 'Control Tip Text', type: 'text' },
    { key: 'tag', label: 'Tag', type: 'text' },
  ],
};

const sectionPropertyDefs: Record<string, PropDef[]> = {
  format: [
    { key: 'height', label: 'Height', type: 'number' },
    { key: 'back-color', label: 'Back Color', type: 'color' },
    { key: 'visible', label: 'Visible', type: 'yes-no' },
  ],
  event: [{ key: 'on-click', label: 'On Click', type: 'event' }],
  other: [{ key: 'tag', label: 'Tag', type: 'text' }],
};

const formPropertyDefs: Record<string, PropDef[]> = {
  format: [
    { key: 'caption', label: 'Caption', type: 'text' },
    { key: 'default-view', label: 'Default View', type: 'select', options: [
      { value: 'Single Form', label: 'Single Form' }, { value: 'Continuous Forms', label: 'Continuous Forms' },
    ]},
    { key: 'scroll-bars', label: 'Scroll Bars', type: 'select', options: [
      { value: 'both', label: 'Both' }, { value: 'neither', label: 'Neither' },
      { value: 'horizontal', label: 'Horizontal Only' }, { value: 'vertical', label: 'Vertical Only' },
    ]},
    { key: 'record-selectors', label: 'Record Selectors', type: 'yes-no' },
    { key: 'navigation-buttons', label: 'Navigation Buttons', type: 'yes-no' },
    { key: 'dividing-lines', label: 'Dividing Lines', type: 'yes-no' },
    { key: 'width', label: 'Width', type: 'number' },
  ],
  data: [
    { key: 'record-source', label: 'Record Source', type: 'table-select' },
    { key: 'filter', label: 'Filter', type: 'text' },
    { key: 'order-by', label: 'Order By', type: 'text' },
    { key: 'allow-edits', label: 'Allow Edits', type: 'yes-no' },
    { key: 'allow-deletions', label: 'Allow Deletions', type: 'yes-no' },
    { key: 'allow-additions', label: 'Allow Additions', type: 'yes-no' },
    { key: 'data-entry', label: 'Data Entry', type: 'yes-no' },
  ],
  event: [
    { key: 'on-load', label: 'On Load', type: 'event' },
    { key: 'on-open', label: 'On Open', type: 'event' },
    { key: 'on-close', label: 'On Close', type: 'event' },
    { key: 'on-current', label: 'On Current', type: 'event' },
  ],
  other: [
    { key: 'popup', label: 'Popup', type: 'yes-no' },
    { key: 'modal', label: 'Modal', type: 'yes-no' },
    { key: 'tag', label: 'Tag', type: 'text' },
  ],
};

// Type-specific property merges
const IMAGE_PROPS: PropDef[] = [
  { key: 'picture', label: 'Picture', type: 'picture' },
  { key: 'size-mode', label: 'Size Mode', type: 'select', options: [
    { value: 'clip', label: 'Clip' }, { value: 'stretch', label: 'Stretch' },
    { value: 'zoom', label: 'Zoom' }, { value: 'cover', label: 'Cover' },
  ]},
];

const COMBO_PROPS: PropDef[] = [
  { key: 'row-source', label: 'Row Source', type: 'text' },
  { key: 'row-source-type', label: 'Row Source Type', type: 'select', options: [
    { value: 'Table/Query', label: 'Table/Query' }, { value: 'Value List', label: 'Value List' },
  ]},
  { key: 'bound-column', label: 'Bound Column', type: 'number' },
  { key: 'column-count', label: 'Column Count', type: 'number' },
  { key: 'column-widths', label: 'Column Widths', type: 'text' },
];

const SUBFORM_PROPS: PropDef[] = [
  { key: 'source-form', label: 'Source Object', type: 'text' },
  { key: 'link-master-fields', label: 'Link Master Fields', type: 'text' },
  { key: 'link-child-fields', label: 'Link Child Fields', type: 'text' },
];

// ============================================================
// Event flag resolution
// ============================================================

const EVENT_FLAG_KEYS: Record<string, string> = {
  'on-click': 'has-click-event',
  'on-dbl-click': 'has-dblclick-event',
  'on-change': 'has-change-event',
  'on-got-focus': 'has-gotfocus-event',
  'on-lost-focus': 'has-lostfocus-event',
  'on-enter': 'has-enter-event',
  'on-exit': 'has-exit-event',
  'on-load': 'has-load-event',
  'on-open': 'has-open-event',
  'on-close': 'has-close-event',
  'on-current': 'has-current-event',
};

function resolveEventValue(obj: Record<string, unknown>, key: string): string {
  if (obj[key] === '[Event Procedure]') return '[Event Procedure]';
  const flagKey = EVENT_FLAG_KEYS[key];
  if (flagKey && obj[flagKey]) return '[Event Procedure]';
  return '';
}

// ============================================================
// Property input
// ============================================================

function PropertyInput({
  def, value, onChange, tables, queries, recordSourceFields
}: {
  def: PropDef;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  tables: Array<{ name: string }>;
  queries: Array<{ name: string }>;
  recordSourceFields: Array<{ name: string }>;
}) {
  switch (def.type) {
    case 'text':
      return (
        <input
          className="property-input"
          type="text"
          value={String(value ?? '')}
          onChange={e => onChange(def.key, e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          className="property-input"
          type="number"
          value={value == null ? '' : Number(value)}
          onChange={e => onChange(def.key, e.target.value ? parseInt(e.target.value, 10) : null)}
        />
      );
    case 'color':
      return (
        <input
          className="property-input"
          type="text"
          value={String(value ?? '')}
          onChange={e => onChange(def.key, e.target.value)}
          placeholder="#RRGGBB"
        />
      );
    case 'yes-no':
      return (
        <select
          className="property-input"
          value={value == null ? '' : Number(value)}
          onChange={e => onChange(def.key, parseInt(e.target.value, 10))}
        >
          <option value="">—</option>
          <option value={1}>Yes</option>
          <option value={0}>No</option>
        </select>
      );
    case 'select':
      return (
        <select
          className="property-input"
          value={String(value ?? '')}
          onChange={e => onChange(def.key, e.target.value)}
        >
          <option value="">—</option>
          {def.options?.map(opt => (
            <option key={String(opt.value)} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );
    case 'table-select':
      return (
        <select
          className="property-input"
          value={String(value ?? '')}
          onChange={e => onChange(def.key, e.target.value)}
        >
          <option value="">—</option>
          {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
          {queries.map(q => <option key={q.name} value={q.name}>{q.name}</option>)}
        </select>
      );
    case 'field-select':
      return (
        <select
          className="property-input"
          value={String(value ?? '')}
          onChange={e => onChange(def.key, e.target.value)}
        >
          <option value="">—</option>
          {recordSourceFields.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
      );
    case 'picture': {
      const isEmbedded = typeof value === 'string' && value.startsWith('data:');
      return (
        <div className="picture-input">
          {isEmbedded && <img className="picture-thumbnail" src={value as string} alt="thumbnail" />}
          <input className="property-input" type="text" readOnly value={isEmbedded ? '(embedded image)' : String(value ?? '')} />
        </div>
      );
    }
    case 'event':
      return (
        <div className="event-input-row">
          <input className="property-input" type="text" readOnly value={String(value ?? '')} />
        </div>
      );
    default:
      return <input className="property-input" type="text" value={String(value ?? '')} onChange={e => onChange(def.key, e.target.value)} />;
  }
}

// ============================================================
// Properties panel
// ============================================================

export default function FormProperties() {
  const store = useFormStore();
  const tables = useUiStore(s => s.objects.tables);
  const queries = useUiStore(s => s.objects.queries);

  const { current, selectedControl, selectedSection, propertiesTab } = store;

  // Record source fields for field-select (must be before any conditional returns — Rules of Hooks)
  const recordSource = current ? (current as Record<string, unknown>)['record-source'] as string | undefined : undefined;
  const recordSourceFields: Array<{ name: string }> = useMemo(() => {
    if (!recordSource) return [];
    const rsLower = recordSource.toLowerCase();
    const table = tables.find(t => t.name.toLowerCase() === rsLower);
    if (table) return table.fields?.map(f => ({ name: f.name })) ?? [];
    const query = queries.find(q => q.name.toLowerCase() === rsLower);
    if (query) return query.fields?.map(f => ({ name: f.name })) ?? [];
    return [];
  }, [recordSource, tables, queries]);

  if (!current) return null;

  // Determine what we're editing
  let selectionLabel: string;
  let propertyDefs: Record<string, PropDef[]>;
  let target: Record<string, unknown>;
  let onPropertyChange: (key: string, value: unknown) => void;

  if (selectedControl != null) {
    // Control selected
    const section = selectedSection || 'detail';
    const controls = (current as Record<string, unknown>)[section] as Record<string, unknown> | undefined;
    const ctrls = (controls?.controls as Control[] | undefined) ?? [];
    const ctrl = ctrls[selectedControl];
    if (!ctrl) return null;

    selectionLabel = `${ctrl.type}: ${ctrl.name || '(unnamed)'}`;
    target = ctrl as unknown as Record<string, unknown>;
    propertyDefs = { ...controlPropertyDefs };

    // Type-specific merges
    const ctrlType = ctrl.type;
    if (ctrlType === 'image' || ctrlType === 'object-frame') {
      propertyDefs.data = [...(propertyDefs.data || []), ...IMAGE_PROPS];
    }
    if (ctrlType === 'combo-box' || ctrlType === 'list-box') {
      propertyDefs.data = [...(propertyDefs.data || []), ...COMBO_PROPS];
    }
    if (ctrlType === 'subform' || ctrlType === 'sub-form') {
      propertyDefs.data = [...(propertyDefs.data || []), ...SUBFORM_PROPS];
    }

    onPropertyChange = (key, value) => {
      store.updateControl(section, selectedControl, key, value);
    };
  } else if (selectedSection && selectedSection !== 'form') {
    // Section selected
    selectionLabel = `Section: ${selectedSection}`;
    target = ((current as Record<string, unknown>)[selectedSection] ?? {}) as Record<string, unknown>;
    propertyDefs = sectionPropertyDefs;
    onPropertyChange = (key, value) => {
      const newDef = { ...current } as Record<string, unknown>;
      const sec = { ...(newDef[selectedSection] as Record<string, unknown> ?? {}) };
      sec[key] = value;
      newDef[selectedSection] = sec;
      store.setFormDefinition(newDef as unknown as FormDefinition);
    };
  } else {
    // Form-level
    selectionLabel = 'Form';
    target = current as unknown as Record<string, unknown>;
    propertyDefs = formPropertyDefs;
    onPropertyChange = (key, value) => {
      const newDef = { ...current, [key]: value } as FormDefinition;
      store.setFormDefinition(newDef);
    };
  }

  const tabs = ['format', 'data', 'event', 'other', 'all'];
  const activeTab = propertiesTab || 'format';

  // Get props for active tab
  const getPropsForTab = (tab: string): PropDef[] => {
    if (tab === 'all') {
      return Object.values(propertyDefs).flat();
    }
    return propertyDefs[tab] ?? [];
  };

  return (
    <div className="property-sheet">
      <div className="property-sheet-header">
        <span className="property-sheet-title">{selectionLabel}</span>
      </div>
      <div className="property-sheet-tabs">
        {tabs.map(tab => (
          <button
            key={tab}
            className={`tab-btn${activeTab === tab ? ' active' : ''}`}
            onClick={() => store.setPropertiesTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      <div className="property-sheet-content">
        {activeTab === 'all' ? (
          Object.entries(propertyDefs).map(([category, defs]) => (
            <div key={category}>
              <div className="property-category">{category.charAt(0).toUpperCase() + category.slice(1)}</div>
              <div className="properties-list">
                {defs.map(def => {
                  const val = def.type === 'event' ? resolveEventValue(target, def.key) : target[def.key];
                  return (
                    <div key={def.key} className="property-row">
                      <span className="property-label">{def.label}</span>
                      <PropertyInput def={def} value={val} onChange={onPropertyChange}
                        tables={tables} queries={queries} recordSourceFields={recordSourceFields} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="properties-list">
            {getPropsForTab(activeTab).map(def => {
              const val = def.type === 'event' ? resolveEventValue(target, def.key) : target[def.key];
              return (
                <div key={def.key} className="property-row">
                  <span className="property-label">{def.label}</span>
                  <PropertyInput def={def} value={val} onChange={onPropertyChange}
                    tables={tables} queries={queries} recordSourceFields={recordSourceFields} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
