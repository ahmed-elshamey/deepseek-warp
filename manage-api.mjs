#!/usr/bin/env node
/**
 * DeepSeek API Manager - Manage API Instances
 * List, delete, start, stop, restart, and monitor APIs
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const MANAGER_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEEPSEEK_BASE = '/root/deepseek';
const REGISTRY_FILE = path.join(MANAGER_DIR, 'apis-registry.json');

// ==================== Console UI ====================
const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
function c(color, text) { return `${colors[color] || ''}${text}${colors.reset}`; }

function title(text) {
  const line = '═'.repeat(55);
  console.log(c('cyan', `\n╔${line}╗`));
  console.log(c('cyan', `║${text.padEnd(55)}║`));
  console.log(c('cyan', `╚${line}╝\n`));
}

// ==================== Registry ====================
function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); } catch {}
  }
  return {};
}

function saveRegistry(registry) {
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2)); } catch {}
}

function getApiDirs() {
  if (!fs.existsSync(DEEPSEEK_BASE)) return [];
  return fs.readdirSync(DEEPSEEK_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'manager' && d.name !== 'me-panel')
    .map(d => d.name);
}

function getPm2Status() {
  try {
    const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const processes = JSON.parse(list);
    const status = {};
    for (const proc of processes) {
      status[proc.name] = {
        status: proc.pm2_env?.status || 'unknown',
        uptime: proc.pm2_env?.pm_uptime || 0,
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        restarts: proc.pm2_env?.restart_time || 0,
        port: proc.pm2_env?.PORT || proc.pm2_env?.env?.PORT || null,
      };
    }
    return status;
  } catch { return {}; }
}

// ==================== Commands ====================

function cmdList() {
  title('  DeepSeek API Instances  ');

  const registry = loadRegistry();
  const dirs = getApiDirs();
  const pm2Status = getPm2Status();

  if (dirs.length === 0) {
    console.log(c('yellow', '  No API instances found.'));
    console.log(c('dim', '  Create one with: node ' + path.join(MANAGER_DIR, 'create-api.mjs')));
    return;
  }

  console.log(`  ${c('bold', 'Total:')} ${dirs.length} instance(s)\n`);

  for (const dirName of dirs) {
    const reg = registry[dirName] || {};
    const status = pm2Status[dirName] || {};
    const configFile = path.join(DEEPSEEK_BASE, dirName, 'config.json');

    let config = {};
    if (fs.existsSync(configFile)) {
      try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}
    }

    // Status indicator
    const isRunning = status.status === 'online';
    const statusIcon = isRunning ? c('green', '● ONLINE') : c('red', '● OFFLINE');
    const statusText = status.status || 'not found';

    // Expiry check
    let expiryStatus = '';
    if (config.expiresAt && config.expiresAt !== 'never') {
      const expires = new Date(config.expiresAt).getTime();
      const now = Date.now();
      const daysLeft = Math.ceil((expires - now) / 86400000);
      if (daysLeft <= 0) {
        expiryStatus = c('red', ` EXPIRED`);
      } else if (daysLeft <= 7) {
        expiryStatus = c('yellow', ` (${daysLeft}d left)`);
      } else {
        expiryStatus = c('dim', ` (${daysLeft}d left)`);
      }
    }

    // Port
    const port = config.port || reg.port || '?';

    // Model count
    const modelCount = config.models ? Object.keys(config.models).filter(k => config.models[k].enabled).length : '?';

    // Memory
    const memMB = status.memory ? Math.round(status.memory / 1024 / 1024) : 0;

    console.log(`  ${statusIcon} ${c('bold', dirName)}${expiryStatus}`);
    console.log(`    Port: ${c('yellow', String(port))} | Models: ${c('yellow', String(modelCount))} | API Key: ${c('cyan', (config.apiKey || reg.apiKey || '?').substring(0, 20) + '...')}`);

    if (isRunning) {
      const uptime = Math.round((Date.now() - status.uptime) / 60000);
      console.log(`    Uptime: ${c('dim', uptime > 60 ? Math.round(uptime / 60) + 'h ' + (uptime % 60) + 'm' : uptime + 'm')} | Memory: ${c('dim', memMB + 'MB')} | Restarts: ${c('dim', String(status.restarts))}`);
    }

    console.log();
  }
}

function cmdInfo(name) {
  const configFile = path.join(DEEPSEEK_BASE, name, 'config.json');
  if (!fs.existsSync(configFile)) {
    console.log(c('red', `  API "${name}" not found.`));
    return;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const pm2Status = getPm2Status()[name] || {};
    const isRunning = pm2Status.status === 'online';

    console.log(c('bold', `\n  API: ${name}`));
    console.log(c('dim', '  ' + '─'.repeat(45)));
    console.log(`  Status:       ${isRunning ? c('green', 'ONLINE') : c('red', 'OFFLINE')}`);
    console.log(`  Port:         ${config.port || '?'}`);
    console.log(`  Host:         ${config.host || '?'}`);
    console.log(`  API Key:      ${c('cyan', config.apiKey || '?')}`);
    console.log(`  Created:      ${config.createdAt || '?'}`);
    console.log(`  Expires:      ${config.expiresAt || 'never'}`);
    console.log(`  Thinking:     ${config.showThinking !== false ? c('green', 'Visible') : c('red', 'Hidden')}`);
    console.log(`  Tor:          ${config.torMode ? c('green', 'ON') : c('red', 'OFF')}`);
    console.log(`  Think Timeout: ${config.thinkingTimeout ? Math.round(config.thinkingTimeout / 10) + 's' : 'default'}`);

    if (config.limits && Object.keys(config.limits).length > 0) {
      console.log(`\n  ${c('bold', 'Rate Limits:')}`);
      if (config.limits.messagesPerMinute) console.log(`  Per minute:   ${config.limits.messagesPerMinute}`);
      if (config.limits.messagesPerHour) console.log(`  Per hour:     ${config.limits.messagesPerHour}`);
      if (config.limits.messagesPerDay) console.log(`  Per day:      ${config.limits.messagesPerDay}`);
      if (config.limits.messagesPerMonth) console.log(`  Per month:    ${config.limits.messagesPerMonth}`);
      if (config.limits.monthlyTokens) console.log(`  Tokens/month: ${config.limits.monthlyTokens.toLocaleString()}`);
    } else {
      console.log(`  Rate Limits:  ${c('green', 'UNLIMITED')}`);
    }

    if (config.models) {
      const enabled = Object.entries(config.models).filter(([, v]) => v.enabled);
      console.log(`\n  ${c('bold', `Models (${enabled.length}):`)}`);
      for (const [id, cfg] of enabled) {
        const displayName = cfg.customName ? ` → ${cfg.customName}` : '';
        console.log(`  - ${id}${displayName}`);
      }
    }

    // Usage stats
    const usageFile = path.join(DEEPSEEK_BASE, name, 'usage.json');
    if (fs.existsSync(usageFile)) {
      try {
        const usage = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
        console.log(`\n  ${c('bold', 'Usage Stats:')}`);
        if (usage.monthlyTokens) {
          const currentMonth = new Date().toISOString().substring(0, 7);
          const tokens = usage.monthlyTokens[currentMonth] || 0;
          console.log(`  Tokens (month): ${tokens.toLocaleString()}${config.limits?.monthlyTokens ? '/' + config.limits.monthlyTokens.toLocaleString() : ''}`);
        }
        if (usage.monthlyCount) console.log(`  Messages (month): ${usage.monthlyCount}`);
        if (usage.dailyCount) console.log(`  Messages (today): ${usage.dailyCount}`);
      } catch {}
    }

  } catch (e) {
    console.log(c('red', `  Error reading config: ${e.message}`));
  }
}

function cmdStart(name) {
  console.log(c('yellow', `  Starting "${name}"...`));
  try {
    execSync(`pm2 start ${path.join(DEEPSEEK_BASE, name, 'server.mjs')} --name ${name} --cwd ${path.join(DEEPSEEK_BASE, name)}`, { stdio: 'pipe' });
    execSync('pm2 save', { stdio: 'pipe' });
    console.log(c('green', `  ✅ "${name}" started successfully.`));
  } catch (e) {
    console.log(c('red', `  ❌ Failed to start: ${e.message}`));
  }
}

function cmdStop(name) {
  console.log(c('yellow', `  Stopping "${name}"...`));
  try {
    execSync(`pm2 stop ${name}`, { stdio: 'pipe' });
    console.log(c('green', `  ✅ "${name}" stopped.`));
  } catch (e) {
    console.log(c('red', `  ❌ Failed to stop: ${e.message}`));
  }
}

function cmdRestart(name) {
  console.log(c('yellow', `  Restarting "${name}"...`));
  try {
    execSync(`pm2 restart ${name}`, { stdio: 'pipe' });
    console.log(c('green', `  ✅ "${name}" restarted.`));
  } catch (e) {
    console.log(c('red', `  ❌ Failed to restart: ${e.message}`));
  }
}

function cmdDelete(name) {
  const dir = path.join(DEEPSEEK_BASE, name);
  if (!fs.existsSync(dir)) {
    console.log(c('red', `  API "${name}" not found.`));
    return;
  }

  // Use readline for confirmation
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(c('red', `  Are you sure you want to DELETE "${name}"? (y/N): `), (answer) => {
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log(c('yellow', '  Cancelled.'));
      return;
    }

    try {
      // Stop PM2 process
      execSync(`pm2 delete ${name} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync('pm2 save', { stdio: 'pipe' });

      // Remove directory
      fs.rmSync(dir, { recursive: true, force: true });

      // Update registry
      const registry = loadRegistry();
      delete registry[name];
      saveRegistry(registry);

      console.log(c('green', `  ✅ "${name}" deleted successfully.`));
    } catch (e) {
      console.log(c('red', `  ❌ Failed to delete: ${e.message}`));
    }
  });
}

function cmdKey(name) {
  const configFile = path.join(DEEPSEEK_BASE, name, 'config.json');
  if (!fs.existsSync(configFile)) {
    console.log(c('red', `  API "${name}" not found.`));
    return;
  }
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    console.log(c('cyan', `  API Key: ${config.apiKey}`));
    console.log(c('dim', `  Name: ${config.name || name}`));
  } catch {
    console.log(c('red', '  Error reading config.'));
  }
}

function cmdLogs(name) {
  try {
    execSync(`pm2 logs ${name} --lines 50 --nostream`, { stdio: 'inherit' });
  } catch {
    console.log(c('red', `  No logs found for "${name}".`));
  }
}

function cmdStartAll() {
  const dirs = getApiDirs();
  if (dirs.length === 0) {
    console.log(c('yellow', '  No API instances found.'));
    return;
  }
  console.log(c('yellow', `  Starting all ${dirs.length} instances...`));
  for (const name of dirs) {
    cmdStart(name);
  }
}

function cmdStopAll() {
  const dirs = getApiDirs();
  if (dirs.length === 0) {
    console.log(c('yellow', '  No API instances found.'));
    return;
  }
  console.log(c('yellow', `  Stopping all ${dirs.length} instances...`));
  for (const name of dirs) {
    cmdStop(name);
  }
}

// ==================== Main ====================
function showHelp() {
  title('  DeepSeek API Manager  ');
  console.log('  Usage: node manage-api.mjs <command> [name]\n');
  console.log('  Commands:\n');
  console.log(`    ${c('bold', 'list')}                  List all API instances`);
  console.log(`    ${c('bold', 'info <name>')}           Show detailed info about an API`);
  console.log(`    ${c('bold', 'key <name>')}            Show API key`);
  console.log(`    ${c('bold', 'start <name>')}          Start an API instance`);
  console.log(`    ${c('bold', 'stop <name>')}           Stop an API instance`);
  console.log(`    ${c('bold', 'restart <name>')}        Restart an API instance`);
  console.log(`    ${c('bold', 'delete <name>')}         Delete an API instance`);
  console.log(`    ${c('bold', 'logs <name>')}           Show recent logs`);
  console.log(`    ${c('bold', 'edit')}                    Edit API limits live (no restart)`);
  console.log(`    ${c('bold', 'start-all')}             Start all instances`);
  console.log(`    ${c('bold', 'stop-all')}              Stop all instances`);
  console.log(`    ${c('bold', 'help')}                  Show this help`);
  console.log();
  console.log(`  Create new API: ${c('cyan', 'node ' + path.join(MANAGER_DIR, 'create-api.mjs'))}`);
  console.log();
}

const command = process.argv[2];
const name = process.argv[3];

switch (command) {
  case 'list': case 'ls': case 'l':
    cmdList(); break;
  case 'info': case 'i': case 'show':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs info <name>')); break; }
    cmdInfo(name); break;
  case 'key': case 'k':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs key <name>')); break; }
    cmdKey(name); break;
  case 'start': case 's':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs start <name>')); break; }
    cmdStart(name); break;
  case 'stop': case 'x':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs stop <name>')); break; }
    cmdStop(name); break;
  case 'restart': case 'r':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs restart <name>')); break; }
    cmdRestart(name); break;
  case 'delete': case 'del': case 'rm':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs delete <name>')); break; }
    cmdDelete(name); break;
  case 'logs': case 'log':
    if (!name) { console.log(c('red', '  Usage: node manage-api.mjs logs <name>')); break; }
    cmdLogs(name); break;
  case 'edit': case 'e':
    console.log(c('cyan', '  Run: node ' + path.join(MANAGER_DIR, 'edit-api.mjs')));
    break;
  case 'start-all':
    cmdStartAll(); break;
  case 'stop-all':
    cmdStopAll(); break;
  case 'help': case '--help': case '-h':
  default:
    showHelp(); break;
}
