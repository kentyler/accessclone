/**
 * AccessClone - Electron Main Process
 *
 * LLM-first approach: Chat interface guides user through installation
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// Import lib modules
const { loadConfig, saveConfig, updateConfig } = require('./lib/config');
const { loadSkill, listSkills } = require('./lib/skills');
const { runPowerShell, isPowerShellAvailable } = require('./lib/powershell');
const { loadLog, saveLog, addStep, setCurrentDirectory, generateSummary, createLog } = require('./lib/install-log');

// Paths
const isDev = !app.isPackaged;
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const skillsPath = isDev
  ? path.join(__dirname, '..', 'skills')
  : path.join(process.resourcesPath, 'skills');
const formsPath = isDev
  ? path.join(__dirname, '..', 'forms')
  : path.join(process.resourcesPath, 'forms');
const serverPath = isDev
  ? path.join(__dirname, '..', 'server')
  : path.join(process.resourcesPath, 'server');
const uiPublicPath = isDev
  ? path.join(__dirname, '..', 'ui', 'resources', 'public')
  : path.join(process.resourcesPath, 'ui', 'public');
const projectRoot = isDev
  ? path.join(__dirname, '..')
  : process.resourcesPath;

// State
let mainWindow = null;
let anthropic = null;
let conversationHistory = [];
let installLog = null;
const installLogPath = path.join(userDataPath, 'install-log.json');

/**
 * Create main window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'AccessClone Setup'
  });

  mainWindow.loadFile(path.join(__dirname, 'chat.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * IPC Handlers
 */

// Get stored config
ipcMain.handle('get-config', () => {
  return loadConfig(configPath);
});

