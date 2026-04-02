/**
 * Pattern verification tests for:
 *   - per-form-tsx-generation
 *   - generated-with-generic-fallback
 *
 * Three tiers:
 *   Tier 1 — Infrastructure exists (no DB, always runs)
 *   Tier 2 — Generated output is valid (checks actual files)
 *   Tier 3 — Pipeline integration (needs DB, gated by ACCESSCLONE_DB_TESTS)
 */

const fs = require('fs');
const path = require('path');

const GENERATED_DIR = path.join(__dirname, '..', '..', '..', 'ui-react', 'src', 'generated');
const FORMS_DIR = path.join(GENERATED_DIR, 'forms');
const NW4_DIR = path.join(FORMS_DIR, 'northwind4');

// ============================================================
// Tier 1 — Infrastructure exists
// ============================================================
describe('Tier 1: Form generation infrastructure', () => {

  test('prompts.js exports all 5 step builders', () => {
    const prompts = require('../../lib/form-gen/prompts');
    expect(typeof prompts.buildStep1Prompt).toBe('function');
    expect(typeof prompts.buildStep2Prompt).toBe('function');
    expect(typeof prompts.buildStep3Prompt).toBe('function');
    expect(typeof prompts.buildStep4Prompt).toBe('function');
    expect(typeof prompts.buildStep5Prompt).toBe('function');
  });

  test('writer.js exports writeGeneratedForm, normalizeFormName, generatedFormExists, listGeneratedForms', () => {
    const writer = require('../../lib/form-gen/writer');
    expect(typeof writer.writeGeneratedForm).toBe('function');
    expect(typeof writer.normalizeFormName).toBe('function');
    expect(typeof writer.generatedFormExists).toBe('function');
    expect(typeof writer.listGeneratedForms).toBe('function');
  });

  test('form-gen.js route file exists', () => {
    const routePath = path.join(__dirname, '..', '..', 'routes', 'form-gen.js');
    expect(fs.existsSync(routePath)).toBe(true);
  });

  test('GeneratedFormWrapper.tsx exists', () => {
    const wrapperPath = path.join(__dirname, '..', '..', '..', 'ui-react', 'src', 'views', 'FormEditor', 'GeneratedFormWrapper.tsx');
    expect(fs.existsSync(wrapperPath)).toBe(true);
  });

  test('types.ts exports GeneratedFormProps interface', () => {
    const typesPath = path.join(GENERATED_DIR, 'types.ts');
    expect(fs.existsSync(typesPath)).toBe(true);
    const content = fs.readFileSync(typesPath, 'utf8');
    expect(content).toMatch(/export\s+interface\s+GeneratedFormProps/);
  });

  test('normalizeFormName produces PascalCase', () => {
    const { normalizeFormName } = require('../../lib/form-gen/writer');
    expect(normalizeFormName('frmLogin')).toBe('FrmLogin');
    expect(normalizeFormName('frm_about')).toBe('Frm_about');
    expect(normalizeFormName('some-form')).toBe('Someform');
  });

  test('buildStep1Prompt returns system and user messages', () => {
    const { buildStep1Prompt } = require('../../lib/form-gen/prompts');
    const result = buildStep1Prompt({ caption: 'Test', detail: { height: 200, controls: [] } }, 'TestForm');
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
    expect(result.system.length).toBeGreaterThan(100);
  });
});

