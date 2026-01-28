/**
 * Install log management
 * Tracks installation progress, commands run, and current state
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a new install log
 * @returns {object} New log object
 */
function createLog() {
  return {
    started: new Date().toISOString(),
    currentDirectory: process.cwd(),
    steps: []
  };
}

/**
 * Load install log from file
 * @param {string} logPath - Path to log file
 * @returns {object} Log object (new one if file doesn't exist)
 */
function loadLog(logPath) {
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error loading install log:', err.message);
  }
  return createLog();
}

/**
 * Save install log to file
 * @param {string} logPath - Path to log file
 * @param {object} log - Log object to save
 */
function saveLog(logPath, log) {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving install log:', err.message);
  }
}

/**
 * Add a step to the log
 * @param {object} log - Log object
 * @param {object} step - Step details
 * @param {string} step.command - Command that was run
 * @param {string} step.cwd - Working directory
 * @param {number} step.exitCode - Exit code
 * @param {string} step.stdout - Standard output
 * @param {string} step.stderr - Standard error
 * @param {boolean} step.timedOut - Whether command timed out
 * @returns {object} Updated log
 */
function addStep(log, step) {
  const truncateOutput = (text, maxLength = 500) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '\n... (truncated)';
  };

  const newStep = {
    time: new Date().toISOString(),
    command: step.command,
    cwd: step.cwd || log.currentDirectory,
    exitCode: step.exitCode,
    output: truncateOutput(step.stdout || step.stderr),
    status: step.timedOut ? 'timeout' : (step.exitCode === 0 ? 'success' : 'failed')
  };

  log.steps.push(newStep);

  // Update current directory if command was a cd
  if (step.command.toLowerCase().startsWith('cd ') || step.command.toLowerCase().startsWith('set-location ')) {
    // Try to extract the new directory from the command
    const match = step.command.match(/^(?:cd|set-location)\s+["']?(.+?)["']?\s*$/i);
    if (match && step.exitCode === 0) {
      log.currentDirectory = match[1];
    }
  }

  return log;
}

/**
 * Update the current directory in the log
 * @param {object} log - Log object
 * @param {string} directory - New current directory
 * @returns {object} Updated log
 */
function setCurrentDirectory(log, directory) {
  log.currentDirectory = directory;
  return log;
}

/**
 * Generate a summary of the log for LLM context
 * @param {object} log - Log object
 * @returns {string} Human-readable summary
 */
function generateSummary(log) {
  if (!log.steps || log.steps.length === 0) {
    return 'No commands have been run yet.';
  }

  const lines = [
    `## Installation Progress`,
    `Started: ${log.started}`,
    `Current directory: ${log.currentDirectory}`,
    ``,
    `### Commands Run (${log.steps.length} total)`,
    ``
  ];

  // Show last 10 steps to keep context manageable
  const recentSteps = log.steps.slice(-10);
  const skipped = log.steps.length - recentSteps.length;

  if (skipped > 0) {
    lines.push(`... (${skipped} earlier steps omitted)`);
    lines.push('');
  }

  recentSteps.forEach((step, i) => {
    const icon = step.status === 'success' ? '✓' : (step.status === 'timeout' ? '⏱' : '✗');
    lines.push(`${icon} \`${step.command}\``);
    lines.push(`  Directory: ${step.cwd}`);
    lines.push(`  Status: ${step.status}${step.exitCode !== 0 ? ` (exit code ${step.exitCode})` : ''}`);
    if (step.output) {
      lines.push(`  Output: ${step.output.split('\n')[0]}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Get count of successful vs failed steps
 * @param {object} log - Log object
 * @returns {object} Counts {total, success, failed, timeout}
 */
function getStepCounts(log) {
  const counts = { total: 0, success: 0, failed: 0, timeout: 0 };

  if (log.steps) {
    counts.total = log.steps.length;
    log.steps.forEach(step => {
      if (step.status === 'success') counts.success++;
      else if (step.status === 'timeout') counts.timeout++;
      else counts.failed++;
    });
  }

  return counts;
}

module.exports = {
  createLog,
  loadLog,
  saveLog,
  addStep,
  setCurrentDirectory,
  generateSummary,
  getStepCounts
};
