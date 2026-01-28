/**
 * Tests for powershell.js
 *
 * Note: These tests require PowerShell to be available on the system.
 * On non-Windows systems, tests will be skipped.
 */

const { runPowerShell, runPowerShellSequence, isPowerShellAvailable, DEFAULT_TIMEOUT } = require('../lib/powershell');
const { execSync } = require('child_process');

// Check if PowerShell is available (works on Windows and WSL)
let hasPowerShell = false;
try {
  execSync('powershell.exe -NoProfile -Command "exit 0"', { stdio: 'ignore' });
  hasPowerShell = true;
} catch {
  hasPowerShell = false;
}

describe('powershell', () => {
  describe('constants', () => {
    it('exports DEFAULT_TIMEOUT', () => {
      expect(DEFAULT_TIMEOUT).toBe(30000);
    });
  });

  // Only run PowerShell tests when PowerShell is available
  const describeIfPowerShell = hasPowerShell ? describe : describe.skip;

  describeIfPowerShell('runPowerShell', () => {
    it('executes simple command and returns output', async () => {
      const result = await runPowerShell('Write-Output "hello"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello');
      expect(result.timedOut).toBe(false);
    });

    it('captures exit code for failed commands', async () => {
      const result = await runPowerShell('exit 1');

      expect(result.exitCode).toBe(1);
    });

    it('captures stderr output', async () => {
      const result = await runPowerShell('Write-Error "error message" 2>&1');

      // PowerShell writes errors differently, just check it captured something
      expect(result.exitCode).not.toBe(0);
    });

    it('respects timeout option', async () => {
      const result = await runPowerShell('Start-Sleep -Seconds 10', { timeout: 100 });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toBe('Command timed out');
    }, 5000);

    it('uses specified working directory', async () => {
      const os = require('os');
      const homeDir = os.homedir();

      const result = await runPowerShell('Get-Location | Select-Object -ExpandProperty Path', { cwd: homeDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(homeDir.replace(/\//g, '\\'));
    });

    it('handles command with special characters', async () => {
      const result = await runPowerShell('Write-Output "test & test"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test & test');
    });
  });

  describeIfPowerShell('runPowerShellSequence', () => {
    it('runs multiple commands in sequence', async () => {
      const commands = [
        'Write-Output "first"',
        'Write-Output "second"',
        'Write-Output "third"'
      ];

      const results = await runPowerShellSequence(commands);

      expect(results).toHaveLength(3);
      expect(results[0].stdout).toBe('first');
      expect(results[1].stdout).toBe('second');
      expect(results[2].stdout).toBe('third');
    });

    it('continues on error by default', async () => {
      const commands = [
        'Write-Output "first"',
        'exit 1',
        'Write-Output "third"'
      ];

      const results = await runPowerShellSequence(commands);

      expect(results).toHaveLength(3);
      expect(results[0].exitCode).toBe(0);
      expect(results[1].exitCode).toBe(1);
      expect(results[2].exitCode).toBe(0);
    });

    it('stops on error when stopOnError is true', async () => {
      const commands = [
        'Write-Output "first"',
        'exit 1',
        'Write-Output "third"'
      ];

      const results = await runPowerShellSequence(commands, { stopOnError: true });

      expect(results).toHaveLength(2);
      expect(results[0].exitCode).toBe(0);
      expect(results[1].exitCode).toBe(1);
    });

    it('includes command in results', async () => {
      const commands = ['Write-Output "test"'];

      const results = await runPowerShellSequence(commands);

      expect(results[0].command).toBe('Write-Output "test"');
    });
  });

  describeIfPowerShell('isPowerShellAvailable', () => {
    it('returns true when PowerShell is available', async () => {
      const result = await isPowerShellAvailable();
      expect(result).toBe(true);
    });
  });

  // Test that functions handle errors gracefully
  describe('error handling', () => {
    it('handles non-existent command gracefully', async () => {
      // runPowerShell should not throw on bad commands, but return exit code
      const result = await runPowerShell('NonExistentCommand12345');
      expect(result.exitCode).not.toBe(0);
    });
  });
});
