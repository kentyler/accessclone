import { useCallback, useRef } from 'react';
import { useFormStore, type FormState, type FormActions } from '@/store/form';
import {
  controlStyle, resolveControlField, resolveFieldValue, formatValue,
  displayText, extractHotkey, parseHotkeyText, getSectionHeight, getSectionControls,
  applyShadeTint
} from '@/lib/utils';
import { applyConditionalFormatting } from '@/lib/expressions';
import type { Control, FormDefinition, Section } from '@/api/types';

// Controls
import LabelControl from './controls/LabelControl';
import TextBoxControl from './controls/TextBoxControl';
import ButtonControl from './controls/ButtonControl';
import CheckBoxControl from './controls/CheckBoxControl';
import ComboBoxControl from './controls/ComboBoxControl';
import ListBoxControl from './controls/ListBoxControl';
import OptionGroupControl from './controls/OptionGroupControl';
import ToggleButtonControl from './controls/ToggleButtonControl';
import TabControl from './controls/TabControl';
import ImageControl from './controls/ImageControl';
import RectangleControl from './controls/RectangleControl';
import LineControl from './controls/LineControl';
import SubFormControl from './controls/SubFormControl';

type Store = FormState & FormActions;

// ============================================================
// Sort controls by tab-index
// ============================================================

function sortByTabIndex(controls: Control[]): Control[] {
  return [...controls].sort((a, b) =>
    ((a as Record<string, unknown>)['tab-index'] as number ?? 99999) -
    ((b as Record<string, unknown>)['tab-index'] as number ?? 99999)
  );
}

// ============================================================
// Run JS handler
// ============================================================

function runJsHandler(jsCode: string, contextLabel: string) {
  try {
    const f = new Function(jsCode);
    f.call(null);
  } catch (e: unknown) {
    console.warn('Error in event handler', contextLabel, ':', (e as Error).message);
  }
}

// ============================================================
// Single control renderer
// ============================================================

