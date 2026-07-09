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

const ALL_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4-Flash' },
  { id: 'deepseek-v4-flash-thinking', name: 'DeepSeek V4-Flash (Thinking)' },
  { id: 'deepseek-v4-flash-search', name: 'DeepSeek V4-Flash (Search)' },
  { id: 'deepseek-v4-flash-thinking-search', name: 'DeepSeek V4-Flash (Thinking + Search)' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro' },
  { id: 'deepseek-v4-pro-thinking', name: 'DeepSeek V4-Pro (Thinking)' },
  { id: 'deepseek-v4-pro-search', name: 'DeepSeek V4-Pro (Search)' },
  { id: 'deepseek-v4-pro-thinking-search', name: 'DeepSeek V4-Pro (Thinking + Search)' },
];

const colors = {
  reset: '\\x1b[0m', bold: '\\x1b[1m', dim: '\\x1b[2m',
  red: '\\x1b[31m', green: '\\x1b[32m', yellow: '\\x1b[33m',
  blue: '\\x1b[34m', magenta: '\\x1b[35m', cyan: '\\x1b[36m',
  white: '\\x1b[37m',
};

function c(color, text) { return `${colors[color] || ''}${text}${colors.reset}`; }

function title(text) {
  const line = '═'.repeat(55);
  console.log(c('cyan', `\\n╔${line}╗`));
  console.log(c('cyan', `║${text.padEnd(55)}║`));
  console.log(c('cyan', `╚${line}╝\\n`));
}

function step(num, text) {
  console.log(c('yellow', `\\n── Step ${num}: ${text} ${'─'.repeat(Math.max(0, 40 - text.length))}`));
}

function success(text) { console.log(c('green', `  ✅ ${text}`)); }
function error(text) { console.log(c('red', `  ❌ ${text}`)); }
function info(text) { console.log(c('blue', `  ℹ️  ${text}`)); }

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
        case '\\n':
        case '\\r':
        case '\\u0004':
          process.stdin.setRawMode(false);
          process.stdout.write('\\n');
          process.stdin.removeListener('data', onData);
          resolve(password);
          break;
        case '\\u0003':
          process.stdin.setRawMode(false);
          console.log('\\n' + c('red', 'Cancelled.'));
          process.exit(0);
          break;
        case '\\u007f':
          password = password.slice(0, -1);
          process.stdout.write('\\b \\b');
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