// Open file dialog for Access databases
ipcMain.handle('select-access-database', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Access Database',
    filters: [
      { name: 'Access Databases', extensions: ['accdb', 'mdb'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  return { success: true, path: result.filePaths[0] };
});

// Open folder dialog for destination
ipcMain.handle('select-destination-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Destination Folder',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  return { success: true, path: result.filePaths[0] };
});

// Save project settings
ipcMain.handle('save-project-settings', async (event, settings) => {
  try {
    updateConfig(configPath, { project: settings });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save API key and initialize Anthropic client
ipcMain.handle('save-api-key', async (event, apiKey) => {
  try {
    // Detect provider from API key format
    let llmProvider = 'Assistant';
    if (apiKey.startsWith('sk-ant-')) {
      llmProvider = 'Claude';
    } else if (apiKey.startsWith('sk-')) {
      llmProvider = 'GPT';
    }

    anthropic = new Anthropic({ apiKey });

    // Test the key with a simple request
    await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    });

    updateConfig(configPath, { apiKey, llmProvider });

    // Reset conversation for fresh start with install skill
    conversationHistory = [];

    return { success: true, llmProvider };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Send message to Claude
ipcMain.handle('send-message', async (event, userMessage) => {
  if (!anthropic) {
    const config = loadConfig(configPath);
    if (config.apiKey) {
      anthropic = new Anthropic({ apiKey: config.apiKey });
    } else {
      return { success: false, error: 'API key not configured' };
    }
  }

  try {
    // Add user message to history
    conversationHistory.push({ role: 'user', content: userMessage });

    // Load config for project context
    const config = loadConfig(configPath);

    // Load or create install log
    if (!installLog) {
      installLog = loadLog(installLogPath);
    }

    // Load install skill for system prompt
    const installSkill = loadSkill(skillsPath, 'install');

    // Build project context
    let projectContext = '';
    if (config.project && config.project.name) {
      projectContext = `
## Current Project Configuration

- **Project name:** ${config.project.name}
- **Source databases:** ${config.project.sourceDatabases.join(', ')}
- **Destination folder:** ${config.project.destinationPath}
- **Full project path:** ${config.project.destinationPath}\\${config.project.name}

The database name in PostgreSQL should be: ${config.project.name}
`;
    }

    // Build install log context
    const logSummary = generateSummary(installLog);

    const systemPrompt = `You are an assistant for AccessClone, helping users set up and develop their application on Windows.
${projectContext}
${logSummary}

${installSkill || 'Help the user install AccessClone.'}

## Available Actions

**Run PowerShell commands:** Use a code block with \`\`\`powershell
The user will click "Run" to execute the command.

**Create or edit files:** Use a code block with \`\`\`file:path/to/file.ext
The user will click "Save" to write the file. Example:
\`\`\`file:server/config.js
module.exports = { port: 3001 };
\`\`\`

IMPORTANT: Always be aware of the current directory shown in the Installation Progress above. If you need to run commands in a different directory, either use absolute paths or change directory first.

Keep responses concise and friendly. Guide them step by step.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: conversationHistory
    });

    const assistantMessage = response.content[0].text;
    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    return { success: true, message: assistantMessage };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Run PowerShell command (with user approval via UI)
ipcMain.handle('run-command', async (event, command) => {
  try {
    // Load or create install log
    if (!installLog) {
      installLog = loadLog(installLogPath);
    }

    // Determine working directory
    const cwd = installLog.currentDirectory || projectRoot;

    const result = await runPowerShell(command, { cwd });

    // Log the command
    installLog = addStep(installLog, {
      command,
      cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    });
    saveLog(installLogPath, installLog);

    return { success: true, ...result };
  } catch (err) {
    // Log the error
    if (installLog) {
      installLog = addStep(installLog, {
        command,
        cwd: installLog.currentDirectory || projectRoot,
        exitCode: -1,
        stderr: err.message
      });
      saveLog(installLogPath, installLog);
    }
    return { success: false, error: err.message };
  }
});

// Read a file
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const fs = require('fs');
    const fullPath = path.resolve(projectRoot, filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    return { success: true, content, path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Write a file
ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    const fs = require('fs');
    // Resolve relative to project root, or use absolute path
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    // Log the file write
    if (!installLog) {
      installLog = loadLog(installLogPath);
    }
    installLog = addStep(installLog, {
      command: `[Write file] ${fullPath}`,
      cwd: projectRoot,
      exitCode: 0,
      stdout: `Wrote ${content.length} bytes`
    });
    saveLog(installLogPath, installLog);

    return { success: true, path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List files in a directory
ipcMain.handle('list-files', async (event, dirPath) => {
  try {
    const fs = require('fs');
    const fullPath = path.isAbsolute(dirPath)
      ? dirPath
      : path.resolve(projectRoot, dirPath);

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const files = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(fullPath, entry.name)
    }));

    return { success: true, files, path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List available skills
ipcMain.handle('list-skills', () => {
  return listSkills(skillsPath);
});

// Load a specific skill
ipcMain.handle('load-skill', (event, skillName) => {
  const content = loadSkill(skillsPath, skillName);
  return content ? { success: true, content } : { success: false, error: 'Skill not found' };
});

// Check if setup is complete (main app can run)
ipcMain.handle('check-setup', async () => {
  const checks = {
    nodeInstalled: false,
    postgresRunning: false,
    databaseExists: false,
    serverDepsInstalled: false,
    powerShellAvailable: false
  };

  try {
    // Check PowerShell
    checks.powerShellAvailable = await isPowerShellAvailable();

    if (checks.powerShellAvailable) {
      // Check Node
      const nodeResult = await runPowerShell('node --version', { timeout: 5000 });
      checks.nodeInstalled = nodeResult.exitCode === 0;

      // Check PostgreSQL service
      const pgResult = await runPowerShell(
        'Get-Service postgresql* | Select-Object -ExpandProperty Status',
        { timeout: 5000 }
      );
      checks.postgresRunning = pgResult.stdout.includes('Running');
    }

    // Check if server node_modules exists
    const fs = require('fs');
    const serverNodeModules = path.join(serverPath, 'node_modules');
    checks.serverDepsInstalled = fs.existsSync(serverNodeModules);

  } catch (err) {
    console.error('Setup check error:', err);
  }

  return checks;
});

// Launch main application
ipcMain.handle('launch-app', async () => {
  shell.openExternal('http://localhost:3001');
  return { success: true };
});

// Get app paths (for debugging)
ipcMain.handle('get-paths', () => {
  return {
    isDev,
    userDataPath,
    configPath,
    skillsPath,
    formsPath,
    serverPath,
    uiPublicPath,
    projectRoot
  };
});

// Get install log
ipcMain.handle('get-install-log', () => {
  if (!installLog) {
    installLog = loadLog(installLogPath);
  }
  return installLog;
});

// Clear install log (start fresh)
ipcMain.handle('clear-install-log', () => {
  installLog = createLog();
  saveLog(installLogPath, installLog);
  return { success: true };
});

// Set current directory in log
ipcMain.handle('set-current-directory', (event, directory) => {
  if (!installLog) {
    installLog = loadLog(installLogPath);
  }
  installLog = setCurrentDirectory(installLog, directory);
  saveLog(installLogPath, installLog);
  return { success: true };
});

/**
 * App lifecycle
 */
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