function FormViewControl({
  ctrl, currentRecord, onChange, autoFocus, allowEdits, allControls
}: {
  ctrl: Control;
  currentRecord: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
  autoFocus?: boolean;
  allowEdits: boolean;
  allControls: Control[];
}) {
  const store = useFormStore();
  const ctrlName = ctrl.name || ctrl.field || '';
  const ctrlKey = ctrlName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');

  // Control state from projection
  const cs = ctrlKey ? store.projection?.controlState?.[ctrlKey] : null;
  const ctrlVisible = cs ? (cs as Record<string, unknown>).visible !== false : (ctrl.visible ?? 1) !== 0;

  if (!ctrlVisible) return null;

  const ctrlType = ctrl.type || 'label';
  // Overlay mutable caption
  const effectiveCtrl = cs && (cs as Record<string, unknown>).caption
    ? { ...ctrl, caption: (cs as Record<string, unknown>).caption as string, text: (cs as Record<string, unknown>).caption as string }
    : ctrl;

  const field = resolveControlField(effectiveCtrl);
  const rawValue = resolveFieldValue(field, currentRecord, undefined, effectiveCtrl);
  const value = effectiveCtrl.format ? formatValue(rawValue, effectiveCtrl.format) : rawValue;

  const baseStyle = controlStyle(effectiveCtrl);
  const cfStyle = applyConditionalFormatting(effectiveCtrl, currentRecord, undefined);
  const style = cfStyle ? { ...baseStyle, ...cfStyle } : baseStyle;

  const tabIdx = (effectiveCtrl as Record<string, unknown>)['tab-stop'] === 0
    ? -1
    : (effectiveCtrl as Record<string, unknown>)['tab-index'] as number | undefined;

  const ctrlEnabled = cs ? (cs as Record<string, unknown>).enabled !== false : (effectiveCtrl.enabled ?? 1) !== 0;
  const ctrlLocked = cs ? Boolean((cs as Record<string, unknown>).locked) : effectiveCtrl.locked === 1;
  const effectiveEdits = allowEdits && ctrlEnabled && !ctrlLocked;

  const hotkey = extractHotkey((effectiveCtrl as Record<string, unknown>).text as string || effectiveCtrl.caption || '');
  const tip = (effectiveCtrl as Record<string, unknown>)['control-tip-text'] as string | undefined;

  // Focus events
  const triggers = ctrlKey ? store.projection?.fieldTriggers?.[ctrlKey] : null;
  const hasFocusEvents = triggers && (
    (triggers as Record<string, unknown>)['has-enter-event'] ||
    (triggers as Record<string, unknown>)['has-exit-event'] ||
    (triggers as Record<string, unknown>)['has-gotfocus-event'] ||
    (triggers as Record<string, unknown>)['has-lostfocus-event']
  );

  const fireFocusEvent = useCallback((eventKey: string) => {
    const projection = useFormStore.getState().projection;
    if (!projection) return;
    const handler = projection.eventHandlers?.[`${ctrlName}::${eventKey}`];
    if (handler?.js) runJsHandler(handler.js, `${ctrlName}.${eventKey}`);
  }, [ctrlName]);

  const focusProps: Record<string, unknown> = {};
  if (hasFocusEvents) {
    if ((triggers as Record<string, unknown>)['has-enter-event'] || (triggers as Record<string, unknown>)['has-gotfocus-event']) {
      focusProps.onFocus = () => {
        if ((triggers as Record<string, unknown>)['has-enter-event']) fireFocusEvent('on-enter');
        if ((triggers as Record<string, unknown>)['has-gotfocus-event']) fireFocusEvent('on-gotfocus');
      };
    }
    if ((triggers as Record<string, unknown>)['has-exit-event'] || (triggers as Record<string, unknown>)['has-lostfocus-event']) {
      focusProps.onBlur = () => {
        if ((triggers as Record<string, unknown>)['has-exit-event']) fireFocusEvent('on-exit');
        if ((triggers as Record<string, unknown>)['has-lostfocus-event']) fireFocusEvent('on-lostfocus');
      };
    }
  }

  const cls = `${ctrlType}${!ctrlEnabled ? ' disabled' : ''}`;

  // Render inner control
  let inner: React.ReactNode;
  switch (ctrlType) {
    case 'label':
      inner = <LabelControl ctrl={effectiveCtrl} />;
      break;
    case 'text-box':
      inner = <TextBoxControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} autoFocus={autoFocus} isNew={Boolean(currentRecord.__new__)} tabIdx={tabIdx} />;
      break;
    case 'button':
    case 'command-button':
      inner = <ButtonControl ctrl={effectiveCtrl} tabIdx={tabIdx} />;
      break;
    case 'check-box':
      inner = <CheckBoxControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} tabIdx={tabIdx} />;
      break;
    case 'combo-box':
      inner = <ComboBoxControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} tabIdx={tabIdx} />;
      break;
    case 'list-box':
      inner = <ListBoxControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} tabIdx={tabIdx} />;
      break;
    case 'option-group':
      inner = <OptionGroupControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} tabIdx={tabIdx} />;
      break;
    case 'toggle-button':
      inner = <ToggleButtonControl ctrl={effectiveCtrl} field={field} value={value} onChange={onChange}
        allowEdits={effectiveEdits} tabIdx={tabIdx} />;
      break;
    case 'tab-control':
      inner = <TabControl ctrl={effectiveCtrl} allControls={allControls} currentRecord={currentRecord}
        onChange={onChange} allowEdits={effectiveEdits}
        renderControl={(c, rec, oc, opts) => (
          <FormViewControl ctrl={c} currentRecord={rec} onChange={oc}
            allowEdits={Boolean(opts.allowEdits)} allControls={opts.allControls as Control[] ?? allControls} />
        )} />;
      break;
    case 'image':
    case 'object-frame':
      inner = <ImageControl ctrl={effectiveCtrl} />;
      break;
    case 'rectangle':
      inner = <RectangleControl ctrl={effectiveCtrl} />;
      break;
    case 'line':
      inner = <LineControl ctrl={effectiveCtrl} />;
      break;
    case 'subform':
      inner = <SubFormControl ctrl={effectiveCtrl} currentRecord={currentRecord} />;
      break;
    default:
      inner = <span>{displayText(effectiveCtrl)}</span>;
  }

  return (
    <div
      className={`view-control ${cls}`}
      style={style}
      title={tip}
      data-hotkey={hotkey || undefined}
      data-hotkey-label={ctrlType === 'label' ? 'true' : undefined}
      {...focusProps}
    >
      {inner}
    </div>
  );
}

// ============================================================
// Section rendering
// ============================================================

