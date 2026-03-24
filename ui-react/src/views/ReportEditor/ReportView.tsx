import { useMemo } from 'react';
import { useReportStore } from '@/store/report';
import {
  controlStyle, displayText, resolveFieldValue, accessColorToHex, applyShadeTint,
} from '@/lib/utils';
import { applyConditionalFormatting, ExprContext } from '@/lib/expressions';
import type { Control, ReportDefinition, Section } from '@/api/types';

// ============================================================
// Helpers — section ordering, group break detection, etc.
// ============================================================

const SECTION_ORDER = ['report-header', 'page-header', 'detail', 'page-footer', 'report-footer'];
const SECTION_NAMES: Record<string, string> = {
  'report-header': 'Report Header',
  'page-header': 'Page Header',
  detail: 'Detail',
  'page-footer': 'Page Footer',
  'report-footer': 'Report Footer',
};

export function getAllSections(def: ReportDefinition): string[] {
  const groupHeaders: string[] = [];
  const groupFooters: string[] = [];
  const grouping = def.grouping || [];
  for (let i = 0; i < grouping.length; i++) {
    if ((def as Record<string, unknown>)[`group-header-${i}`]) groupHeaders.push(`group-header-${i}`);
    if ((def as Record<string, unknown>)[`group-footer-${i}`]) groupFooters.push(`group-footer-${i}`);
  }
  groupHeaders.sort();
  groupFooters.sort().reverse();

  return [
    'report-header', 'page-header',
    ...groupHeaders,
    'detail',
    ...groupFooters,
    'page-footer', 'report-footer',
  ];
}

export function sectionDisplayName(key: string): string {
  if (SECTION_NAMES[key]) return SECTION_NAMES[key];
  const m = key.match(/^group-(header|footer)-(\d+)$/);
  if (m) return `Group ${m[1].charAt(0).toUpperCase() + m[1].slice(1)} ${m[2]}`;
  return key;
}

export function getReportSectionHeight(def: ReportDefinition, section: string): number {
  const sec = (def as Record<string, unknown>)[section] as Section | undefined;
  if (sec?.height && typeof sec.height === 'number') return sec.height;
  if (section === 'report-header' || section === 'report-footer') return 80;
  if (section === 'page-header' || section === 'page-footer') return 40;
  if (section.startsWith('group-')) return 60;
  return 200;
}

export function getReportSectionControls(def: ReportDefinition, section: string): Control[] {
  const sec = (def as Record<string, unknown>)[section] as Section | undefined;
  return sec?.controls ?? [];
}

// ============================================================
// Group break detection + sorting
// ============================================================

function groupValue(val: unknown, groupOn?: string, groupInterval?: number): unknown {
  if (!groupOn || groupOn === 'Each Value') return val;
  const s = String(val ?? '');
  if (groupOn === 'Prefix') return s.slice(0, groupInterval ?? 1);
  if (groupOn === 'Interval') {
    const n = typeof val === 'number' ? val : parseFloat(s);
    const interval = groupInterval ?? 1;
    return isNaN(n) ? val : Math.floor(n / interval) * interval;
  }
  // Date groupings
  const d = typeof val === 'string' ? new Date(val) : val instanceof Date ? val : null;
  if (!d || isNaN(d.getTime())) return val;
  switch (groupOn) {
    case 'Year': return d.getFullYear();
    case 'Quarter': return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'Month': return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    case 'Week': return `${d.getFullYear()}-W${isoWeekNumber(d)}`;
    case 'Day': return d.toISOString().slice(0, 10);
    case 'Hour': return `${d.toISOString().slice(0, 13)}:00`;
    case 'Minute': return d.toISOString().slice(0, 16);
    default: return val;
  }
}

function isoWeekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function compareVals(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function sortRecordsForGrouping(
  records: Record<string, unknown>[],
  grouping: ReportDefinition['grouping'],
  _orderBy?: string,
): Record<string, unknown>[] {
  if (!grouping?.length && !_orderBy) return records;
  const sorted = [...records];
  sorted.sort((a, b) => {
    for (const g of grouping ?? []) {
      if (!g.field) continue;
      const av = groupValue(a[g.field] ?? a[g.field.toLowerCase()], g['group-on'], g['group-interval']);
      const bv = groupValue(b[g.field] ?? b[g.field.toLowerCase()], g['group-on'], g['group-interval']);
      const dir = g['sort-order']?.toLowerCase() === 'descending' ? -1 : 1;
      const c = compareVals(av, bv) * dir;
      if (c !== 0) return c;
    }
    return 0;
  });
  return sorted;
}

// ============================================================
// Flat element building (group tree → flat list)
// ============================================================

interface FlatElement {
  type: 'section';
  sectionKey: string;
  record: Record<string, unknown>;
  exprContext: ExprContext;
  key: string;
}

interface GroupSegment {
  level: number;
  records: Record<string, unknown>[];
  children: GroupSegment[];
}

function buildGroupTree(
  records: Record<string, unknown>[],
  grouping: ReportDefinition['grouping'],
  level = 0,
): GroupSegment[] {
  if (!grouping?.length || level >= grouping.length) {
    return [{ level, records, children: [] }];
  }
  const g = grouping[level];
  const field = g.field || '';
  const segments: GroupSegment[] = [];
  let currentVal: unknown = Symbol('init');
  let currentRecords: Record<string, unknown>[] = [];

  for (const rec of records) {
    const v = groupValue(rec[field] ?? rec[field.toLowerCase()], g['group-on'], g['group-interval']);
    if (v !== currentVal) {
      if (currentRecords.length > 0) {
        segments.push({
          level,
          records: currentRecords,
          children: buildGroupTree(currentRecords, grouping, level + 1),
        });
      }
      currentVal = v;
      currentRecords = [rec];
    } else {
      currentRecords.push(rec);
    }
  }
  if (currentRecords.length > 0) {
    segments.push({
      level,
      records: currentRecords,
      children: buildGroupTree(currentRecords, grouping, level + 1),
    });
  }
  return segments;
}

function walkGroupTree(
  elements: FlatElement[],
  def: ReportDefinition,
  allRecords: Record<string, unknown>[],
  grouping: ReportDefinition['grouping'],
  segments: GroupSegment[],
  counter: { n: number },
) {
  for (const seg of segments) {
    const level = seg.level;
    const ghKey = `group-header-${level}`;
    const gfKey = `group-footer-${level}`;

    // Group header
    if ((def as Record<string, unknown>)[ghKey]) {
      elements.push({
        type: 'section',
        sectionKey: ghKey,
        record: seg.records[0],
        exprContext: { allRecords, groupRecords: seg.records },
        key: `${ghKey}-${counter.n++}`,
      });
    }

    if (seg.children.length > 0 && grouping && level < grouping.length - 1) {
      walkGroupTree(elements, def, allRecords, grouping, seg.children, counter);
    } else {
      // Detail records
      for (const rec of seg.records) {
        elements.push({
          type: 'section',
          sectionKey: 'detail',
          record: rec,
          exprContext: { allRecords, groupRecords: seg.records },
          key: `detail-${counter.n++}`,
        });
      }
    }

    // Group footer
    if ((def as Record<string, unknown>)[gfKey]) {
      elements.push({
        type: 'section',
        sectionKey: gfKey,
        record: seg.records[seg.records.length - 1],
        exprContext: { allRecords, groupRecords: seg.records },
        key: `${gfKey}-${counter.n++}`,
      });
    }
  }
}

function buildFlatElements(def: ReportDefinition, records: Record<string, unknown>[]): FlatElement[] {
  const sorted = sortRecordsForGrouping(records, def.grouping);
  const allRecords = sorted;
  const elements: FlatElement[] = [];
  const counter = { n: 0 };

  // Report header
  if ((def as Record<string, unknown>)['report-header']) {
    elements.push({
      type: 'section',
      sectionKey: 'report-header',
      record: sorted[0] || {},
      exprContext: { allRecords },
      key: `rh-${counter.n++}`,
    });
  }

  // Group + detail
  if (def.grouping?.length) {
    const tree = buildGroupTree(sorted, def.grouping);
    walkGroupTree(elements, def, allRecords, def.grouping, tree, counter);
  } else {
    for (const rec of sorted) {
      elements.push({
        type: 'section',
        sectionKey: 'detail',
        record: rec,
        exprContext: { allRecords },
        key: `detail-${counter.n++}`,
      });
    }
  }

  // Report footer
  if ((def as Record<string, unknown>)['report-footer']) {
    elements.push({
      type: 'section',
      sectionKey: 'report-footer',
      record: sorted[sorted.length - 1] || {},
      exprContext: { allRecords },
      key: `rf-${counter.n++}`,
    });
  }

  return elements;
}

// ============================================================
// Pagination
// ============================================================

function usablePageHeight(def: ReportDefinition): number {
  const pageHeight = (def as Record<string, unknown>)['page-height'] as number || 792;
  const marginTop = (def as Record<string, unknown>)['margin-top'] as number || 72;
  const marginBottom = (def as Record<string, unknown>)['margin-bottom'] as number || 72;
  const phHeight = ((def['page-header'] as Section | undefined)?.height ?? 40);
  const pfHeight = ((def['page-footer'] as Section | undefined)?.height ?? 40);
  return pageHeight - marginTop - marginBottom - phHeight - pfHeight;
}

function computePages(elements: FlatElement[], def: ReportDefinition): FlatElement[][] {
  const available = usablePageHeight(def);
  const pages: FlatElement[][] = [[]];
  let remaining = available;

  for (const el of elements) {
    const h = getReportSectionHeight(def, el.sectionKey);
    const forceNew = ((def as Record<string, unknown>)[el.sectionKey] as Section | undefined);
    const forceProp = (forceNew as Record<string, unknown> | undefined)?.['force-new-page'] as string | undefined;

    if (forceProp === 'Before Section' || forceProp === 'Before & After') {
      if (pages[pages.length - 1].length > 0) {
        pages.push([]);
        remaining = available;
      }
    }

    if (h > remaining && pages[pages.length - 1].length > 0) {
      pages.push([]);
      remaining = available;
    }

    pages[pages.length - 1].push(el);
    remaining -= h;

    if (forceProp === 'After Section' || forceProp === 'Before & After') {
      pages.push([]);
      remaining = available;
    }
  }

  // Remove trailing empty page
  if (pages.length > 1 && pages[pages.length - 1].length === 0) {
    pages.pop();
  }
  if (pages.length === 0) pages.push([]);
  return pages;
}

// ============================================================
// Render helpers
// ============================================================

function controlFontStyle(ctrl: Control): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (ctrl['font-name']) s.fontFamily = ctrl['font-name'];
  if (ctrl['font-size']) s.fontSize = ctrl['font-size'];
  if (ctrl['font-weight'] && ctrl['font-weight'] >= 700) s.fontWeight = 'bold';
  if (ctrl['font-italic']) s.fontStyle = 'italic';
  if (ctrl['font-underline']) s.textDecoration = 'underline';
  if (ctrl['fore-color'] != null) s.color = accessColorToHex(ctrl['fore-color']);
  return s;
}

