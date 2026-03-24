import { describe, it, expect } from 'vitest';
import {
  buildProjection, hydrateBindings, updateField, syncRecords, syncPosition,
  populateRowSource, setControlState, registerReaction, registerEventHandlers,
  getEventHandler,
} from './projection';
import type { FormDefinition, Section, Control } from '@/api/types';

function makeForm(controls: Partial<Control>[], section: 'header' | 'detail' | 'footer' = 'detail'): FormDefinition {
  return {
    [section]: { controls: controls as Control[] } as Section,
  } as FormDefinition;
}

// ============================================================
// buildProjection
// ============================================================

describe('buildProjection', () => {
  it('extracts bindings from field controls', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtName', field: 'name' },
      { type: 'text-box', name: 'txtAge', field: 'age' },
    ]);
    const proj = buildProjection(form);
    expect(proj.bindings).toHaveProperty('name');
    expect(proj.bindings).toHaveProperty('age');
  });

  it('extracts computed fields from =expressions', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtTotal', 'control-source': '=[Price]*[Qty]' } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    expect(proj.computed).toHaveProperty('txttotal');
    expect(proj.computed.txttotal.expression).toBe('[Price]*[Qty]');
    expect(proj.computed.txttotal.deps).toContain('price');
    expect(proj.computed.txttotal.deps).toContain('qty');
  });

  it('extracts row sources from combo-box controls', () => {
    const form = makeForm([
      {
        type: 'combo-box', name: 'cboStatus', field: 'status',
        'row-source': 'Active;Inactive;Pending',
      } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    expect(proj.rowSources).toHaveProperty('status');
    expect(proj.rowSources.status.type).toBe('value-list');
    expect(proj.rowSources.status.options?.rows).toHaveLength(3);
  });

  it('extracts subforms', () => {
    const form = makeForm([
      {
        type: 'sub-form', name: 'sfOrders',
        'source-form': 'OrderDetails',
        'link-master-fields': 'id',
        'link-child-fields': 'order_id',
      } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    expect(proj.subforms).toHaveProperty('orderdetails');
    expect(proj.subforms.orderdetails.link.master).toBe('id');
  });

  it('extracts form-level events', () => {
    const form = {
      detail: { controls: [] },
      'has-load-event': true,
      'has-current-event': true,
    } as unknown as FormDefinition;
    const proj = buildProjection(form);
    expect(proj.events['has-load-event']).toBe(true);
    expect(proj.events['has-current-event']).toBe(true);
  });

  it('extracts control-level event flags', () => {
    const form = makeForm([
      {
        type: 'command-button', name: 'btnSave',
        'has-click-event': true,
      } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    expect(proj.fieldTriggers).toHaveProperty('btnsave');
    expect(proj.fieldTriggers.btnsave['has-click-event']).toBe(true);
  });

  it('extracts control state (visible, enabled, locked, caption)', () => {
    const form = makeForm([
      { type: 'text-box', name: 'TxtField', visible: 1, enabled: 0, locked: 1, caption: 'My Field' },
    ]);
    const proj = buildProjection(form);
    expect(proj.controlState['txt-field']).toEqual({
      visible: true,
      enabled: false,
      locked: true,
      caption: 'My Field',
    });
  });

  it('initializes with empty records, position=0, dirty=false', () => {
    const proj = buildProjection(makeForm([]));
    expect(proj.records).toEqual([]);
    expect(proj.position).toBe(0);
    expect(proj.total).toBe(0);
    expect(proj.dirty).toBe(false);
  });

  it('sets recordSource from definition', () => {
    const form = { detail: { controls: [] }, 'record-source': 'employees' } as unknown as FormDefinition;
    const proj = buildProjection(form);
    expect(proj.recordSource).toBe('employees');
  });

  it('scans controls from all sections', () => {
    const form = {
      header: { controls: [{ type: 'label', name: 'lblTitle', field: 'title' }] },
      detail: { controls: [{ type: 'text-box', name: 'txtName', field: 'name' }] },
      footer: { controls: [{ type: 'text-box', name: 'txtTotal', 'control-source': '=Sum([amount])' }] },
    } as unknown as FormDefinition;
    const proj = buildProjection(form);
    expect(proj.bindings).toHaveProperty('title');
    expect(proj.bindings).toHaveProperty('name');
    expect(proj.computed).toHaveProperty('txttotal');
  });
});

// ============================================================
// hydrateBindings
// ============================================================

describe('hydrateBindings', () => {
  it('fills binding values from record (case-insensitive)', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtName', field: 'name' },
    ]);
    const proj = buildProjection(form);
    const hydrated = hydrateBindings(proj, { Name: 'Alice' });
    expect(hydrated.bindings.name).toBe('Alice');
    expect(hydrated.record.name).toBe('Alice');
  });

  it('evaluates computed fields', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtPrice', field: 'price' },
      { type: 'text-box', name: 'txtQty', field: 'qty' },
      { type: 'text-box', name: 'txtTotal', 'control-source': '=[price]*[qty]' } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    const hydrated = hydrateBindings(proj, { price: 10, qty: 3 });
    expect(hydrated.computed.txttotal.value).toBe(30);
  });

  it('handles null/invalid record gracefully', () => {
    const form = makeForm([{ type: 'text-box', name: 'txtName', field: 'name' }]);
    const proj = buildProjection(form);
    const result = hydrateBindings(proj, null as unknown as Record<string, unknown>);
    expect(result).toBe(proj);
  });
});