function sectionViewStyle(height: number, sectionData: Section | undefined): React.CSSProperties {
  const style: React.CSSProperties = { height };
  if (!sectionData) return style;

  const backColor = sectionData['back-color']
    ? applyShadeTint(
        String(sectionData['back-color']),
        ((sectionData as Record<string, unknown>)['back-shade'] as number) ?? 100,
        ((sectionData as Record<string, unknown>)['back-tint'] as number) ?? 100
      )
    : undefined;

  if (backColor) style.backgroundColor = backColor;

  const picture = (sectionData as Record<string, unknown>).picture as string | undefined;
  if (picture) {
    style.backgroundImage = `url(${picture})`;
    const sizeMode = (sectionData as Record<string, unknown>)['picture-size-mode'] as string;
    style.backgroundSize = sizeMode === 'stretch' ? '100% 100%' : sizeMode === 'zoom' ? 'contain' : 'auto';
    style.backgroundRepeat = 'no-repeat';
    style.backgroundPosition = 'center';
  }

  return style;
}

function FormViewSection({
  section, formDef, currentRecord, onChange, showSelectors, allowEdits, formWidth
}: {
  section: 'header' | 'detail' | 'footer';
  formDef: FormDefinition;
  currentRecord: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
  showSelectors?: boolean;
  allowEdits: boolean;
  formWidth?: number;
}) {
  const height = getSectionHeight(formDef, section);
  const sectionData = formDef[section];
  const style = sectionViewStyle(height, sectionData);
  const allControls = getSectionControls(formDef, section);
  const controls = sortByTabIndex(
    allControls.filter(c => !(c as Record<string, unknown>)['parent-page'] && c.type !== 'page')
  );

  if (allControls.length === 0) return null;

  if (showSelectors && section === 'detail') {
    return (
      <div className="single-form-row" style={{ paddingLeft: 20, boxSizing: 'border-box', width: formWidth ? formWidth + 20 : undefined }}>
        <div className="record-selector current">&#9654;</div>
        <div className={`view-section ${section}`} style={style}>
          <div className="view-controls-container">
            {controls.map((ctrl, idx) => (
              <FormViewControl key={idx} ctrl={ctrl} currentRecord={currentRecord} onChange={onChange}
                allowEdits={allowEdits} allControls={allControls} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`view-section ${section}`} style={style}>
      <div className="view-controls-container">
        {controls.map((ctrl, idx) => (
          <FormViewControl key={idx} ctrl={ctrl} currentRecord={currentRecord} onChange={onChange}
            allowEdits={allowEdits} allControls={allControls} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Continuous form detail row
// ============================================================

function FormViewDetailRow({
  idx, record, formDef, selected, onSelect, onChange, showSelectors, allowEdits, formWidth
}: {
  idx: number;
  record: Record<string, unknown>;
  formDef: FormDefinition;
  selected: boolean;
  onSelect: (idx: number) => void;
  onChange: (field: string, value: unknown) => void;
  showSelectors?: boolean;
  allowEdits: boolean;
  formWidth?: number;
}) {
  const height = getSectionHeight(formDef, 'detail');
  const allControls = getSectionControls(formDef, 'detail');
  const controls = sortByTabIndex(
    allControls.filter(c => !(c as Record<string, unknown>)['parent-page'] && c.type !== 'page')
  );
  const selectorW = showSelectors ? 20 : 0;

  return (
    <div
      className={`view-section detail continuous-row${selected ? ' selected' : ''}`}
      style={{ height, boxSizing: 'border-box', paddingLeft: showSelectors ? selectorW : undefined, width: formWidth ? formWidth + selectorW : undefined }}
      onClick={() => onSelect(idx)}
    >
      {showSelectors && (
        <div className={`record-selector${selected ? ' current' : ''}${record.__new__ ? ' new-record' : ''}`}>
          {selected && record.__new__ ? '&#9654;*' : selected ? '&#9654;' : record.__new__ ? '*' : '\u00A0'}
        </div>
      )}
      <div className="view-controls-container">
        {controls.map((ctrl, ci) => (
          <FormViewControl key={ci} ctrl={ctrl} currentRecord={record} onChange={onChange}
            autoFocus={selected && ci === 0} allowEdits={allowEdits} allControls={allControls} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Record navigation bar
// ============================================================

function RecordNavBar({
  current, total, allowAdditions, allowDeletions, dirty
}: {
  current: number;
  total: number;
  allowAdditions: boolean;
  allowDeletions: boolean;
  dirty: boolean;
}) {
  const store = useFormStore();
  const noRecs = total < 1;
  const atFirst = current <= 1;
  const atLast = current >= total;

  return (
    <div className="record-nav-bar">
      <span className="nav-label">Record:</span>
      <button className="nav-btn" title="First" disabled={noRecs || atFirst} onClick={() => store.navigateToRecord(1)}>|&#9664;</button>
      <button className="nav-btn" title="Previous" disabled={noRecs || atFirst} onClick={() => store.navigateToRecord(current - 1)}>&#9664;</button>
      <span className="record-counter">{total > 0 ? `${current} of ${total}` : '0 of 0'}</span>
      <button className="nav-btn" title="Next" disabled={noRecs || atLast} onClick={() => store.navigateToRecord(current + 1)}>&#9654;</button>
      <button className="nav-btn" title="Last" disabled={noRecs || atLast} onClick={() => store.navigateToRecord(total)}>&#9654;|</button>
      <button className="nav-btn" title="New Record" disabled={!allowAdditions} onClick={() => store.newRecord()}>&#9654;*</button>
      <button className="nav-btn delete-btn" title="Delete Record" disabled={noRecs || !allowDeletions}
        onClick={() => { if (confirm('Delete this record?')) store.deleteCurrentRecord(); }}>&#10005;</button>
      <span className="nav-separator" />
      <button className={`nav-btn save-btn${dirty ? ' dirty' : ''}`} title="Save Record" disabled={!dirty}
        onClick={() => store.saveCurrentRecord()}>Save</button>
    </div>
  );
}

// ============================================================
// Alt+hotkey handler
// ============================================================

function handleHotkey(e: React.KeyboardEvent, canvasEl: HTMLElement) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
    const letter = e.key.toLowerCase();
    const target = canvasEl.querySelector(`[data-hotkey="${letter}"]`) as HTMLElement | null;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    if (target.getAttribute('data-hotkey-label') === 'true') {
      const next = target.nextElementSibling as HTMLElement | null;
      if (next) {
        const focusable = next.querySelector('input, select, button, textarea') as HTMLElement || next;
        focusable.focus();
      }
    } else {
      const btn = target.querySelector('button') as HTMLElement | null;
      const focusable = btn || target.querySelector('input, select, textarea') as HTMLElement | null;
      if (btn) btn.click();
      else if (focusable) focusable.focus();
    }
  }
}

// ============================================================
// Main FormView component
// ============================================================

export default function FormView() {
  const store = useFormStore();
  const canvasRef = useRef<HTMLDivElement>(null);

  const current = store.current;
  const projection = store.projection;
  const currentRecord = projection?.record ?? {};
  const allRecords = projection?.records ?? [];
  const pos = { current: projection?.position ?? 0, total: projection?.total ?? 0 };
  const recordSource = current?.['record-source'] || '';
  const continuous = (current?.['default-view'] || 'Single Form') === 'Continuous Forms';

  const onChange = useCallback((field: string, value: unknown) => {
    store.updateRecordField(field, value);
  }, []);

  const onSelectRecord = useCallback((idx: number) => {
    store.navigateToRecord(idx + 1);
  }, []);

  const showSelectors = (current?.['record-selectors'] ?? 1) !== 0;
  const allowEdits = (current?.['allow-edits'] ?? 1) !== 0;
  const allowAdditions = (current?.['allow-additions'] ?? 1) !== 0;
  const allowDeletions = (current?.['allow-deletions'] ?? 1) !== 0;
  const formWidth = current?.width || (current as Record<string, unknown> | null)?.['form-width'] as number | undefined;
  const scrollBars = (current as Record<string, unknown> | null)?.['scroll-bars'] as string || 'both';

  const hasControls = current && (
    (current.header?.controls?.length ?? 0) > 0 ||
    (current.detail?.controls?.length ?? 0) > 0 ||
    (current.footer?.controls?.length ?? 0) > 0
  );
  const hasData = Boolean(recordSource) && (pos.total > 0 || (continuous && allowAdditions));

  const showHeader = current?.header && (current.header.visible ?? 1) !== 0;
  const showFooter = current?.footer && (current.footer.visible ?? 1) !== 0;

  if (!current) return null;

  return (
    <div
      ref={canvasRef}
      className="form-canvas view-mode"
      style={current['back-color'] ? { backgroundColor: current['back-color'] as string } : undefined}
      tabIndex={-1}
      onKeyDown={e => canvasRef.current && handleHotkey(e, canvasRef.current)}
      onClick={() => { store.hideFormContextMenu(); }}
    >
      <div
        className="canvas-body view-mode-body"
        style={{
          overflowX: ['neither', 'vertical'].includes(scrollBars) ? 'hidden' : undefined,
          overflowY: ['neither', 'horizontal'].includes(scrollBars) ? 'hidden' : undefined,
        }}
      >
        {hasData ? (
          continuous ? (
            /* Continuous form */
            <div className="view-sections-container continuous"
              style={{ position: 'absolute', top: 0, left: 0, bottom: 0, overflow: 'hidden', width: formWidth ? formWidth + (showSelectors ? 20 : 0) : undefined }}>
              {showHeader && (
                <div style={{ position: 'absolute', top: 0, left: 0, height: getSectionHeight(current, 'header'), width: formWidth ? formWidth + (showSelectors ? 20 : 0) : undefined }}>
                  <FormViewSection section="header" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={allowEdits} />
                </div>
              )}
              <div className="continuous-records-container" style={{
                position: 'absolute',
                top: showHeader ? getSectionHeight(current, 'header') : 0,
                left: 0, right: 0,
                bottom: showFooter ? getSectionHeight(current, 'footer') : 0,
                overflowY: 'auto'
              }}>
                {allRecords.map((record, idx) => {
                  const sel = idx + 1 === pos.current;
                  const disp = sel ? currentRecord : record;
                  return (
                    <FormViewDetailRow key={(record as Record<string, unknown>).id as string ?? idx}
                      idx={idx} record={disp} formDef={current} selected={sel}
                      onSelect={onSelectRecord} onChange={onChange}
                      showSelectors={showSelectors} allowEdits={allowEdits} formWidth={formWidth} />
                  );
                })}
                {allowAdditions && !allRecords.some(r => (r as Record<string, unknown>).__new__) && (
                  <div className="view-section detail continuous-row tentative-row"
                    style={{ height: getSectionHeight(current, 'detail'), boxSizing: 'border-box' }}
                    onClick={() => store.newRecord()}>
                    {showSelectors && <div className="record-selector new-record">*</div>}
                    <div className="view-controls-container" />
                  </div>
                )}
              </div>
              {showFooter && (
                <div style={{ position: 'absolute', bottom: 0, left: 0, height: getSectionHeight(current, 'footer'), width: formWidth ? formWidth + (showSelectors ? 20 : 0) : undefined }}>
                  <FormViewSection section="footer" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={allowEdits} />
                </div>
              )}
            </div>
          ) : (
            /* Single form */
            <div className="view-sections-container" style={formWidth ? { width: formWidth } : undefined}>
              {showHeader && <FormViewSection section="header" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={allowEdits} />}
              <FormViewSection section="detail" formDef={current} currentRecord={currentRecord} onChange={onChange}
                showSelectors={showSelectors} allowEdits={allowEdits} formWidth={formWidth} />
              {showFooter && <FormViewSection section="footer" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={allowEdits} />}
            </div>
          )
        ) : !recordSource && hasControls ? (
          <div className="view-sections-container" style={formWidth ? { width: formWidth } : undefined}>
            {showHeader && <FormViewSection section="header" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={false} />}
            <FormViewSection section="detail" formDef={current} currentRecord={currentRecord} onChange={onChange}
              showSelectors={showSelectors} allowEdits={false} formWidth={formWidth} />
            {showFooter && <FormViewSection section="footer" formDef={current} currentRecord={currentRecord} onChange={onChange} allowEdits={false} />}
          </div>
        ) : (
          <div className="no-records">
            {!recordSource ? 'Select a record source in Design View' :
              hasControls ? 'No records found' : 'Add controls in Design View'}
          </div>
        )}
      </div>

      {(current['navigation-buttons'] ?? 1) !== 0 && (
        <RecordNavBar current={pos.current} total={pos.total}
          allowAdditions={allowAdditions} allowDeletions={allowDeletions}
          dirty={Boolean(projection?.dirty)} />
      )}
    </div>
  );
}
