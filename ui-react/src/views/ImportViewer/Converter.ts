/**
 * Pure conversion functions: Access JSON → internal form/report definitions.
 * Ported from access_database_viewer.cljs lines 22-399.
 */
import type { Control, ControlType, FormDefinition, ReportDefinition, Section } from '@/api/types';

const TWIPS_PER_PIXEL = 15;

export function twipsToPx(twips: number | null | undefined): number {
  if (twips == null) return 0;
  return Math.round(twips / TWIPS_PER_PIXEL);
}

export function accessColorToHex(color: number | string | null | undefined): string {
  if (color == null || color === '') return '';
  const n = typeof color === 'string' ? parseInt(color, 10) : color;
  if (isNaN(n)) return '';
  // Access uses BGR (little-endian)
  const b = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const r = n & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

const DEFAULT_VIEW_MAP: Record<number, string> = { 0: 'Single Form', 1: 'Continuous Forms', 2: 'Datasheet' };
const SCROLL_BARS_MAP: Record<number, string> = { 0: 'neither', 1: 'horizontal', 2: 'vertical', 3: 'both' };
const RUNNING_SUM_MAP: Record<number, string> = { 1: 'Over Group', 2: 'Over All' };
const GROUP_ON_MAP: Record<number, string> = { 0: 'Each Value', 1: 'Prefix', 2: 'Year', 3: 'Quarter', 4: 'Month', 5: 'Week', 6: 'Day', 7: 'Hour', 8: 'Minute', 9: 'Interval' };
const KEEP_TOGETHER_MAP: Record<number, string> = { 0: 'No', 1: 'Whole Group', 2: 'With First Detail' };
const PICTURE_SIZE_MODE_MAP: Record<number, string> = { 0: 'clip', 1: 'stretch', 3: 'zoom' };

// ============================================================
// Control conversion
// ============================================================

function applyControlSource(ctrl: Record<string, unknown>, controlSource: string | null | undefined): void {
  if (!controlSource) return;
  const cs = String(controlSource);
  if (cs.startsWith('=')) {
    ctrl['control-source'] = cs;
  } else {
    // Strip table qualification (e.g. "table.field" → "field")
    const dot = cs.lastIndexOf('.');
    ctrl.field = dot >= 0 ? cs.slice(dot + 1) : cs;
    ctrl['control-source'] = cs;
  }
}

function controlBase(src: Record<string, unknown>): Record<string, unknown> {
  const type = String(src.controlType || src.type || 'label').toLowerCase().replace(/ /g, '-') as ControlType;
  const ctrl: Record<string, unknown> = {
    type,
    name: src.name || src.controlName || '',
    left: twipsToPx(src.left as number),
    top: twipsToPx(src.top as number),
    width: twipsToPx(src.width as number),
    height: twipsToPx(src.height as number),
  };

  // Font
  if (src.fontName) ctrl['font-name'] = src.fontName;
  if (src.fontSize) ctrl['font-size'] = Number(src.fontSize);
  if (src.fontWeight) ctrl['font-weight'] = Number(src.fontWeight);
  if (src.fontItalic) ctrl['font-italic'] = src.fontItalic === true || src.fontItalic === -1 ? 1 : 0;
  if (src.fontUnderline) ctrl['font-underline'] = src.fontUnderline === true || src.fontUnderline === -1 ? 1 : 0;

  // Colors
  if (src.foreColor != null) ctrl['fore-color'] = Number(src.foreColor);
  if (src.backColor != null) ctrl['back-color'] = Number(src.backColor);
  if (src.backStyle != null) ctrl['back-style'] = Number(src.backStyle);
  if (src.borderStyle != null) ctrl['border-style'] = Number(src.borderStyle);
  if (src.borderColor != null) ctrl['border-color'] = Number(src.borderColor);

  // Text
  if (src.caption) ctrl.caption = String(src.caption);
  if (src.format) ctrl.format = String(src.format);
  if (src.toolTipText) ctrl['tool-tip-text'] = String(src.toolTipText);
  if (src.tag) ctrl.tag = String(src.tag);
  if (src.visible != null) ctrl.visible = src.visible === false || src.visible === 0 ? 0 : 1;
  if (src.textAlign != null) ctrl['text-align'] = String(src.textAlign);

  applyControlSource(ctrl, src.controlSource as string);

  return ctrl;
}

function applyFormControlProps(ctrl: Record<string, unknown>, src: Record<string, unknown>): void {
  if (src.defaultValue) ctrl['default-value'] = String(src.defaultValue);
  if (src.inputMask) ctrl['input-mask'] = String(src.inputMask);
  if (src.validationRule) ctrl['validation-rule'] = String(src.validationRule);
  if (src.tabIndex != null) ctrl['tab-index'] = Number(src.tabIndex);
  if (src.enabled != null) ctrl.enabled = src.enabled === false || src.enabled === 0 ? 0 : 1;
  if (src.locked != null) ctrl.locked = src.locked === true || src.locked === -1 ? 1 : 0;

  // Combo/list box
  if (src.rowSource) ctrl['row-source'] = String(src.rowSource);
  if (src.rowSourceType) ctrl['row-source-type'] = String(src.rowSourceType);
  if (src.boundColumn != null) ctrl['bound-column'] = Number(src.boundColumn);
  if (src.columnCount != null) ctrl['column-count'] = Number(src.columnCount);
  if (src.columnWidths) ctrl['column-widths'] = String(src.columnWidths);
  if (src.listRows != null) ctrl['list-rows'] = Number(src.listRows);

  // Subform
  if (src.sourceObject || src.sourceForm) {
    ctrl['source-object'] = String(src.sourceObject || src.sourceForm || '');
  }
  if (src.linkChildFields) ctrl['link-child-fields'] = String(src.linkChildFields);
  if (src.linkMasterFields) ctrl['link-master-fields'] = String(src.linkMasterFields);

  // Tab page
  if (src.pageIndex != null) ctrl['page-index'] = Number(src.pageIndex);
  if (src.pages) ctrl.pages = src.pages;

  // Events
  const eventFlags = ['onClick', 'onDblClick', 'onEnter', 'onExit', 'onGotFocus', 'onLostFocus',
    'onMouseDown', 'onMouseMove', 'onMouseUp', 'beforeUpdate', 'afterUpdate',
    'onChange', 'onKeyDown', 'onKeyUp', 'onKeyPress'];
  for (const flag of eventFlags) {
    if (src[flag]) {
      const kebab = flag.replace(/([A-Z])/g, '-$1').toLowerCase();
      ctrl[`has-${kebab}-event`] = true;
    }
  }

  // Picture
  if (src.picture) ctrl.picture = String(src.picture);
  if (src.pictureSizeMode != null) ctrl['picture-size-mode'] = PICTURE_SIZE_MODE_MAP[Number(src.pictureSizeMode)] || 'clip';
  if (src.pictureAlignment != null) ctrl['picture-alignment'] = Number(src.pictureAlignment);
}

export function convertControl(src: Record<string, unknown>): Control {
  const ctrl = controlBase(src);
  applyFormControlProps(ctrl, src);
  return ctrl as unknown as Control;
}

// ============================================================
// Form conversion
// ============================================================

function extractRecordSource(rs: string | null | undefined): string {
  if (!rs) return '';
  const s = rs.trim();
  const m = s.match(/^SELECT\s+.*?\s+FROM\s+\[?(\w+)\]?\s*;?\s*$/i);
  return m ? m[1] : s;
}

function pascalToKebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

function extractSectionProps(src: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length);
      if (rest) {
        const kebab = pascalToKebab(rest);
        props[kebab] = v;
      }
    }
  }
  return props;
}

