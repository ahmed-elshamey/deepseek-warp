#!/usr/bin/env node
/**
 * DeepSeek API Manager - Create New API Instance
 * Interactive CLI for creating and configuring API keys
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import crypto from 'crypto';

const MANAGER_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEEPSEEK_BASE = '/root/deepseek';
const TEMPLATE_SERVER = path.join(MANAGER_DIR, 'server.mjs');
// DeepSeek model lineup (current as of 2026-07)
// Both V4-Flash and V4-Pro support thinking + search.
// Legacy `deepseek-chat` / `deepseek-reasoner` aliases map to V4-Flash
// (non-thinking / thinking) and will be deprecated on 2026/07/24.
const ALL_MODELS = [
  // DeepSeek V4-Flash (fast, cost-efficient)
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4-Flash' },
  { id: 'deepseek-v4-flash-thinking', name: 'DeepSeek V4-Flash (Thinking)' },
  { id: 'deepseek-v4-flash-search', name: 'DeepSeek V4-Flash (Search)' },
  { id: 'deepseek-v4-flash-thinking-search', name: 'DeepSeek V4-Flash (Thinking + Search)' },
  // DeepSeek V4-Pro (most capable)
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro' },
  { id: 'deepseek-v4-pro-thinking', name: 'DeepSeek V4-Pro (Thinking)' },
  { id: 'deepseek-v4-pro-search', name: 'DeepSeek V4-Pro (Search)' },
  { id: 'deepseek-v4-pro-thinking-search', name: 'DeepSeek V4-Pro (Thinking + Search)' },
];

// ==================== Console UI ====================
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function c(color, text) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function title(text) {
  const line = '═'.repeat(55);
  console.log(c('cyan', `\n╔${line}╗`));
  console.log(c('cyan', `║${text.padEnd(55)}║`));
  console.log(c('cyan', `╚${line}╝\n`));
}

function step(num, text) {
  console.log(c('yellow', `\n── Step ${num}: ${text} ${'─'.repeat(Math.max(0, 40 - text.length))}`));
}

function success(text) {
  console.log(c('green', `  ✅ ${text}`));
}

function error(text) {
  console.log(c('red', `  ❌ ${text}`));
}

function info(text) {
  console.log(c('blue', `  ℹ️  ${text}`));
}

// ==================== Input Helpers ====================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt, defaultValue = null) {
  return new Promise((resolve) => {
    const display = defaultValue !== null ? `${prompt} ${c('dim', `[${defaultValue}]`)}: ` : `${prompt}: `;
    rl.question(display, (answer) => {
      resolve(answer.trim() || (defaultValue !== null ? String(defaultValue) : ''));
    });
  });
}

function questionPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(`${prompt}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = '';

    const onData = (char) => {
      const ch = char.toString();
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.stdin.removeListener('data', onData);
          resolve(password);
          break;
        case '\u0003':
          process.stdin.setRawMode(false);
          console.log('\n' + c('red', 'Cancelled.'));
          process.exit(0);
          break;
        case '\u007f':
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
          break;
        default:
          password += ch;
          process.stdout.write('*');
          break;
      }
    };

    process.stdin.on('data', onData);
  });
}

function questionYesNo(prompt, defaultYes = true) {
  return new Promise(async (resolve) => {
    const def = defaultYes ? 'Y/n' : 'y/N';
    const answer = await question(`${prompt} ${c('dim', `(${def})`)}`, '');
    const lower = answer.toLowerCase();
    if (lower === 'y' || lower === 'yes' || (lower === '' && defaultYes)) return resolve(true);
    if (lower === 'n' || lower === 'no' || (lower === '' && !defaultYes)) return resolve(false);
    return resolve(defaultYes);
  });
}

async function questionChoice(prompt, choices, allowMultiple = false) {
  console.log(c('bold', prompt));
  for (const [key, label] of Object.entries(choices)) {
    console.log(c('dim', `  ${key}.`) + ` ${label}`);
  }
  const answer = await question(c('yellow', '  Select'), '');
  return answer;
}

// ==================== Port Finder ====================
function findAvailablePort(startPort = 3102) {
  const usedPorts = new Set();

  // Check existing API directories for used ports
  if (fs.existsSync(DEEPSEEK_BASE)) {
    const dirs = fs.readdirSync(DEEPSEEK_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'manager' && d.name !== 'me-panel');

    for (const dir of dirs) {
      const configFile = path.join(DEEPSEEK_BASE, dir.name, 'config.json');
      if (fs.existsSync(configFile)) {
        try {
          const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
          if (config.port) usedPorts.add(config.port);
        } catch {}
      }
    }
  }

  // Check ports in use via PM2
  try {
    const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const processes = JSON.parse(pm2List);
    for (const proc of processes) {
      if (proc.pm2_env && proc.pm2_env.PORT) {
        usedPorts.add(parseInt(proc.pm2_env.PORT));
      }
    }
  } catch {}

  let port = startPort;
  while (usedPorts.has(port)) port++;
  return port;
}

// ==================== Generate API Key ====================
function generateApiKey(name) {
  const random = crypto.randomBytes(16).toString('hex');
  return `sk-${name}-${random.substring(0, 12)}`;
}

// ==================== Tor Check ====================
function checkTorInstalled() {
  try {
    execSync('which tor', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installTor() {
  try {
    console.log(c('yellow', '  Installing Tor...'));
    execSync('apt-get update -qq && apt-get install -y -qq tor 2>/dev/null', { stdio: 'pipe' });
    execSync('systemctl enable tor 2>/dev/null || systemctl start tor 2>/dev/null', { stdio: 'pipe' });
    // Wait for Tor to start
    execSync('sleep 3');
    return true;
  } catch (e) {
    return false;
  }
}

// ==================== Main ====================
async function main() {
  title('  DeepSeek API Manager - Create New API  ');

  // Check template exists
  if (!fs.existsSync(TEMPLATE_SERVER)) {
    error(`Template server not found at ${TEMPLATE_SERVER}`);
    error('Make sure server.mjs is in the same directory as this script.');
    process.exit(1);
  }

  // Ensure base directory exists
  if (!fs.existsSync(DEEPSEEK_BASE)) {
    fs.mkdirSync(DEEPSEEK_BASE, { recursive: true });
  }

  // ==================== Step 1: Credentials ====================
  step(1, 'DeepSeek Account Credentials');
  info('Each API instance uses separate login credentials for isolation.');
  console.log();

  const email = await question('  Enter DeepSeek email');
  if (!email) {
    error('Email is required.');
    process.exit(1);
  }

  const password = await questionPassword('  Enter DeepSeek password');
  if (!password) {
    error('Password is required.');
    process.exit(1);
  }

  // ==================== Step 2: API Name ====================
  step(2, 'API Instance Name');
  info('This name is used for the directory and PM2 process name.');
  console.log();

  let apiName = await question('  API name (e.g., ahmed, user1, client-x)');
  if (!apiName) {
    error('Name is required.');
    process.exit(1);
  }

  // Sanitize name
  apiName = apiName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const apiDir = path.join(DEEPSEEK_BASE, apiName);
  if (fs.existsSync(apiDir)) {
    error(`Directory "${apiDir}" already exists!`);
    const overwrite = await questionYesNo('  Do you want to overwrite?', false);
    if (!overwrite) process.exit(0);
  }

  // ==================== Step 3: Port ====================
  step(3, 'Network Configuration');
  const availablePort = findAvailablePort(3102);
  console.log();

  const portInput = await question(`  Port number`, String(availablePort));
  const port = parseInt(portInput) || availablePort;

  const host = await question('  Host (0.0.0.0 for public, 127.0.0.1 for local)', '127.0.0.1');

  // ==================== Step 4: Usage Limits ====================
  step(4, 'Usage Limits');
  info('Set rate limits for this API. Press Enter for defaults.');
  console.log();

  const messagesPerMinute = parseInt(await question('  Messages per minute', '10')) || 10;
  const messagesPerHour = parseInt(await question('  Messages per hour', '200')) || 200;
  const messagesPerDay = parseInt(await question('  Messages per day', '1000')) || 1000;
  const messagesPerMonth = parseInt(await question('  Messages per month', '10000')) || 10000;
  const monthlyTokens = parseInt(await question('  Monthly token limit', '2000000')) || 2000000;

  const noLimits = await questionYesNo('  Disable all limits? (unlimited access)', false);

  // ==================== Step 5: Expiration ====================
  step(5, 'API Expiration');
  console.log();

  const expiresInput = await question('  Expiration date (YYYY-MM-DD) or "never"', 'never');
  let expiresAt = 'never';
  if (expiresInput.toLowerCase() !== 'never') {
    // Validate date
    const parsed = new Date(expiresInput);
    if (isNaN(parsed.getTime())) {
      error('Invalid date format. Using "never".');
    } else if (parsed <= new Date()) {
      error('Date is in the past. Using "never".');
    } else {
      expiresAt = expiresInput;
    }
  }

  // ==================== Step 6: Model Selection ====================
  step(6, 'Model Selection');
  info('Choose which models to enable for this API instance.');
  console.log();

  // Display models in columns
  console.log(c('bold', '  Available Models:'));
  console.log();

  // Group models for display
  const displayModels = [];
  for (let i = 0; i < ALL_MODELS.length; i++) {
    displayModels.push({ num: i + 1, ...ALL_MODELS[i] });
  }

  // Print in 2 columns
  const halfLen = Math.ceil(displayModels.length / 2);
  for (let i = 0; i < halfLen; i++) {
    const left = displayModels[i];
    const right = displayModels[halfLen + i];
    let line = `  ${c('yellow', String(left.num).padStart(2))}. ${left.name.padEnd(35)}`;
    if (right) {
      line += `${c('yellow', String(right.num).padStart(2))}. ${right.name}`;
    }
    console.log(line);
  }
  console.log();

  const modelSelection = await question(
    `${c('bold', '  Enter model numbers')}\n` +
    `  (comma-separated e.g. "1,2" or "all" or "base" for non-thinking only)`
  );

  let selectedModels = {};

  if (modelSelection.toLowerCase() === 'all') {
    // Enable all models
    for (const m of ALL_MODELS) {
      selectedModels[m.id] = { enabled: true, customName: null };
    }
    success(`Selected all ${ALL_MODELS.length} models`);
  } else if (modelSelection.toLowerCase() === 'base') {
    // Enable only non-thinking variants
    for (const m of ALL_MODELS) {
      if (!m.id.includes('thinking')) {
        selectedModels[m.id] = { enabled: true, customName: null };
      }
    }
    success(`Selected ${Object.keys(selectedModels).length} base models (no thinking variants)`);
  } else {
    // Parse comma-separated numbers
    const nums = modelSelection.split(/[,،\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    for (const num of nums) {
      if (num >= 1 && num <= ALL_MODELS.length) {
        const m = ALL_MODELS[num - 1];
        selectedModels[m.id] = { enabled: true, customName: null };
      }
    }
    if (Object.keys(selectedModels).length === 0) {
      error('No valid model numbers selected. Using all models.');
      for (const m of ALL_MODELS) {
        selectedModels[m.id] = { enabled: true, customName: null };
      }
    } else {
      success(`Selected ${Object.keys(selectedModels).length} models`);
    }
  }

  // ==================== Step 7: Custom Model Names ====================
  step(7, 'Custom Model Names (Optional)');
  console.log();

  const renameModels = await questionYesNo('  Do you want to rename any models?', false);

  if (renameModels) {
    console.log();
    info('Press Enter to keep the original name.');
    console.log();

    for (const [modelId, cfg] of Object.entries(selectedModels)) {
      const originalName = ALL_MODELS.find(m => m.id === modelId)?.name || modelId;
      const customName = await question(`  "${originalName}" → new name`);
      if (customName.trim()) {
        cfg.customName = customName.trim();
        info(`  "${originalName}" → "${customName.trim()}"`);
      }
    }
  }

  // ==================== Step 8: Thinking Visibility ====================
  step(8, 'Thinking/Thought Display');
  info('Control whether users see the model\'s thinking process (DeepThink).');
  console.log();

  console.log(c('dim', '  ON:  Users see thinking/reasoning (e.g., in Open WebUI the Thought section appears)'));
  console.log(c('dim', '  OFF: Thinking is hidden - users only see the final answer'));
  console.log();

  const showThinking = await questionYesNo('  Show thinking to users?', true);
  success(`Thinking display: ${showThinking ? 'ON' : 'OFF'}`);

  // ==================== Step 9: Tor Mode ====================
  step(9, 'Tor Mode (IP Isolation)');
  info('Each API instance can use a different IP via Tor to avoid rate limiting/blocking.');
  console.log();

  const enableTor = await questionYesNo('  Enable Tor mode?', false);

  if (enableTor) {
    if (!checkTorInstalled()) {
      const install = await questionYesNo('  Tor is not installed. Install it now?', true);
      if (install) {
        if (installTor()) {
          success('Tor installed and started');
        } else {
          error('Failed to install Tor. Disabling Tor mode.');
          enableTor = false;
        }
      } else {
        enableTor = false;
      }
    } else {
      success('Tor is already installed');
    }

    if (enableTor) {
      // Check Tor is running and verify IP
      try {
        const torCheck = execSync('curl -s --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip 2>/dev/null', { encoding: 'utf-8', timeout: 15000 });
        try {
          const torInfo = JSON.parse(torCheck);
          if (torInfo.IsTor) {
            console.log();
            console.log(c('green', '  ┌─────────────────────────────────────────┐'));
            console.log(c('green', '  │') + c('bold', '  🔗 Tor Connection Verified!') + c('green', '             │'));
            console.log(c('green', '  │') + `  Tor Exit IP: ${c('cyan', c('bold', torInfo.IP))}` + c('green', '           │'));
            console.log(c('green', '  └─────────────────────────────────────────┘'));
            console.log();
          } else {
            error(`Tor NOT working! IP: ${torInfo.IP} - traffic is not going through Tor`);
            const continueAnyway = await questionYesNo('  Continue anyway?', false);
            if (!continueAnyway) enableTor = false;
          }
        } catch {
          success('Tor connection seems active (could not verify IP)');
        }
      } catch {
        const startTor = await questionYesNo('  Tor may not be running. Try to start?', true);
        if (startTor) {
          try {
            execSync('systemctl start tor 2>/dev/null || service tor start 2>/dev/null', { stdio: 'pipe' });
            execSync('sleep 3');
            // Verify after starting
            const recheck = execSync('curl -s --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip 2>/dev/null', { encoding: 'utf-8', timeout: 15000 });
            try {
              const info = JSON.parse(recheck);
              if (info.IsTor) success(`Tor started and verified! IP: ${info.IP}`);
              else success('Tor started but could not verify IP');
            } catch { success('Tor started'); }
          } catch {
            error('Could not start Tor. Run: systemctl start tor');
            const continueAnyway = await questionYesNo('  Continue anyway?', false);
            if (!continueAnyway) enableTor = false;
          }
        } else {
          enableTor = false;
        }
      }
    }
  }

  // ==================== Step 10: Thinking Timeout ====================
  step(10, 'Thinking Timeout');
  info('How long to wait for the model to finish thinking before timing out.');
  console.log();

  const thinkingTimeout = parseInt(await question('  Thinking timeout in seconds', '120')) || 120;
  const answerTimeout = parseInt(await question('  Answer timeout in seconds', '30')) || 30;

  // ==================== Confirmation ====================
  step('✓', 'Confirmation');
  console.log();

  console.log(c('bold', '  API Configuration Summary:'));
  console.log(c('dim', '  ' + '─'.repeat(45)));
  console.log(`  Name:           ${c('green', apiName)}`);
  console.log(`  Directory:      ${c('dim', apiDir)}`);
  console.log(`  Port:           ${c('yellow', port)}`);
  console.log(`  Host:           ${c('yellow', host)}`);
  console.log(`  API Key:        ${c('cyan', 'sk-****')}${c('dim', ' (generated, shown after creation)')}`);
  console.log(`  Credentials:    ${c('dim', email)}`);
  console.log(`  Expires:        ${expiresAt === 'never' ? c('green', 'Never') : c('yellow', expiresAt)}`);
  console.log(`  Models:         ${c('yellow', String(Object.keys(selectedModels).length))} enabled`);

  const renamedCount = Object.values(selectedModels).filter(m => m.customName).length;
  if (renamedCount > 0) {
    console.log(`  Renamed:        ${c('yellow', String(renamedCount))} models`);
  }

  console.log(`  Thinking:       ${showThinking ? c('green', 'Visible') : c('red', 'Hidden')}`);
  console.log(`  Tor Mode:       ${enableTor ? c('green', 'Enabled') : c('red', 'Disabled')}`);
  console.log(`  Think Timeout:  ${c('yellow', thinkingTimeout + 's')}`);
  console.log(`  Answer Timeout: ${c('yellow', answerTimeout + 's')}`);

  if (!noLimits) {
    console.log();
    console.log(c('bold', '  Rate Limits:'));
    console.log(`  Per minute:     ${c('yellow', String(messagesPerMinute))}`);
    console.log(`  Per hour:       ${c('yellow', String(messagesPerHour))}`);
    console.log(`  Per day:        ${c('yellow', String(messagesPerDay))}`);
    console.log(`  Per month:      ${c('yellow', String(messagesPerMonth))}`);
    console.log(`  Tokens/month:   ${c('yellow', monthlyTokens.toLocaleString())}`);
  } else {
    console.log(`  Rate Limits:    ${c('green', 'UNLIMITED')}`);
  }

  console.log();

  const confirm = await questionYesNo('  Create this API instance?', true);
  if (!confirm) {
    console.log(c('yellow', '\n  Cancelled.'));
    process.exit(0);
  }

  // ==================== Create Instance ====================
  step('⚙', 'Creating API Instance');
  console.log();

  // Create directory
  try {
    fs.mkdirSync(apiDir, { recursive: true });
    success(`Created directory: ${apiDir}`);
  } catch (e) {
    error(`Failed to create directory: ${e.message}`);
    process.exit(1);
  }

  // Copy template server
  try {
    fs.copyFileSync(TEMPLATE_SERVER, path.join(apiDir, 'server.mjs'));
    success('Copied server.mjs');
  } catch (e) {
    error(`Failed to copy server: ${e.message}`);
    process.exit(1);
  }

  // ✨ Auto install playwright in API directory
  info('Setting up dependencies...');
  try {
    // Create package.json if not exists
    const pkgPath = path.join(apiDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2));
    }

    // Try to check if playwright is accessible
    let playwrightOk = false;
    try {
      // Try global playwright
      const globalModules = execSync('npm root -g 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (fs.existsSync(path.join(globalModules, 'playwright'))) {
        // Check if we can require it from the API directory
        execSync(`node -e "require('playwright')" 2>/dev/null`, { cwd: apiDir, stdio: 'pipe' });
        playwrightOk = true;
        success('Playwright available (global)');
      }
    } catch {}

    if (!playwrightOk) {
      // Try symlink to global node_modules first
      try {
        const globalModules = execSync('npm root -g 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (fs.existsSync(path.join(globalModules, 'playwright')) && !fs.existsSync(path.join(apiDir, 'node_modules'))) {
          fs.symlinkSync(globalModules, path.join(apiDir, 'node_modules'), 'junction');
          execSync(`node -e "require('playwright')" 2>/dev/null`, { cwd: apiDir, stdio: 'pipe' });
          playwrightOk = true;
          success('Linked to global Playwright');
        }
      } catch {}
    }

    if (!playwrightOk) {
      // Install playwright locally as fallback
      console.log(c('dim', '  Installing Playwright locally... (this may take a minute)'));
      execSync(`cd "${apiDir}" && npm install playwright 2>&1 | tail -3`, {
        stdio: 'pipe',
        timeout: 180000
      });
      // Verify installation
      execSync(`node -e "require('playwright')" 2>/dev/null`, { cwd: apiDir, stdio: 'pipe' });
      success('Playwright installed locally');
    }
  } catch (e) {
    error(`Playwright setup issue: ${e.message}`);
    info('The API may still work if playwright is installed globally');
    info('Manual fix: cd ' + apiDir + ' && npm install playwright');
  }

  // Generate API key
  const apiKey = generateApiKey(apiName);

  // Create config.json
  const config = {
    name: apiName,
    apiKey: apiKey,
    port: port,
    host: host,
    headless: true,
    maxPages: 5,
    thinkingTimeout: thinkingTimeout * 10, // Convert to polling ticks (100ms each)
    answerTimeout: answerTimeout * 10,
    expiresAt: expiresAt,
    showThinking: showThinking,
    torMode: enableTor,
    limits: noLimits ? {} : {
      messagesPerMinute,
      messagesPerHour,
      messagesPerDay,
      messagesPerMonth,
      monthlyTokens,
    },
    models: selectedModels,
    createdAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(path.join(apiDir, 'config.json'), JSON.stringify(config, null, 2));
    success('Created config.json');
  } catch (e) {
    error(`Failed to create config: ${e.message}`);
    process.exit(1);
  }

  // Create credentials file
  const credentials = { email, password };
  try {
    fs.writeFileSync(path.join(apiDir, 'deepseek_credentials.json'), JSON.stringify(credentials, null, 2));
    success('Created deepseek_credentials.json');
  } catch (e) {
    error(`Failed to create credentials: ${e.message}`);
    process.exit(1);
  }

  // Update registry
  const registryFile = path.join(MANAGER_DIR, 'apis-registry.json');
  let registry = {};
  if (fs.existsSync(registryFile)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
    } catch {}
  }
  registry[apiName] = {
    port,
    apiKey,
    host,
    createdAt: config.createdAt,
    expiresAt,
    dir: apiDir,
  };
  try {
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
    success('Updated API registry');
  } catch {}

  // Start with PM2
  console.log();
  step('🚀', 'Starting API Instance');
  console.log();

  try {
    // Kill existing process with same name if any
    execSync(`pm2 delete ${apiName} 2>/dev/null || true`, { stdio: 'pipe' });

    execSync(
      `PORT=${port} pm2 start ${path.join(apiDir, 'server.mjs')} --name ${apiName} --cwd ${apiDir}`,
      { stdio: 'pipe' }
    );
    success(`Started PM2 process: ${apiName}`);
  } catch (e) {
    error(`Failed to start with PM2: ${e.message}`);
    info('You can start manually: cd ' + apiDir + ' && node server.mjs');
  }

  // Save PM2 config
  try {
    execSync('pm2 save', { stdio: 'pipe' });
  } catch {}

  // ==================== Done ====================
  console.log();
  title('  API Instance Created Successfully!  ');
  console.log();
  console.log(c('bold', '  Connection Details:'));
  console.log(c('dim', '  ' + '─'.repeat(45)));
  console.log(`  API Name:    ${c('green', apiName)}`);
  console.log(`  API Key:     ${c('cyan', apiKey)}`);
  console.log(`  Base URL:    ${c('yellow', `http://${host}:${port}`)}`);
  console.log(`  Endpoint:    ${c('yellow', `http://${host}:${port}/v1/chat/completions`)}`);
  console.log(`  Models:      ${c('yellow', `http://${host}:${port}/v1/models`)}`);
  console.log(`  Health:      ${c('yellow', `http://${host}:${port}/health`)}`);
  console.log(`  API Info:    ${c('yellow', `http://${host}:${port}/v1/api-info`)}`);
  console.log();

  console.log(c('bold', '  Open WebUI Configuration:'));
  console.log(c('dim', '  ' + '─'.repeat(45)));
  console.log(`  Base URL:  ${c('yellow', `http://${host}:${port}/v1`)}`);
  console.log(`  API Key:   ${c('cyan', apiKey)}`);
  console.log();

  console.log(c('bold', '  curl Test:'));
  console.log(c('dim', '  ' + '─'.repeat(45)));
  console.log(c('dim', `  curl http://${host}:${port}/v1/chat/completions \\`));
  console.log(c('dim', `    -H "Authorization: Bearer ${apiKey}" \\`));
  console.log(c('dim', `    -H "Content-Type: application/json" \\`));
  console.log(c('dim', `    -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"Hello"}]}'`));
  console.log();

  info('To manage APIs: node ' + path.join(MANAGER_DIR, 'manage-api.mjs'));
  info('To edit limits: node ' + path.join(MANAGER_DIR, 'edit-api.mjs'));
  console.log();

  rl.close();
}

main().catch(e => {
  error(`Error: ${e.message}`);
  console.error(e);
  rl.close();
  process.exit(1);
});
