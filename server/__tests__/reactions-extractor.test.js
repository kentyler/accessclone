const { extractReactions } = require('../lib/reactions-extractor');

// ============================================================
// Helpers — realistic procedure shapes
// ============================================================

// A flat AfterUpdate: Me.Subform1.Visible = True (no branching)
const flatVisible = {
  name: 'chkShowDetails_AfterUpdate',
  trigger: 'after-update',
  intents: [
    { type: 'set-control-visible', control: 'Details', value: true },
    { type: 'set-control-enabled', control: 'BtnEdit', value: false }
  ]
};

// A value-switch AfterUpdate: option group → which subform is visible
// This is what the LLM should produce after the prompt update.
const optionGroupSwitch = {
  name: 'OptionGroup1_AfterUpdate',
  trigger: 'after-update',
  intents: [{
    type: 'value-switch',
    field: 'OptionGroup1',
    cases: [
      {
        when: 1,
        then: [
          { type: 'set-control-visible', control: 'SubformCustomers', value: true },
          { type: 'set-control-visible', control: 'SubformOrders',    value: false },
          { type: 'set-control-visible', control: 'SubformProducts',  value: false }
        ]
      },
      {
        when: 2,
        then: [
          { type: 'set-control-visible', control: 'SubformCustomers', value: false },
          { type: 'set-control-visible', control: 'SubformOrders',    value: true },
          { type: 'set-control-visible', control: 'SubformProducts',  value: false }
        ]
      },
      {
        when: 3,
        then: [
          { type: 'set-control-visible', control: 'SubformCustomers', value: false },
          { type: 'set-control-visible', control: 'SubformOrders',    value: false },
          { type: 'set-control-visible', control: 'SubformProducts',  value: true }
        ]
      }
    ]
  }]
};

// A category switch that also sets caption
const categorySwitch = {
  name: 'Category_AfterUpdate',
  trigger: 'after-update',
  intents: [{
    type: 'value-switch',
    field: 'Category',
    cases: [
      {
        when: 'A',
        then: [
          { type: 'set-control-visible', control: 'PanelA', value: true },
          { type: 'set-control-visible', control: 'PanelB', value: false },
          { type: 'set-control-value',   control: 'lblStatus', value: 'Category A selected' }
        ]
      },
      {
        when: 'B',
        then: [
          { type: 'set-control-visible', control: 'PanelA', value: false },
          { type: 'set-control-visible', control: 'PanelB', value: true },
          { type: 'set-control-value',   control: 'lblStatus', value: 'Category B selected' }
        ]
      }
    ]
  }]
};

// Should be skipped: has a DLookup (async)
const asyncProc = {
  name: 'CustomerID_AfterUpdate',
  trigger: 'after-update',
  intents: [
    { type: 'dlookup', field: 'CompanyName', table: 'Customers', criteria: 'ID=1' }
  ]
};

// Should be skipped: general branch (condition string, not value-switch)
const generalBranch = {
  name: 'Status_AfterUpdate',
  trigger: 'after-update',
  intents: [{
    type: 'branch',
    condition: 'Me.Status > 2 And Me.Status < 5',
    then: [{ type: 'set-control-visible', control: 'Warning', value: true }]
  }]
};

// Should be skipped: value-switch with a non-simple effect (gap)
const switchWithGap = {
  name: 'Mode_AfterUpdate',
  trigger: 'after-update',
  intents: [{
    type: 'value-switch',
    field: 'Mode',
    cases: [
      { when: 1, then: [{ type: 'gap', vba_line: 'DoCmd.TransferSpreadsheet ...' }] }
    ]
  }]
};

// Not an AfterUpdate handler — should be ignored
const clickHandler = {
  name: 'btnSave_Click',
  trigger: 'on-click',
  intents: [{ type: 'save-record' }]
};

// ============================================================
// Flat (Path 1) extraction
// ============================================================

describe('flat set-control-* handlers', () => {
  test('extracts visible and enabled from flat handler', () => {
    const specs = extractReactions([flatVisible]);
    expect(specs).toHaveLength(2);
    // toKw lowercases and replaces non-alphanumeric — no camelCase splitting
    expect(specs[0]).toEqual({ trigger: 'chkshowdetails', ctrl: 'details', prop: 'visible', value: true });
    expect(specs[1]).toEqual({ trigger: 'chkshowdetails', ctrl: 'btnedit', prop: 'enabled', value: false });
  });

  test('ignores non-AfterUpdate triggers', () => {
    expect(extractReactions([clickHandler])).toEqual([]);
  });

  test('skips handlers with async intents', () => {
    expect(extractReactions([asyncProc])).toEqual([]);
  });

  test('skips general branch handlers', () => {
    expect(extractReactions([generalBranch])).toEqual([]);
  });

  test('returns empty for null/empty procedures', () => {
    expect(extractReactions(null)).toEqual([]);
    expect(extractReactions([])).toEqual([]);
  });
});

// ============================================================
// Value-switch (Path 2) extraction
// ============================================================

describe('value-switch handlers', () => {
  test('transposes option group switch into per-(ctrl,prop) case specs', () => {
    const specs = extractReactions([optionGroupSwitch]);
    // 3 controls × 1 prop = 3 specs
    expect(specs).toHaveLength(3);

    const byCtrl = Object.fromEntries(specs.map(s => [s.ctrl, s]));

    expect(byCtrl['subformcustomers']).toMatchObject({
      trigger: 'optiongroup1',
      ctrl: 'subformcustomers',
      prop: 'visible',
      cases: [
        { when: 1, then: true },
        { when: 2, then: false },
        { when: 3, then: false }
      ]
    });

    expect(byCtrl['subformorders']).toMatchObject({
      cases: [{ when: 1, then: false }, { when: 2, then: true }, { when: 3, then: false }]
    });

    expect(byCtrl['subformproducts']).toMatchObject({
      cases: [{ when: 1, then: false }, { when: 2, then: false }, { when: 3, then: true }]
    });
  });

  test('handles string when values', () => {
    const specs = extractReactions([categorySwitch]);
    // 2 visible + 1 caption = 3 distinct (ctrl, prop) keys — but panel-a and panel-b each appear once
    // panel-a visible: [{when:A,then:true},{when:B,then:false}]
    expect(specs.length).toBeGreaterThan(0);
    const panelA = specs.find(s => s.ctrl === 'panela' && s.prop === 'visible');
    expect(panelA).toBeDefined();
    expect(panelA.cases).toEqual([{ when: 'A', then: true }, { when: 'B', then: false }]);

    const status = specs.find(s => s.ctrl === 'lblstatus' && s.prop === 'caption');
    expect(status).toBeDefined();
    expect(status.cases[0]).toEqual({ when: 'A', then: 'Category A selected' });
  });

  test('skips value-switch with gap effects', () => {
    expect(extractReactions([switchWithGap])).toEqual([]);
  });

  test('all specs have cases array, not value', () => {
    const specs = extractReactions([optionGroupSwitch]);
    for (const s of specs) {
      expect(s).toHaveProperty('cases');
      expect(s).not.toHaveProperty('value');
    }
  });
});

// ============================================================
// Mixed procedures
// ============================================================

describe('mixed procedures', () => {
  test('extracts from multiple procedures, skips invalid ones', () => {
    const specs = extractReactions([
      flatVisible,
      optionGroupSwitch,
      asyncProc,
      generalBranch,
      clickHandler
    ]);
    // flatVisible → 2 specs, optionGroupSwitch → 3 specs, rest skipped
    expect(specs).toHaveLength(5);
  });
});