function buildFormSection(
  src: Record<string, unknown>,
  prefix: string,
  controls: Record<string, unknown>[],
): Section {
  const props = extractSectionProps(src, prefix);
  const height = props.height ? twipsToPx(Number(props.height)) : undefined;
  const sec: Record<string, unknown> = {
    controls: controls.map(convertControl),
  };
  if (height != null) sec.height = height;
  if (props['back-color'] != null) sec['back-color'] = Number(props['back-color']);
  if (props.visible != null) sec.visible = props.visible === false || props.visible === 0 ? 0 : 1;
  if (props.picture) sec.picture = String(props.picture);
  if (props['picture-size-mode'] != null) {
    sec['picture-size-mode'] = PICTURE_SIZE_MODE_MAP[Number(props['picture-size-mode'])] || 'clip';
  }
  // Event flags
  for (const [pk, pv] of Object.entries(props)) {
    if (pk.startsWith('has-') && pk.endsWith('-event') && pv) {
      sec[pk] = true;
    }
  }
  return sec as unknown as Section;
}

export function convertAccessForm(src: Record<string, unknown>): FormDefinition {
  const headerControls = (src.headerControls || src.FormHeader || []) as Record<string, unknown>[];
  const detailControls = (src.detailControls || src.Detail || []) as Record<string, unknown>[];
  const footerControls = (src.footerControls || src.FormFooter || []) as Record<string, unknown>[];

  const header = buildFormSection(src, 'header', headerControls);
  const detail = buildFormSection(src, 'detail', detailControls);
  const footer = buildFormSection(src, 'footer', footerControls);

  // Only include header/footer if they have controls or non-zero height
  const hasHeader = headerControls.length > 0 || (header.height && header.height > 0);
  const hasFooter = footerControls.length > 0 || (footer.height && footer.height > 0);

  const form: Record<string, unknown> = {
    detail,
  };
  if (hasHeader) {
    form.header = header;
    if (!header.visible) header.visible = 1;
  }
  if (hasFooter) {
    form.footer = footer;
    if (!footer.visible) footer.visible = 1;
  }

  // Record source
  const rs = src.recordSource || src.RecordSource;
  if (rs) form['record-source'] = extractRecordSource(String(rs)).toLowerCase();

  // Default view
  const dv = src.defaultView ?? src.DefaultView;
  if (dv != null) form['default-view'] = DEFAULT_VIEW_MAP[Number(dv)] || 'Single Form';

  // Navigation/record selectors
  if (src.navigationButtons != null) form['navigation-buttons'] = src.navigationButtons === false || src.navigationButtons === 0 ? 0 : 1;
  if (src.recordSelectors != null) form['record-selectors'] = src.recordSelectors === false || src.recordSelectors === 0 ? 0 : 1;
  if (src.allowAdditions != null) form['allow-additions'] = src.allowAdditions === false || src.allowAdditions === 0 ? 0 : 1;
  if (src.allowDeletions != null) form['allow-deletions'] = src.allowDeletions === false || src.allowDeletions === 0 ? 0 : 1;
  if (src.allowEdits != null) form['allow-edits'] = src.allowEdits === false || src.allowEdits === 0 ? 0 : 1;
  if (src.dividingLines != null) form['dividing-lines'] = src.dividingLines === false || src.dividingLines === 0 ? 0 : 1;
  if (src.dataEntry != null) form['data-entry'] = src.dataEntry === true || src.dataEntry === -1 ? 1 : 0;

  // Scroll bars
  if (src.scrollBars != null) form['scroll-bars'] = SCROLL_BARS_MAP[Number(src.scrollBars)] || 'both';

  // Popup/modal
  if (src.popup != null) form.popup = src.popup === true || src.popup === -1 ? 1 : 0;
  if (src.modal != null) form.modal = src.modal === true || src.modal === -1 ? 1 : 0;

  // Appearance
  if (src.caption) form.caption = String(src.caption);
  if (src.backColor != null) form['back-color'] = Number(src.backColor);
  if (src.picture) form.picture = String(src.picture);
  if (src.pictureSizeMode != null) form['picture-size-mode'] = PICTURE_SIZE_MODE_MAP[Number(src.pictureSizeMode)] || 'clip';

  // Filter/sort
  if (src.filter) form.filter = String(src.filter);
  if (src.filterOn != null) form['filter-on'] = src.filterOn === true || src.filterOn === -1 ? 1 : 0;
  if (src.orderBy) form['order-by'] = String(src.orderBy);
  if (src.orderByOn != null) form['order-by-on'] = src.orderByOn === true || src.orderByOn === -1 ? 1 : 0;

  // Events
  const formEvents = ['onLoad', 'onOpen', 'onClose', 'onCurrent', 'beforeInsert', 'afterInsert',
    'beforeUpdate', 'afterUpdate', 'onDelete'];
  for (const evt of formEvents) {
    if (src[evt]) {
      const kebab = evt.replace(/([A-Z])/g, '-$1').toLowerCase();
      form[`has-${kebab}-event`] = true;
    }
  }

  return form as unknown as FormDefinition;
}

