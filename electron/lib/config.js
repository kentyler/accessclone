/**
 * Configuration management
 * Handles loading and saving user configuration
 */

const fs = require('fs');
const path = require('path');

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  apiKey: null,
  llmProvider: null,         // "Claude", "GPT-4", etc.
  setupComplete: false,
  project: {
    name: null,              // "calculator"
    sourceDatabases: [],     // ["C:\\...\\Calculator.accdb", "C:\\...\\Calculator_Data.accdb"]
    destinationPath: null    // "C:\\Projects"
  },
  database: {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: null,
    database: null           // gets set to project.name
  }
};

/**
 * Load configuration from a JSON file
 * @param {string} configPath - Path to config file
 * @returns {object} Configuration object (defaults if file missing/invalid)
 */
function loadConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(content);
      // Merge with defaults to ensure all keys exist
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (err) {
    console.error('Error loading config:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save configuration to a JSON file
 * @param {string} configPath - Path to config file
 * @param {object} config - Configuration object to save
 * @throws {Error} If write fails
 */
function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Update specific config values (merge)
 * @param {string} configPath - Path to config file
 * @param {object} updates - Values to update
 * @returns {object} Updated configuration
 */
function updateConfig(configPath, updates) {
  const current = loadConfig(configPath);
  const updated = { ...current, ...updates };
  saveConfig(configPath, updated);
  return updated;
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  updateConfig
};