function RenderReportControl({ ctrl, record, exprContext }: {
  ctrl: Control;
  record: Record<string, unknown>;
  exprContext: ExprContext;
}) {
  const field = ctrl.field || ctrl['control-source'];
  const rawValue = resolveFieldValue(field ?? null, record, exprContext, ctrl);
  const text = rawValue != null ? String(rawValue) : (ctrl.caption || '');

  const baseStyle = controlStyle(ctrl);
  const fontStyle = controlFontStyle(ctrl);

  // Conditional formatting
  const cfStyle = applyConditionalFormatting(ctrl, { ...exprContext, record });

  const mergedStyle = { ...baseStyle, ...fontStyle, ...cfStyle, position: 'absolute' as const };

  const type = ctrl.type;
  if (type === 'line') {
    return <div style={mergedStyle}><hr style={{ margin: 0, border: 'none', borderTop: '1px solid #000' }} /></div>;
  }
  if (type === 'rectangle') {
    return <div style={mergedStyle} />;
  }
  if (type === 'image' || type === 'unbound-object-frame' || type === 'object-frame' || type === 'bound-object-frame') {
    const src = ctrl.picture || (rawValue ? String(rawValue) : '');
    return <div style={mergedStyle}>{src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : null}</div>;
  }

  return <div style={mergedStyle}><span>{text}</span></div>;
}

function RenderSection({ sectionKey, def, record, exprContext }: {
  sectionKey: string;
  def: ReportDefinition;
  record: Record<string, unknown>;
  exprContext: ExprContext;
}) {
  const sec = (def as Record<string, unknown>)[sectionKey] as Section | undefined;
  if (!sec) return null;
  if (sec.visible === 0) return null;

  const height = sec.height || getReportSectionHeight(def, sectionKey);
  const controls = sec.controls || [];

  const bgStyle: React.CSSProperties = {};
  if (sec['back-color'] != null) {
    bgStyle.backgroundColor = accessColorToHex((sec as Record<string, unknown>)['back-color'] as number);
  }
  const picture = (sec as Record<string, unknown>).picture as string | undefined;
  if (picture) {
    bgStyle.backgroundImage = `url(${picture})`;
    bgStyle.backgroundRepeat = 'no-repeat';
    const sizeMode = (sec as Record<string, unknown>)['picture-size-mode'] as string | undefined;
    bgStyle.backgroundSize = sizeMode === 'stretch' ? '100% 100%' : sizeMode === 'zoom' ? 'contain' : undefined;
  }

  return (
    <div className="report-section" style={{ position: 'relative', height, overflow: 'hidden', ...bgStyle }}>
      {controls.map((ctrl: Control, idx: number) => (
        <RenderReportControl key={idx} ctrl={ctrl} record={record} exprContext={exprContext} />
      ))}
    </div>
  );
}