// ============================================================
// updateField
// ============================================================

describe('updateField', () => {
  it('updates binding and record, sets dirty', () => {
    const form = makeForm([{ type: 'text-box', name: 'txtName', field: 'name' }]);
    const proj = buildProjection(form);
    hydrateBindings(proj, { name: 'Alice' });
    const updated = updateField(proj, 'name', 'Bob');
    expect(updated.bindings.name).toBe('Bob');
    expect(updated.record.name).toBe('Bob');
    expect(updated.dirty).toBe(true);
  });

  it('re-evaluates dependent computed fields', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtPrice', field: 'price' },
      { type: 'text-box', name: 'txtQty', field: 'qty' },
      { type: 'text-box', name: 'txtTotal', 'control-source': '=[price]*[qty]' } as unknown as Partial<Control>,
    ]);
    const proj = buildProjection(form);
    hydrateBindings(proj, { price: 10, qty: 3 });
    expect(proj.computed.txttotal.value).toBe(30);

    updateField(proj, 'price', 20);
    expect(proj.computed.txttotal.value).toBe(60);
  });
});

// ============================================================
// syncRecords / syncPosition
// ============================================================

describe('syncRecords', () => {
  it('stores records and hydrates at position', () => {
    const form = makeForm([{ type: 'text-box', name: 'txtName', field: 'name' }]);
    const proj = buildProjection(form);
    const records = [{ name: 'Alice' }, { name: 'Bob' }];
    const synced = syncRecords(proj, records, 1, 2);
    expect(synced.records).toHaveLength(2);
    expect(synced.position).toBe(1);
    expect(synced.total).toBe(2);
    expect(synced.bindings.name).toBe('Alice');
  });
});

describe('syncPosition', () => {
  it('re-hydrates from stored records at new position', () => {
    const form = makeForm([{ type: 'text-box', name: 'txtName', field: 'name' }]);
    const proj = buildProjection(form);
    syncRecords(proj, [{ name: 'Alice' }, { name: 'Bob' }], 1, 2);
    const moved = syncPosition(proj, 2);
    expect(moved.position).toBe(2);
    expect(moved.bindings.name).toBe('Bob');
  });
});

// ============================================================
// populateRowSource
// ============================================================

describe('populateRowSource', () => {
  it('sets options on matching row source', () => {
    const form = makeForm([{
      type: 'combo-box', name: 'cboStatus', field: 'status',
      'row-source': 'Active;Inactive',
    } as unknown as Partial<Control>]);
    const proj = buildProjection(form);
    const data = { rows: [{ id: 1 }], fields: [{ name: 'id' }] };
    populateRowSource(proj, 'Active;Inactive', data);
    expect(proj.rowSources.status.options).toBe(data);
  });
});

// ============================================================
// setControlState
// ============================================================

describe('setControlState', () => {
  it('sets a control property', () => {
    const form = makeForm([{ type: 'text-box', name: 'TxtField' }]);
    const proj = buildProjection(form);
    setControlState(proj, 'txt-field', 'visible', false);
    expect(proj.controlState['txt-field'].visible).toBe(false);
  });

  it('no-ops for unknown control', () => {
    const proj = buildProjection(makeForm([]));
    // should not throw
    setControlState(proj, 'nonexistent', 'visible', false);
  });
});

// ============================================================
// registerReaction
// ============================================================

describe('registerReaction', () => {
  it('registers and fires on hydrate', () => {
    const form = makeForm([
      { type: 'text-box', name: 'txtName', field: 'name' },
      { type: 'command-button', name: 'BtnSave' },
    ]);
    const proj = buildProjection(form);
    registerReaction(proj, 'name', 'btn-save', 'enabled', (val) => !!val);
    hydrateBindings(proj, { name: '' });
    expect(proj.controlState['btn-save'].enabled).toBe(false);

    hydrateBindings(proj, { name: 'Alice' });
    expect(proj.controlState['btn-save'].enabled).toBe(true);
  });
});

// ============================================================
// registerEventHandlers / getEventHandler
// ============================================================

describe('registerEventHandlers', () => {
  it('stores handlers and retrieves by name + event', () => {
    const form = makeForm([{ type: 'command-button', name: 'BtnSave' }]);
    const proj = buildProjection(form);
    registerEventHandlers(proj, [
      { key: 'btn-save.on-click', control: 'BtnSave', event: 'on-click', js: 'console.log("save")' },
    ]);
    const handler = getEventHandler(proj, 'BtnSave', 'on-click');
    expect(handler).not.toBeNull();
    expect(handler!.js).toBe('console.log("save")');
  });

  it('returns null for missing handler', () => {
    const proj = buildProjection(makeForm([]));
    expect(getEventHandler(proj, 'BtnSave', 'on-click')).toBeNull();
  });
});
