/**
 * Tests for config.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, saveConfig, updateConfig, DEFAULT_CONFIG } = require('../lib/config');

describe('config', () => {
  let tempDir;
  let configPath;

  beforeEach(() => {
    // Create temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tempDir, 'config.json');
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadConfig', () => {
    it('returns default config when file does not exist', () => {
      const config = loadConfig(configPath);
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('loads config from existing file', () => {
      const testConfig = { apiKey: 'test-key', setupComplete: true };
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBe('test-key');
      expect(config.setupComplete).toBe(true);
    });

    it('merges with defaults for missing keys', () => {
      const partialConfig = { apiKey: 'test-key' };
      fs.writeFileSync(configPath, JSON.stringify(partialConfig));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBe('test-key');
      expect(config.database).toEqual(DEFAULT_CONFIG.database);
    });

    it('returns default config on invalid JSON', () => {
      fs.writeFileSync(configPath, 'not valid json {{{');

      const config = loadConfig(configPath);
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('returns default config on empty file', () => {
      fs.writeFileSync(configPath, '');

      const config = loadConfig(configPath);
      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('saveConfig', () => {
    it('saves config to file', () => {
      const testConfig = { apiKey: 'saved-key', setupComplete: true };

      saveConfig(configPath, testConfig);

      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.apiKey).toBe('saved-key');
    });

    it('creates directory if it does not exist', () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'config.json');

      saveConfig(nestedPath, { test: true });

      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('overwrites existing file', () => {
      fs.writeFileSync(configPath, JSON.stringify({ old: 'value' }));

      saveConfig(configPath, { new: 'value' });

      const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(content.old).toBeUndefined();
      expect(content.new).toBe('value');
    });
  });

  describe('updateConfig', () => {
    it('merges updates with existing config', () => {
      fs.writeFileSync(configPath, JSON.stringify({ apiKey: 'original', other: 'value' }));

      const updated = updateConfig(configPath, { apiKey: 'updated' });

      expect(updated.apiKey).toBe('updated');
      expect(updated.other).toBe('value');
    });

    it('creates config if file does not exist', () => {
      const updated = updateConfig(configPath, { apiKey: 'new-key' });

      expect(updated.apiKey).toBe('new-key');
      expect(fs.existsSync(configPath)).toBe(true);
    });
  });
});