function shouldShowPageHeader(pageNum: number, hasReportHeader: boolean, setting?: string): boolean {
  if (setting === 'Not With Rpt Hdr' && pageNum === 0 && hasReportHeader) return false;
  if (setting === 'Not With Rpt Hdr/Ftr' && pageNum === 0 && hasReportHeader) return false;
  return true;
}

function shouldShowPageFooter(pageNum: number, totalPages: number, hasReportFooter: boolean, setting?: string): boolean {
  if (setting === 'Not With Rpt Ftr' && pageNum === totalPages - 1 && hasReportFooter) return false;
  if (setting === 'Not With Rpt Hdr/Ftr' && pageNum === totalPages - 1 && hasReportFooter) return false;
  return true;
}

// ============================================================
// Page rendering
// ============================================================

function RenderPage({ pageNum, totalPages, elements, def, showPH, showPF }: {
  pageNum: number;
  totalPages: number;
  elements: FlatElement[];
  def: ReportDefinition;
  showPH: boolean;
  showPF: boolean;
}) {
  const pageHeight = (def as Record<string, unknown>)['page-height'] as number || 792;
  const pageWidth = (def as Record<string, unknown>)['page-width'] as number || 612;
  const reportWidth = (def as Record<string, unknown>)['report-width'] as number || pageWidth;
  const marginTop = (def as Record<string, unknown>)['margin-top'] as number || 72;
  const marginBottom = (def as Record<string, unknown>)['margin-bottom'] as number || 72;
  const marginLeft = (def as Record<string, unknown>)['margin-left'] as number || 72;
  const marginRight = (def as Record<string, unknown>)['margin-right'] as number || 72;

  return (
    <div className="report-page" style={{
      width: reportWidth + marginLeft + marginRight,
      minHeight: pageHeight,
      padding: `${marginTop}px ${marginRight}px ${marginBottom}px ${marginLeft}px`,
      backgroundColor: '#fff',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      marginBottom: 16,
    }}>
      {showPH && (
        <RenderSection sectionKey="page-header" def={def} record={elements[0]?.record || {}}
          exprContext={{ page: pageNum + 1, pages: totalPages }} />
      )}
      {elements.map(el => (
        <RenderSection key={el.key} sectionKey={el.sectionKey} def={def} record={el.record}
          exprContext={{ ...el.exprContext, page: pageNum + 1, pages: totalPages }} />
      ))}
      {showPF && (
        <RenderSection sectionKey="page-footer" def={def} record={elements[elements.length - 1]?.record || {}}
          exprContext={{ page: pageNum + 1, pages: totalPages }} />
      )}
    </div>
  );
}

// ============================================================
// Main preview component
// ============================================================

export default function ReportView() {
  const current = useReportStore(s => s.current);
  const records = useReportStore(s => s.records);

  const { pages, hasReportHeader, hasReportFooter } = useMemo(() => {
    if (!current || records.length === 0) {
      return { pages: [] as FlatElement[][], hasReportHeader: false, hasReportFooter: false };
    }
    const flat = buildFlatElements(current, records);
    const p = computePages(flat, current);
    return {
      pages: p,
      hasReportHeader: !!current['report-header'],
      hasReportFooter: !!current['report-footer'],
    };
  }, [current, records]);

  if (!current) return null;

  if (!current['record-source']) {
    return <div className="report-preview" style={{ padding: 24, color: '#999' }}>No record source set</div>;
  }
  if (records.length === 0) {
    return <div className="report-preview" style={{ padding: 24, color: '#999' }}>No data</div>;
  }

  const phSetting = (current as Record<string, unknown>)['page-header-setting'] as string | undefined;
  const pfSetting = (current as Record<string, unknown>)['page-footer-setting'] as string | undefined;

  return (
    <div className="report-preview" style={{ padding: 16, background: '#e8e8e8', overflow: 'auto' }}>
      {pages.map((pageElements, idx) => (
        <RenderPage
          key={idx}
          pageNum={idx}
          totalPages={pages.length}
          elements={pageElements}
          def={current}
          showPH={shouldShowPageHeader(idx, hasReportHeader, phSetting)}
          showPF={shouldShowPageFooter(idx, pages.length, hasReportFooter, pfSetting)}
        />
      ))}
    </div>
  );
}