// ============================================================
// Report conversion
// ============================================================

function convertReportControl(src: Record<string, unknown>): Control {
  const ctrl = controlBase(src);

  // Report-specific props
  if (src.runningSum != null) ctrl['running-sum'] = RUNNING_SUM_MAP[Number(src.runningSum)] || 'No';
  if (src.canGrow != null) ctrl['can-grow'] = src.canGrow === true || src.canGrow === -1 ? 1 : 0;
  if (src.canShrink != null) ctrl['can-shrink'] = src.canShrink === true || src.canShrink === -1 ? 1 : 0;
  if (src.hideDuplicates != null) ctrl['hide-duplicates'] = src.hideDuplicates === true || src.hideDuplicates === -1 ? 1 : 0;

  // Subreport linking
  if (src.sourceObject) ctrl['source-object'] = String(src.sourceObject);
  if (src.linkChildFields) ctrl['link-child-fields'] = String(src.linkChildFields);
  if (src.linkMasterFields) ctrl['link-master-fields'] = String(src.linkMasterFields);

  // Events
  const eventFlags = ['onClick', 'onDblClick', 'onFormat', 'onPrint', 'onRetreat'];
  for (const flag of eventFlags) {
    if (src[flag]) {
      const kebab = flag.replace(/([A-Z])/g, '-$1').toLowerCase();
      ctrl[`has-${kebab}-event`] = true;
    }
  }

  return ctrl as unknown as Control;
}

