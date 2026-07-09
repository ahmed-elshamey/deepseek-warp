#!/usr/bin/env node
/**
 * DeepSeek API Manager - Edit API Limits (Live without restart)
 * Modify rate limits, expiration, thinking, and other settings
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';

const DEEPSEEK_BASE = '/root/deepseek';
const REGISTRY_FILE = path.join('/root/deepseek/manager', 'apis-registry.json');

// ==================== Console UI ====================
const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};
function c(color, text) { return `${colors[color] || ''}${text}${colors.reset}`; }
function title(text) {
  const line = '═'.repeat(55);
  console.log(c('cyan', `\n╔${line}╗`));
  console.log(c('cyan', `║${text.padEnd(55)}║`));
  console.log(c('cyan', `╚${line}╝\n`));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt, defaultValue = null) {
  return new Promise((resolve) => {
    const display = defaultValue !== null ? `${prompt} ${c('dim', `[${defaultValue}]`)}: ` : `${prompt}: `;
    rl.question(display, (answer) => {
      resolve(answer.trim() || (defaultValue !== null ? String(defaultValue) : ''));
    });
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

// ==================== Helpers ====================
function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); } catch {}
  }
  return {};
}

function getApiDirs() {
  if (!fs.existsSync(DEEPSEEK_BASE)) return [];
  return fs.readdirSync(DEEPSEEK_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'manager' && d.name !== 'me-panel')
    .map(d => d.name);
}

function reloadApi(name, apiKey, port, host) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({});
    const req = http.request({
      hostname: host || '127.0.0.1',
      port: port,
      path: '/admin/reload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ success: false, error: 'Invalid response' }); }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    req.write(postData);
    req.end();
  });
}

// ==================== Main ====================
async function main() {
  title('  DeepSeek API - Edit Limits (Live)  ');

  const dirs = getApiDirs();
  if (dirs.length === 0) {
    console.log(c('yellow', '  No API instances found.'));
    rl.close();
    return;
  }

  // Show available APIs
  console.log(c('bold', '  Available APIs:'));
  console.log();
  for (let i = 0; i < dirs.length; i++) {
    const configFile = path.join(DEEPSEEK_BASE, dirs[i], 'config.json');
    let port = '?', modelCount = '?';
    if (fs.existsSync(configFile)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        port = cfg.port || '?';
        modelCount = cfg.models ? Object.values(cfg.models).filter(m => m.enabled).length : '?';
      } catch {}
    }
    console.log(`  ${c('yellow', String(i + 1).padStart(2))}. ${c('bold', dirs[i])} ${c('dim', `| port: ${port} | models: ${modelCount}`)}`);
  }
  console.log();

  const selection = await question(c('yellow', '  Select API number'));
  const num = parseInt(selection) - 1;
  if (isNaN(num) || num < 0 || num >= dirs.length) {
    console.log(c('red', '  Invalid selection.'));
    rl.close();
    return;
  }

  const apiName = dirs[num];
  const apiDir = path.join(DEEPSEEK_BASE, apiName);
  const configFile = path.join(apiDir, 'config.json');

  if (!fs.existsSync(configFile)) {
    console.log(c('red', `  No config.json found for "${apiName}"`));
    rl.close();
    return;
  }

  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (e) {
    console.log(c('red', `  Error reading config: ${e.message}`));
    rl.close();
    return;
  }

  console.log();
  console.log(c('bold', `  Editing: ${apiName}`));
  console.log(c('dim', '  ' + '─'.repeat(45)));

  // Show current limits
  const limits = config.limits || {};
  console.log();
  console.log(c('bold', '  Current Settings:'));
  console.log(`  Messages/min:   ${c('yellow', String(limits.messagesPerMinute || 'unlimited'))}`);
  console.log(`  Messages/hour:  ${c('yellow', String(limits.messagesPerHour || 'unlimited'))}`);
  console.log(`  Messages/day:   ${c('yellow', String(limits.messagesPerDay || 'unlimited'))}`);
  console.log(`  Messages/month: ${c('yellow', String(limits.messagesPerMonth || 'unlimited'))}`);
  console.log(`  Tokens/month:   ${c('yellow', limits.monthlyTokens ? limits.monthlyTokens.toLocaleString() : 'unlimited')}`);
  console.log(`  Expires:        ${c('yellow', config.expiresAt || 'never')}`);
  console.log(`  Show Thinking:  ${c('yellow', config.showThinking !== false ? 'Yes' : 'No')}`);
  console.log(`  Think Timeout:  ${c('yellow', config.thinkingTimeout ? Math.round(config.thinkingTimeout / 10) + 's' : '120s')}`);
  console.log();

  const editLimits = await questionYesNo('  Edit rate limits?', true);
  if (editLimits) {
    console.log(c('dim', '  (Press Enter to keep current value)\n'));
    const mpm = await question('  Messages per minute', limits.messagesPerMinute || 'unlimited');
    const mph = await question('  Messages per hour', limits.messagesPerHour || 'unlimited');
    const mpd = await question('  Messages per day', limits.messagesPerDay || 'unlimited');
    const mpmo = await question('  Messages per month', limits.messagesPerMonth || 'unlimited');
    const mtk = await question('  Monthly token limit', limits.monthlyTokens || 'unlimited');

    config.limits = {};
    if (mpm !== 'unlimited') config.limits.messagesPerMinute = parseInt(mpm) || 0;
    if (mph !== 'unlimited') config.limits.messagesPerHour = parseInt(mph) || 0;
    if (mpd !== 'unlimited') config.limits.messagesPerDay = parseInt(mpd) || 0;
    if (mpmo !== 'unlimited') config.limits.messagesPerMonth = parseInt(mpmo) || 0;
    if (mtk !== 'unlimited') config.limits.monthlyTokens = parseInt(mtk) || 0;
  }

  const editExpire = await questionYesNo('  Change expiration date?', false);
  if (editExpire) {
    const newExpire = await question('  Expiration date (YYYY-MM-DD) or "never"', config.expiresAt || 'never');
    config.expiresAt = newExpire.toLowerCase() === 'never' ? 'never' : newExpire;
  }

  const editThinking = await questionYesNo('  Change thinking visibility?', false);
  if (editThinking) {
    const show = await questionYesNo('  Show thinking to users?', config.showThinking !== false);
    config.showThinking = show;
  }

  const editTimeout = await questionYesNo('  Change thinking timeout?', false);
  if (editTimeout) {
    const timeoutSec = await question('  Thinking timeout in seconds', String(Math.round((config.thinkingTimeout || 1200) / 10)));
    const timeoutTicks = (parseInt(timeoutSec) || 120) * 10;
    config.thinkingTimeout = timeoutTicks;
  }

  const resetUsage = await questionYesNo('  Reset usage statistics?', false);
  if (resetUsage) {
    const usageFile = path.join(apiDir, 'usage.json');
    if (fs.existsSync(usageFile)) {
      fs.unlinkSync(usageFile);
      console.log(c('green', '  Usage statistics reset.'));
    }
  }

  // Save config
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(c('green', `\n  Config saved to ${configFile}`));
  } catch (e) {
    console.log(c('red', `  Error saving config: ${e.message}`));
    rl.close();
    return;
  }

  // Reload API without restart
  console.log(c('yellow', '  Reloading API configuration...'));
  const reloadResult = await reloadApi(apiName, config.apiKey, config.port, config.host);
  if (reloadResult.success) {
    console.log(c('green', '  API reloaded successfully! Changes are now active.'));
  } else {
    console.log(c('yellow', `  Live reload failed (${reloadResult.error}). Restart the API manually:`));
    console.log(c('dim', `  pm2 restart ${apiName}`));
  }

  // Show updated settings
  console.log();
  console.log(c('bold', '  Updated Settings:'));
  console.log(c('dim', '  ' + '─'.repeat(45)));
  const newLimits = config.limits || {};
  console.log(`  Messages/min:   ${c('yellow', String(newLimits.messagesPerMinute || 'unlimited'))}`);
  console.log(`  Messages/hour:  ${c('yellow', String(newLimits.messagesPerHour || 'unlimited'))}`);
  console.log(`  Messages/day:   ${c('yellow', String(newLimits.messagesPerDay || 'unlimited'))}`);
  console.log(`  Messages/month: ${c('yellow', String(newLimits.messagesPerMonth || 'unlimited'))}`);
  console.log(`  Tokens/month:   ${c('yellow', newLimits.monthlyTokens ? newLimits.monthlyTokens.toLocaleString() : 'unlimited')}`);
  console.log(`  Expires:        ${c('yellow', config.expiresAt || 'never')}`);
  console.log(`  Show Thinking:  ${c('yellow', config.showThinking !== false ? 'Yes' : 'No')}`);
  console.log(`  Think Timeout:  ${c('yellow', config.thinkingTimeout ? Math.round(config.thinkingTimeout / 10) + 's' : '120s')}`);

  console.log();
  rl.close();
}

main().catch(e => { console.error(c('red', `Error: ${e.message}`)); rl.close(); });
