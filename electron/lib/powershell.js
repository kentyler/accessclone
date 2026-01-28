/**
 * PowerShell command execution
 * Runs PowerShell commands and captures output
 */

const { spawn } = require('child_process');

/**
 * Default timeout for commands (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Run a PowerShell command
 * @param {string} command - PowerShell command to execute
 * @param {object} options - Execution options
 * @param {string} options.cwd - Working directory
 * @param {number} options.timeout - Timeout in milliseconds
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function runPowerShell(command, options = {}) {
  const { cwd = process.cwd(), timeout = DEFAULT_TIMEOUT } = options;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
      cwd,
      windowsHide: true
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      ps.kill('SIGTERM');
    }, timeout);

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      clearTimeout(timeoutId);

      if (timedOut) {
        resolve({
          exitCode: -1,
          stdout: stdout.trim(),
          stderr: 'Command timed out',
          timedOut: true
        });
      } else {
        resolve({
          exitCode: code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut: false
        });
      }
    });

    ps.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Run multiple PowerShell commands in sequence
 * @param {string[]} commands - Array of commands to run
 * @param {object} options - Execution options
 * @returns {Promise<Array<{command: string, exitCode: number, stdout: string, stderr: string}>>}
 */
async function runPowerShellSequence(commands, options = {}) {
  const results = [];

  for (const command of commands) {
    const result = await runPowerShell(command, options);
    results.push({ command, ...result });

    // Stop on first failure if specified
    if (options.stopOnError && result.exitCode !== 0) {
      break;
    }
  }

  return results;
}

/**
 * Test if PowerShell is available
 * @returns {Promise<boolean>}
 */
async function isPowerShellAvailable() {
  try {
    const result = await runPowerShell('$PSVersionTable.PSVersion.Major', { timeout: 5000 });
    return result.exitCode === 0 && result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_TIMEOUT,
  runPowerShell,
  runPowerShellSequence,
  isPowerShellAvailable
};