function convertReportSection(src: Record<string, unknown>, controls: Record<string, unknown>[]): Section {
  const sec: Record<string, unknown> = {
    height: twipsToPx(src.height as number) || 300,
    controls: controls.map(convertReportControl),
  };
  if (src.visible != null) sec.visible = src.visible === false || src.visible === 0 ? 0 : 1;
  if (src.canGrow != null) sec['can-grow'] = src.canGrow === true || src.canGrow === -1 ? 1 : 0;
  if (src.canShrink != null) sec['can-shrink'] = src.canShrink === true || src.canShrink === -1 ? 1 : 0;
  if (src.forceNewPage != null) {
    const fnp = Number(src.forceNewPage);
    sec['force-new-page'] = fnp === 1 ? 'Before Section' : fnp === 2 ? 'After Section' : fnp === 3 ? 'Before & After' : 'None';
  }
  if (src.keepTogether != null) sec['keep-together'] = src.keepTogether === true || src.keepTogether === -1 ? 1 : 0;
  if (src.backColor != null) sec['back-color'] = Number(src.backColor);
  if (src.picture) sec.picture = String(src.picture);
  if (src.pictureSizeMode != null) sec['picture-size-mode'] = PICTURE_SIZE_MODE_MAP[Number(src.pictureSizeMode)] || 'clip';

  // Section events
  for (const flag of ['onFormat', 'onPrint', 'onRetreat']) {
    if (src[flag]) {
      const kebab = flag.replace(/([A-Z])/g, '-$1').toLowerCase();
      sec[`has-${kebab}-event`] = true;
    }
  }

  return sec as unknown as Section;
}