function findAvailablePort(startPort = 3102) {
  const usedPorts = new Set();
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

function generateApiKey(name) {
  const random = crypto.randomBytes(16).toString('hex');
  return `sk-${name}-${random.substring(0, 12)}`;
}

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
    execSync('sleep 3');
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  title('  DeepSeek API Manager - Create New API  ');
  if (!fs.existsSync(TEMPLATE_SERVER)) {
    error(`Template server not found at ${TEMPLATE_SERVER}`);
    error('Make sure server.mjs is in the same directory as this script.');
    process.exit(1);
  }
  if (!fs.existsSync(DEEPSEEK_BASE)) {
    fs.mkdirSync(DEEPSEEK_BASE, { recursive: true });
  }

  step(1, 'DeepSeek Account Credentials');
  const email = await question('  Enter DeepSeek email');
  if (!email) { error('Email is required.'); process.exit(1); }
  const password = await questionPassword('  Enter DeepSeek password');
  if (!password) { error('Password is required.'); process.exit(1); }

  step(2, 'API Instance Name');
  let apiName = await question('  API name (e.g., ahmed, user1, client-x)');
  if (!apiName) { error('Name is required.'); process.exit(1); }
  apiName = apiName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const apiDir = path.join(DEEPSEEK_BASE, apiName);
  if (fs.existsSync(apiDir)) {
    error(`Directory \"${apiDir}\" already exists!`);
    const overwrite = await questionYesNo('  Do you want to overwrite?', false);
    if (!overwrite) process.exit(0);
  }

  step(3, 'Network Configuration');
  const availablePort = findAvailablePort(3102);
  const port = parseInt(await question(`  Port number`, String(availablePort))) || availablePort;
  const host = await question('  Host (0.0.0.0 for public, 127.0.0.1 for local)', '127.0.0.1');

  step(4, 'Usage Limits');
  const messagesPerMinute = parseInt(await question('  Messages per minute', '10')) || 10;
  const messagesPerHour = parseInt(await question('  Messages per hour', '200')) || 200;
  const messagesPerDay = parseInt(await question('  Messages per day', '1000')) || 1000;
  const messagesPerMonth = parseInt(await question('  Messages per month', '10000')) || 10000;
  const monthlyTokens = parseInt(await question('  Monthly token limit', '2000000')) || 2000000;
  const noLimits = await questionYesNo('  Disable all limits? (unlimited access)', false);

  step(5, 'API Expiration');
  const expiresInput = await question('  Expiration date (YYYY-MM-DD) or "never"', 'never');
  let expiresAt = 'never';
  if (expiresInput.toLowerCase() !== 'never') {
    const parsed = new Date(expiresInput);
    if (!isNaN(parsed.getTime())) {
      if (parsed > new Date()) expiresAt = expiresInput;
    }
  }

  step(6, 'Model Selection');
  const modelSelection = await question('  Enter model numbers (comma-separated, "all", or "base")');
  let selectedModels = {};
  if (modelSelection.toLowerCase() === 'all') {
    for (const m of ALL_MODELS) selectedModels[m.id] = { enabled: true, customName: null };
  } else if (modelSelection.toLowerCase() === 'base') {
    for (const m of ALL_MODELS) { if (!m.id.includes('thinking')) selectedModels[m.id] = { enabled: true, customName: null }; }
  } else {
    const nums = modelSelection.split(/[,،\\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    for (const num of nums) { if (num >= 1 && num <= ALL_MODELS.length) { const m = ALL_MODELS[num - 1]; selectedModels[m.id] = { enabled: true, customName: null }; } }
  }

  step(7, 'Custom Model Names (Optional)');
  const renameModels = await questionYesNo('  Do you want to rename any models?', false);
  if (renameModels) {
    for (const [modelId, cfg] of Object.entries(selectedModels)) {
      const originalName = ALL_MODELS.find(m => m.id === modelId)?.name || modelId;
      const customName = await question(`  "${originalName}" -> new name`);
      if (customName.trim()) cfg.customName = customName.trim();
    }
  }

  step(8, 'Thinking Visibility');
  const showThinking = await questionYesNo('  Show thinking to users?', true);

  step(9, 'Tor Mode (IP Isolation)');
  let enableTor = await questionYesNo('  Enable Tor mode?', false);
  if (enableTor && !checkTorInstalled()) {
    if (await questionYesNo('  Tor not installed. Install now?', true)) {
      if (installTor()) success('Tor installed'); else { error('Tor install failed'); enableTor = false; }
    } else { enableTor = false; }
  }

  step(10, 'Thinking Timeout');
  const thinkingTimeout = parseInt(await question('  Thinking timeout in seconds', '120')) || 120;
  const answerTimeout = parseInt(await question('  Answer timeout in seconds', '30')) || 30;

  const apiKey = generateApiKey(apiName);
  const config = {
    name: apiName,
    apiKey,
    port,
    host,
    headless: true,
    maxPages: 10,
    thinkingTimeout: thinkingTimeout * 10,
    answerTimeout: answerTimeout * 10,
    expiresAt,
    showThinking,
    torMode: enableTor,
    limits: noLimits ? {} : { messagesPerMinute, messagesPerHour, messagesPerDay, messagesPerMonth, monthlyTokens },
    models: selectedModels,
    createdAt: new Date().toISOString()
  };

  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(apiDir, 'deepseek_credentials.json'), JSON.stringify({ email, password }, null, 2));
  if (fs.existsSync(TEMPLATE_SERVER)) fs.copyFileSync(TEMPLATE_SERVER, path.join(apiDir, 'server.mjs'));

  try {
    execSync(`pm2 start ${path.join(apiDir, 'server.mjs')} --name ${apiName} --cwd ${apiDir}`, { stdio: 'pipe' });
    execSync('pm2 save', { stdio: 'pipe' });
    success(`API ${apiName} created and started on port ${port}!`);
    console.log(c('cyan', `  API Key: ${apiKey}`));
  } catch (e) {
    error(`Failed to start with PM2: ${e.message}`);
  }
}

main().catch(e => { console.error(c('red', `Error: ${e.message}`)); process.exit(1); });