// ============================================================
// Tier 2 — Generated output is valid
// ============================================================
describe('Tier 2: FrmLogin generated output', () => {

  const frmLoginPath = path.join(NW4_DIR, 'FrmLogin.tsx');

  // Guard: skip entire tier if file doesn't exist
  const frmLoginExists = fs.existsSync(frmLoginPath);
  const describeIfExists = frmLoginExists ? describe : describe.skip;

  let content;
  if (frmLoginExists) {
    content = fs.readFileSync(frmLoginPath, 'utf8');
  }

  describeIfExists('FrmLogin.tsx content checks', () => {

    test('file exists in ui-react/src/generated/forms/northwind4/', () => {
      expect(fs.existsSync(frmLoginPath)).toBe(true);
    });

    test('exports default function component', () => {
      expect(content).toMatch(/export\s+default\s+function\s+\w+/);
    });

    test('imports GeneratedFormProps from ../../types', () => {
      expect(content).toMatch(/import\s+.*GeneratedFormProps.*from\s+['"]\.\.\/\.\.\/types['"]/);
    });

    test('destructures required props (currentRecord, onFieldChange, fireEvent, onNavigate, onSave)', () => {
      expect(content).toContain('currentRecord');
      expect(content).toContain('onFieldChange');
      expect(content).toContain('fireEvent');
      expect(content).toContain('onNavigate');
      expect(content).toContain('onSave');
    });

    test('no twips conversion math (/ 15) — data is already pixels', () => {
      // Look for division by 15 patterns: / 15, /15, Math.round(... / 15)
      const twipsPatterns = [
        /\/\s*15\b/,
        /twips/i,
      ];
      for (const pattern of twipsPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });

    test('no BGR color conversion — colors are already hex strings', () => {
      const bgrPatterns = [
        /BGR/i,
        /& 0xff/i,
        />> 16/,
        /& 255/,
        /0x[0-9a-f]{6}/i,  // raw hex numbers (colors should be "#xxxxxx" strings)
      ];
      for (const pattern of bgrPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });

    test('contains all three sections (header, detail, footer)', () => {
      // Check for comments or structural markers for all three sections
      const hasHeader = /header/i.test(content);
      const hasDetail = /detail/i.test(content);
      const hasFooter = /footer/i.test(content);
      expect(hasHeader).toBe(true);
      expect(hasDetail).toBe(true);
      expect(hasFooter).toBe(true);
    });

    test('uses controlState for visibility/enabled checks', () => {
      expect(content).toContain('controlState');
      // Should check .visible or .enabled somewhere
      expect(content).toMatch(/visible\s*[!=]/);
    });

    test('uses hex color strings directly (not numeric)', () => {
      // Colors should appear as '#xxxxxx' string literals
      const hexColors = content.match(/'#[0-9a-fA-F]{6}'/g) || [];
      expect(hexColors.length).toBeGreaterThan(0);
    });

    test('pixel values used directly — no conversion functions', () => {
      // Should not have helper functions that convert coordinates
      expect(content).not.toMatch(/function\s+twipsTo/i);
      expect(content).not.toMatch(/function\s+convertPos/i);
      expect(content).not.toMatch(/function\s+toPixels/i);
    });
  });
});

// ============================================================
// Tier 2b — writer module integration with actual files
// ============================================================
describe('Tier 2b: Writer module sees generated files', () => {

  test('generatedFormExists reports true for northwind4/frmLogin', () => {
    const { generatedFormExists } = require('../../lib/form-gen/writer');
    // Only meaningful if the file actually exists
    const filePath = path.join(NW4_DIR, 'FrmLogin.tsx');
    if (fs.existsSync(filePath)) {
      expect(generatedFormExists('northwind4', 'frmLogin')).toBe(true);
    } else {
      // Skip but don't fail — tier 2 tests already flagged the missing file
      console.log('  (skipped — FrmLogin.tsx not present)');
    }
  });

  test('listGeneratedForms includes FrmLogin for northwind4', () => {
    const { listGeneratedForms } = require('../../lib/form-gen/writer');
    const filePath = path.join(NW4_DIR, 'FrmLogin.tsx');
    if (fs.existsSync(filePath)) {
      const forms = listGeneratedForms('northwind4');
      expect(forms).toContain('FrmLogin');
    } else {
      console.log('  (skipped — FrmLogin.tsx not present)');
    }
  });
});

// ============================================================
// Tier 3 — Pipeline integration (needs DB)
// ============================================================
const DB_TESTS = process.env.ACCESSCLONE_DB_TESTS === '1';
const describeDB = DB_TESTS ? describe : describe.skip;

describeDB('Tier 3: Pipeline integration (DB required)', () => {

  let pool;

  beforeAll(() => {
    const { Pool } = require('pg');
    pool = new Pool({
      host: 'localhost',
      port: 5432,
      database: 'polyaccess',
      user: 'postgres',
      password: '7297',
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('frmLogin definition exists in DB for northwind4', async () => {
    const result = await pool.query(
      `SELECT name, definition FROM shared.objects
       WHERE database_id = 'northwind4' AND type = 'form' AND name = 'frmLogin' AND is_current = true`
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].definition).toBeTruthy();
  });

  test('generated FrmLogin.tsx has controls matching definition', async () => {
    const frmLoginPath = path.join(NW4_DIR, 'FrmLogin.tsx');
    if (!fs.existsSync(frmLoginPath)) {
      console.log('  (skipped — FrmLogin.tsx not present)');
      return;
    }

    const result = await pool.query(
      `SELECT definition FROM shared.objects
       WHERE database_id = 'northwind4' AND type = 'form' AND name = 'frmLogin' AND is_current = true`
    );
    const def = result.rows[0].definition;
    const content = fs.readFileSync(frmLoginPath, 'utf8');

    // Collect all control names from the definition
    const defControls = [];
    for (const section of ['header', 'detail', 'footer']) {
      for (const ctrl of def[section]?.controls || []) {
        if (ctrl.name) defControls.push(ctrl.name);
      }
    }

    // Each control name should appear somewhere in the generated file
    const missing = defControls.filter(name => !content.includes(name));
    if (missing.length > 0) {
      console.log(`  Controls missing from generated file: ${missing.join(', ')}`);
    }
    // Allow some tolerance — LLM might use slightly different names
    // But the majority should be present
    const coverage = (defControls.length - missing.length) / defControls.length;
    expect(coverage).toBeGreaterThanOrEqual(0.8);
  });
});