function convertGrouping(src: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return src.map(g => ({
    field: g.field || g.controlSource || '',
    'sort-order': Number(g.sortOrder ?? 0) === 0 ? 'Ascending' : 'Descending',
    'group-on': GROUP_ON_MAP[Number(g.groupOn ?? 0)] || 'Each Value',
    'group-interval': Number(g.groupInterval ?? 1),
    'group-header': g.groupHeader === true || g.groupHeader === -1 ? 1 : 0,
    'group-footer': g.groupFooter === true || g.groupFooter === -1 ? 1 : 0,
    'keep-together': KEEP_TOGETHER_MAP[Number(g.keepTogether ?? 0)] || 'No',
  }));
}

export function convertAccessReport(src: Record<string, unknown>): ReportDefinition {
  const sections: Record<string, unknown> = {};

  // Standard sections
  const standardSections = [
    ['ReportHeader', 'report-header'],
    ['PageHeader', 'page-header'],
    ['Detail', 'detail'],
    ['PageFooter', 'page-footer'],
    ['ReportFooter', 'report-footer'],
  ] as const;

  for (const [srcKey, destKey] of standardSections) {
    const secData = src[srcKey] as Record<string, unknown> | undefined;
    const secControls = (src[`${srcKey}Controls`] || secData?.controls || []) as Record<string, unknown>[];
    sections[destKey] = convertReportSection(secData || {}, secControls);
  }

  // Group sections
  const grouping = src.grouping || src.GroupLevel || [];
  const convertedGrouping = Array.isArray(grouping) ? convertGrouping(grouping as Record<string, unknown>[]) : [];

  for (let i = 0; i < convertedGrouping.length; i++) {
    const ghData = (src[`GroupHeader${i}`] || src[`groupHeader${i}`]) as Record<string, unknown> | undefined;
    const ghControls = ((src[`GroupHeader${i}Controls`] || ghData?.controls || []) as Record<string, unknown>[]);
    if (ghData || ghControls.length > 0) {
      sections[`group-header-${i}`] = convertReportSection(ghData || {}, ghControls);
    }

    const gfData = (src[`GroupFooter${i}`] || src[`groupFooter${i}`]) as Record<string, unknown> | undefined;
    const gfControls = ((src[`GroupFooter${i}Controls`] || gfData?.controls || []) as Record<string, unknown>[]);
    if (gfData || gfControls.length > 0) {
      sections[`group-footer-${i}`] = convertReportSection(gfData || {}, gfControls);
    }
  }

  const report: Record<string, unknown> = {
    ...sections,
    grouping: convertedGrouping,
  };

  // Record source
  const rs = src.recordSource || src.RecordSource;
  if (rs) report['record-source'] = String(rs).toLowerCase();

  // Page layout
  if (src.pageHeight != null) report['page-height'] = twipsToPx(Number(src.pageHeight));
  if (src.pageWidth != null) report['page-width'] = twipsToPx(Number(src.pageWidth));
  if (src.width != null) report.width = twipsToPx(Number(src.width));
  if (src.leftMargin != null || src.marginLeft != null) report['margin-left'] = twipsToPx(Number(src.leftMargin ?? src.marginLeft));
  if (src.rightMargin != null || src.marginRight != null) report['margin-right'] = twipsToPx(Number(src.rightMargin ?? src.marginRight));
  if (src.topMargin != null || src.marginTop != null) report['margin-top'] = twipsToPx(Number(src.topMargin ?? src.marginTop));
  if (src.bottomMargin != null || src.marginBottom != null) report['margin-bottom'] = twipsToPx(Number(src.bottomMargin ?? src.marginBottom));

  // Caption, events
  if (src.caption) report.caption = String(src.caption);
  if (src.picture) report.picture = String(src.picture);

  const reportEvents = ['onOpen', 'onClose', 'onActivate', 'onDeactivate', 'onNoData', 'onPage', 'onError'];
  for (const evt of reportEvents) {
    if (src[evt]) {
      const kebab = evt.replace(/([A-Z])/g, '-$1').toLowerCase();
      report[`has-${kebab}-event`] = true;
    }
  }

  return report as unknown as ReportDefinition;
}
