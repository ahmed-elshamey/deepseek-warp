/**
 * DeepSeek API Server - Template with Config Support
 * OpenAI-compatible endpoint for DeepSeek chat
 * Each request = new DeepSeek chat (no session/context)
 *
 * ✅ FIXED: SSE interceptor captures all delta formats (fetch + XHR + EventSource)
 * ✅ FIXED: Fragment-based protocol parsing (BATCH / APPEND / path-based)
 * ✅ FIXED: Smart stability (configurable thinking/answer timeouts)
 * ✅ FIXED: DOM fallback if SSE misses content
 * ✅ FIXED: cleanChunk for streaming / cleanResponse for non-streaming
 * ✨ NEW: Config.json support for multi-instance management
 * ✨ NEW: Rate limiting per API key
 * ✨ NEW: API expiration
 * ✨ NEW: Model filtering and renaming
 * ✨ NEW: Thinking visibility control (DeepThink reasoning capture)
 * ✨ NEW: Tor proxy support
 * ✨ NEW: Live reload without restart (/admin/reload)
 * ✨ NEW: API info endpoint (/v1/api-info)
 */

import http from 'http';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ==================== Config Loading ====================
// ✨ NEW: Load API configuration from config.json (created by create-api.mjs)
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
let API_CONFIG = {};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    API_CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    console.error('Failed to load config.json:', e.message);
  }
}

// ==================== Configuration ====================
const PORT = process.env.PORT || API_CONFIG.port || 3001;
const HOST = API_CONFIG.host || '127.0.0.1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || API_CONFIG.apiKey || 'sk-deepseek';
const TARGET_URL = 'https://chat.deepseek.com/';
const LOGIN_URL = 'https://chat.deepseek.com/sign_in';
const HEADLESS = process.env.HEADLESS !== 'false';
const STATE_FILE = path.join(process.cwd(), 'browser-state.json');
const CREDENTIALS_FILE = path.join(process.cwd(), 'deepseek_credentials.json');
const MAX_PAGES = parseInt(process.env.MAX_PAGES) || API_CONFIG.maxPages || 10;
const PAGE_IDLE_TIMEOUT = 60 * 1000;
const SSE_DEBUG = process.env.SSE_DEBUG === 'true';

// ==================== Globals ====================
let browser = null;
let context = null;
let pagePool = [];
let pageIdCounter = 0;
let isInitializing = false;
let TOR_IP = null; // Global to store Tor IP

// ==================== Logger ====================
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

// ==================== Browser Utils ====================
function sleep(min, max = min) {
  const ms = max > min ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(r => setTimeout(r, ms));
}

// ==================== Load Credentials ====================
function loadCredentials() {
  if (process.env.DEEPSEEK_EMAIL && process.env.DEEPSEEK_PASSWORD) {
    return { email: process.env.DEEPSEEK_EMAIL, password: process.env.DEEPSEEK_PASSWORD };
  }
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
      return { email: data.email, password: data.password };
    } catch (e) {
      log('WARN', 'Failed to load credentials file', { error: e.message });
    }
  }
  return null;
}

// ==================== Response Cleaners ====================
// DeepSeek citation markers appear as patterns like "-6-12", "--2", "-2-6" etc.
// These are rendered superscript reference numbers. We strip them from output.
function stripCitations(text) {
  if (!text) return text;
  // Remove patterns like: -6-12, --2, -2-6, -8, --1-20 (citation reference groups)
  // These are digits separated by hyphens, typically after a word/number
  return text
    .replace(/-{1,2}\d+(?:-\d+)*(-\d+)*(?=\s|$|[.,،؛!؟?])/g, '')  // citation groups at word boundary
    .replace(/-{2,}\d+/g, '')                                       // double-hyphen + digits
    .replace(/\s*-\d+-\d+/g, '')                                    // -N-N patterns
    .replace(/\s*--?\d+(?=\s|$|[.,،؛!؟?])/g, '')                   // stray -N at end of word
    .replace(/[ \t]+([.,،؛!؟?])/g, '$1')                           // fix space before punctuation
    .replace(/\n{3,}/g, '\n\n');                                    // collapse multiple newlines
}

function cleanChunk(text) {
  if (!text) return text;
  return stripCitations(text);
}

function cleanResponse(text) {
  if (!text) return text;
  return stripCitations(text).trim();
}

// ==================== DOM → Markdown Converter ====================
// DeepSeek renders responses as HTML (tables, lists, bold, etc.).
// textContent strips all formatting. This function converts the HTML to
// proper markdown so tables, lists, and emphasis are preserved.
function domToMarkdownScript() {
  // This function is serialized and run inside the page via page.evaluate().
  // It reads the .ds-assistant-message-main-content element and returns markdown.
  return () => {
    function escapeMd(text) {
      if (!text) return '';
      return text;
    }

    function processNode(node) {
      if (node.nodeType === 3) return node.textContent; // text node
      if (node.nodeType !== 1) return ''; // not element

      const tag = node.tagName.toLowerCase();
      const children = () => Array.from(node.childNodes).map(processNode).join('');

      switch (tag) {
        case 'h1': return '\n\n# ' + node.textContent.trim() + '\n\n';
        case 'h2': return '\n\n## ' + node.textContent.trim() + '\n\n';
        case 'h3': return '\n\n### ' + node.textContent.trim() + '\n\n';
        case 'h4': return '\n\n#### ' + node.textContent.trim() + '\n\n';
        case 'h5': return '\n\n##### ' + node.textContent.trim() + '\n\n';
        case 'h6': return '\n\n###### ' + node.textContent.trim() + '\n\n';

        case 'strong':
        case 'b':
          return '**' + children() + '**';

        case 'em':
        case 'i':
          return '*' + children() + '*';

        case 'code':
          return '`' + node.textContent + '`';

        case 'pre': {
          const code = node.textContent;
          return '\n```\n' + code + '\n```\n\n';
        }

        case 'a': {
          const href = node.getAttribute('href') || '';
          const text = node.textContent;
          return '[' + text + '](' + href + ')';
        }

        case 'br': return '\n';
        case 'hr': return '\n---\n\n';

        case 'blockquote': {
          const inner = children().trim();
          return '\n' + inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        }

        case 'p': return children() + '\n\n';

        case 'ul': {
          return '\n' + Array.from(node.children).map(li => '- ' + processNode(li).trim()).join('\n') + '\n\n';
        }
        case 'ol': {
          return '\n' + Array.from(node.children).map((li, i) => (i + 1) + '. ' + processNode(li).trim()).join('\n') + '\n\n';
        }
        case 'li': return children();

        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (rows.length === 0) return children();
          const tableData = rows.map(row => {
            return Array.from(row.querySelectorAll('th, td')).map(cell => cell.textContent.trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
          });
          // First row = header
          const header = tableData[0];
          const separator = header.map(() => '---');
          const lines = [
            '| ' + header.join(' | ') + ' |',
            '| ' + separator.join(' | ') + ' |'
          ];
          for (let i = 1; i < tableData.length; i++) {
            lines.push('| ' + tableData[i].join(' | ') + ' |');
          }
          return '\n\n' + lines.join('\n') + '\n\n';
        }

        case 'thead':
        case 'tbody':
        case 'tr':
        case 'th':
        case 'td':
          return children();

        case 'img': {
          const alt = node.getAttribute('alt') || '';
          const src = node.getAttribute('src') || '';
          return '![' + alt + '](' + src + ')';
        }

        case 'sup': {
          // Citation superscript — strip it
          return '';
        }

        case 'span':
          return children();

        default:
          return children();
      }
    }

    const el = document.querySelector('.ds-assistant-message-main-content')
            || document.querySelector('[class*="assistant-message-main-content"]');
    if (!el) return '';

    let md = processNode(el);

    // Cleanup: collapse 3+ newlines to 2
    md = md.replace(/\n{3,}/g, '\n\n').trim();

    // Cleanup citation artifacts (numbers with leading hyphens)
    md = md
      .replace(/-{1,2}\d+(?:-\d+)+(?=\s|$|[.,،؛!؟?])/g, '')   // -6-12 patterns
      .replace(/\s*--?\d+(?=\s|$|[.,،؛!؟?])/g, '')            // stray -N
      .replace(/[ \t]+([.,،؛!؟?])/g, '$1')                    // space before punctuation
      .replace(/\n{3,}/g, '\n\n');

    return md;
  };
}

// ==================== Rate Limiter ====================
// ✨ NEW: In-memory rate limiting per API key
const rateTracker = {
  _data: {},
  _loadUsage() {
    const usageFile = path.join(process.cwd(), 'usage.json');
    if (fs.existsSync(usageFile)) {
      try { return JSON.parse(fs.readFileSync(usageFile, 'utf-8')); } catch { return {}; }
    }
    return {};
  },
  _saveUsage() {
    const usageFile = path.join(process.cwd(), 'usage.json');
    try { fs.writeFileSync(usageFile, JSON.stringify(this._data, null, 2)); } catch {}
  },
  init() {
    this._data = this._loadUsage();
  },
  check(limitType) {
    const limits = API_CONFIG.limits || {};
    if (!limits || Object.keys(limits).length === 0) return { ok: true };
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);
    const currentHour = new Date().toISOString().substring(0, 13);
    const currentMinute = new Date().toISOString().substring(0, 16);

    switch (limitType) {
      case 'minute': {
        if (this._data.lastMinute !== currentMinute) {
          this._data.minuteCount = 0;
          this._data.lastMinute = currentMinute;
        }
        this._data.minuteCount = (this._data.minuteCount || 0) + 1;
        if (limits.messagesPerMinute && this._data.minuteCount > limits.messagesPerMinute) {
          this._data.minuteCount--;
          return { ok: false, limit: limits.messagesPerMinute, resetIn: 60 };
        }
        break;
      }
      case 'hour': {
        if (this._data.lastHour !== currentHour) {
          this._data.hourlyCount = 0;
          this._data.lastHour = currentHour;
        }
        this._data.hourlyCount = (this._data.hourlyCount || 0) + 1;
        if (limits.messagesPerHour && this._data.hourlyCount > limits.messagesPerHour) {
          this._data.hourlyCount--;
          return { ok: false, limit: limits.messagesPerHour, resetIn: 3600 };
        }
        break;
      }
      case 'day': {
        if (this._data.lastDay !== today) {
          this._data.dailyCount = 0;
          this._data.lastDay = today;
        }
        this._data.dailyCount = (this._data.dailyCount || 0) + 1;
        if (limits.messagesPerDay && this._data.dailyCount > limits.messagesPerDay) {
          this._data.dailyCount--;
          return { ok: false, limit: limits.messagesPerDay, resetIn: 86400 };
        }
        break;
      }
      case 'month': {
        if (this._data.lastMonth !== currentMonth) {
          this._data.monthlyCount = 0;
          this._data.lastMonth = currentMonth;
        }
        this._data.monthlyCount = (this._data.monthlyCount || 0) + 1;
        if (limits.messagesPerMonth && this._data.monthlyCount > limits.messagesPerMonth) {
          this._data.monthlyCount--;
          return { ok: false, limit: limits.messagesPerMonth, resetIn: 2592000 };
        }
        break;
      }
      case 'tokens': {
        if (limits.monthlyTokens && this._data.monthlyTokens && this._data.monthlyTokens[currentMonth]) {
          if (this._data.monthlyTokens[currentMonth] >= limits.monthlyTokens) {
            return { ok: false, limit: limits.monthlyTokens, resetIn: 2592000 };
          }
        }
        break;
      }
    }
    return { ok: true };
  },
  trackTokens(count) {
    const currentMonth = new Date().toISOString().substring(0, 7);
    if (!this._data.monthlyTokens) this._data.monthlyTokens = {};
    this._data.monthlyTokens[currentMonth] = (this._data.monthlyTokens[currentMonth] || 0) + count;
    this._saveUsage();
  },
  save() { this._saveUsage(); }
};

// ==================== Expiration Check ====================
// ✨ NEW: Check if API key has expired
function isApiExpired() {
  if (!API_CONFIG.expiresAt || API_CONFIG.expiresAt === 'never') return false;
  try { return Date.now() > new Date(API_CONFIG.expiresAt).getTime(); } catch { return false; }
}

function getApiInfo() {
  const name = API_CONFIG.name || 'default';
  const apiKey = AUTH_TOKEN;
  const port = PORT;
  const expires = API_CONFIG.expiresAt || 'never';
  const models = API_CONFIG.models ? Object.keys(API_CONFIG.models).filter(k => API_CONFIG.models[k].enabled).length : 'all';
  const limits = API_CONFIG.limits || {};
  const info = { name, apiKey, port, expires, models, limits, torMode: API_CONFIG.torMode || false, showThinking: API_CONFIG.showThinking !== false };
  if (TOR_IP) info.torIP = TOR_IP;
  return info;
}

// ==================== Browser Init ====================
async function initBrowser() {
  if (browser || isInitializing) return;
  isInitializing = true;

  log('INFO', 'Starting browser...');
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--disable-gpu']
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // ✨ NEW: Tor proxy support
  if (API_CONFIG.torMode) {
    contextOptions.proxy = { server: 'socks5://127.0.0.1:9050' };
    log('INFO', 'Tor mode enabled - using SOCKS5 proxy');
    // Verify Tor connection and show IP
    try {
      const testPage = await browser.newContext(contextOptions).then(async ctx => {
        const pg = await ctx.newPage();
        await pg.goto('https://check.torproject.org/api/ip', { timeout: 15000 });
        const ipInfo = await pg.evaluate(() => document.body.textContent);
        await pg.close();
        await ctx.close();
        return ipInfo;
      });
      try {
        const torInfo = JSON.parse(testPage);
        if (torInfo.IsTor) {
          log('INFO', `🔗 Tor verified! IP: ${torInfo.IP}`);
          TOR_IP = torInfo.IP;
        } else {
          log('WARN', `⚠️ Tor NOT working! IP: ${torInfo.IP} - traffic may NOT be going through Tor`);
        }
      } catch {
        log('WARN', 'Could not verify Tor connection, check if Tor service is running');
      }
    } catch (e) {
      log('WARN', `Tor verification failed: ${e.message}`);
    }
  }

  if (fs.existsSync(STATE_FILE)) {
    log('INFO', 'Loading saved browser state...');
    contextOptions.storageState = STATE_FILE;
  }

  context = await browser.newContext(contextOptions);

  // Anti-detection
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    window.chrome = {runtime: {}};
  `);

  // Create initial page
  const initialPage = await createNewPage();

  // ==================== Auto Login ====================
  const creds = loadCredentials();
  let isLoggedIn = false;

  log('INFO', 'Navigating to DeepSeek...');
  await initialPage.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2000, 3000);

  // Check if already logged in (textarea present means logged in)
  isLoggedIn = await initialPage.page.$('textarea').then(el => !!el).catch(() => false);

  if (isLoggedIn) {
    log('INFO', 'Already logged in (session valid)!');
  } else if (!creds) {
    log('WARN', 'No credentials found! Set DEEPSEEK_EMAIL/DEEPSEEK_PASSWORD env vars or create deepseek_credentials.json');
    log('WARN', 'Continuing without login - some features may not work');
    // If not headless, allow manual login
    if (!HEADLESS) {
      log('INFO', 'Opening login page for manual login...');
      await initialPage.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log('INFO', 'Please log in manually. Session will be saved automatically.');
      try {
        await initialPage.page.waitForSelector('textarea', { timeout: 300000 }); // 5 minutes
        isLoggedIn = true;
        log('INFO', 'Manual login successful!');
        try {
          await context.storageState({ path: STATE_FILE });
          log('INFO', 'Session saved!');
        } catch (e) {
          log('WARN', 'Failed to save session state', { error: e.message });
        }
      } catch {
        log('WARN', 'Manual login timed out');
      }
    }
  } else {
    log('INFO', `Logging in: ${creds.email}`);
    await initialPage.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000, 3000);

    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[name="email"]',
      'input[placeholder*="邮箱" i]',
      'input[type="text"]',
    ];

    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = await initialPage.page.$(sel);
      if (emailInput) {
        log('INFO', `   Found email input: ${sel}`);
        break;
      }
    }

    if (emailInput) {
      await emailInput.fill(creds.email);
      await sleep(200);

      const pwdSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[placeholder*="password" i]',
        'input[placeholder*="密码" i]',
      ];

      let pwdInput = null;
      for (const sel of pwdSelectors) {
        pwdInput = await initialPage.page.$(sel);
        if (pwdInput) {
          log('INFO', `   Found password input: ${sel}`);
          break;
        }
      }

      if (pwdInput) {
        await pwdInput.fill(creds.password);
        await sleep(200);

        const loginBtnSelectors = [
          'button[type="submit"]',
          'button:has-text("Log in")',
          'button:has-text("Login")',
          'button:has-text("Sign in")',
          'button:has-text("登录")',
        ];

        let clicked = false;
        for (const sel of loginBtnSelectors) {
          try {
            const btn = await initialPage.page.$(sel);
            if (btn) {
              await btn.click();
              log('INFO', `   Clicked login button: ${sel}`);
              clicked = true;
              break;
            }
          } catch { /* try next */ }
        }

        if (!clicked) {
          await initialPage.page.keyboard.press('Enter');
          log('INFO', '   Pressed Enter to submit');
        }

        for (let i = 0; i < 60; i++) {
          await sleep(1000);
          const hasTextarea = await initialPage.page.$('textarea').then(el => !!el).catch(() => false);
          if (hasTextarea) {
            isLoggedIn = true;
            break;
          }
        }

        if (isLoggedIn) {
          log('INFO', 'Login successful!');
          try {
            await context.storageState({ path: STATE_FILE });
            log('INFO', 'Session saved!');
          } catch (e) {
            log('WARN', 'Failed to save session state', { error: e.message });
          }
        } else {
          log('ERROR', 'Login failed - check your credentials');
        }
      } else {
        log('WARN', 'Password input not found - login page may use a different method');
      }
    } else {
      log('WARN', 'Email input not found - login page may use a different method (OAuth etc.)');
    }
  }

  // Navigate to chat
  log('INFO', 'Navigating to DeepSeek chat...');
  await initialPage.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2000, 3000);

  try {
    await initialPage.page.waitForSelector('textarea', { timeout: 30000 });
  } catch {
    log('WARN', 'Chat page load timed out, continuing anyway...');
  }

  initialPage.busy = false;
  initialPage.lastUsed = Date.now();

  setInterval(cleanupIdlePages, 30000);
  setInterval(saveState, 30000);
  // ✨ NEW: Save usage stats every 5 minutes
  setInterval(() => rateTracker.save(), 300000);
  isInitializing = false;

  log('INFO', `Browser ready. Pages will be created on demand (max: ${MAX_PAGES})`);
}

async function createNewPage() {
  const page = await context.newPage();
  const pageObj = { page, busy: true, id: pageIdCounter++, lastUsed: Date.now() };
  pagePool.push(pageObj);
  log('INFO', `Created new page ${pageObj.id} (total: ${pagePool.length})`);
  return pageObj;
}

async function cleanupIdlePages() {
  const now = Date.now();
  const toRemove = [];
  const minPages = 1;

  for (const p of pagePool) {
    if (!p.busy && pagePool.length > minPages && (now - p.lastUsed) > PAGE_IDLE_TIMEOUT) {
      if (pagePool.length - toRemove.length > minPages) {
        toRemove.push(p);
      }
    }
  }

  for (const p of toRemove) {
    if (pagePool.length <= minPages) break;
    try {
      await p.page.close();
      pagePool = pagePool.filter(x => x.id !== p.id);
      log('INFO', `Closed idle page ${p.id} (remaining: ${pagePool.length})`);
    } catch (e) {
      log('WARN', `Failed to close page ${p.id}`, { error: e.message });
    }
  }
}

async function saveState() {
  if (!context) return;
  try { await context.storageState({ path: STATE_FILE }); } catch (e) {
    log('WARN', 'Failed to save state', { error: e.message });
  }
}

async function getAvailablePage() {
  for (const p of pagePool) {
    if (!p.busy) {
      p.busy = true;
      p.lastUsed = Date.now();
      log('INFO', `Reusing page ${p.id}`);
      return p;
    }
  }

  if (pagePool.length < MAX_PAGES) {
    return await createNewPage();
  }

  log('INFO', `All ${MAX_PAGES} pages busy, waiting...`);
  return new Promise((resolve) => {
    const check = setInterval(() => {
      for (const p of pagePool) {
        if (!p.busy) {
          p.busy = true;
          p.lastUsed = Date.now();
          clearInterval(check);
          log('INFO', `Page ${p.id} became available`);
          resolve(p);
          return;
        }
      }
    }, 100);
  });
}

function releasePage(pageObj) {
  pageObj.busy = false;
  pageObj.lastUsed = Date.now();
}

// ==================== Browser Utils (DeepSeek-specific) ====================
async function pasteText(page, selector, text) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  await el.focus();
  await page.evaluate((content) => {
    document.execCommand('insertText', false, content);
  }, text);
}

async function toggleButton(page, buttonName, targetState) {
  // DeepSeek's toggles (DeepThink / Search) are <div class="ds-toggle-button"> with
  // tabindex="0" (NOT <button>), so getByRole('button') does not match them.
  // We locate them by CSS class + inner text and read aria-pressed / --selected.
  try {
    // Find toggle divs whose text exactly matches the requested name.
    const locator = page.locator(`[class*="ds-toggle-button"]`).filter({ hasText: buttonName });
    const count = await locator.count();
    if (count === 0) return false;

    // Pick the first one whose trimmed text is exactly the button name
    // (filter:hasText matches substring, so we tighten with exact text match).
    let target = null;
    for (let i = 0; i < count; i++) {
      const txt = (await locator.nth(i).textContent())?.trim();
      if (txt === buttonName) { target = locator.nth(i); break; }
    }
    if (!target) target = locator.first();

    const isSelected = await target.evaluate(el => {
      return el.classList.contains('ds-toggle-button--selected') ||
             el.getAttribute('aria-pressed') === 'true';
    });

    if (isSelected !== targetState) {
      await target.click();
      await sleep(300, 500);
      log('INFO', `Toggled ${buttonName} to ${targetState}`);
    } else {
      log('INFO', `${buttonName} already in target state ${targetState}`);
    }
    return true;
  } catch (e) {
    log('WARN', `toggleButton(${buttonName}) failed: ${e.message}`);
    return false;
  }
}

// ==================== DeepSeek Generate ====================
async function generate(prompt, modelId = 'deepseek-v4-pro', onChunk = null) {
  if (!pagePool.length) throw new Error('Browser not initialized');

  const isStreaming = typeof onChunk === 'function';
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const pageObj = await getAvailablePage();
  const page = pageObj.page;

  log('INFO', `Starting generation on page ${pageObj.id}...`, {
    model: modelId, streaming: isStreaming, requestId
  });

  try {
    // Navigate to fresh chat
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(2000, 3000);

    // Inject interceptors for SSE capture (fetch, XHR, and EventSource)
    // ✨ FIXED: DeepSeek uses /api/v0/chat/completion with text/event-stream.
    // The SSE protocol uses JSON-Patch-like messages:
    //   {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}  ← append to active fragment
    //   {"v":"text"}                                                    ← continue last fragment
    //   {"v":{"response":{"fragments":[{"type":"THINK|RESPONSE",...}]}}} ← initial fragment list
    //   {"o":"BATCH","p":"response","v":[{"p":"status","v":"FINISHED"}]} ← completion
    await page.evaluate(({ reqId, debug }) => {
      if (!window.__deepseekRequests) {
        window.__deepseekRequests = {};
      }

      window.__deepseekRequests[reqId] = {
        chunks: [],
        reasoningChunks: [],
        complete: false,
        error: null,
        active: true,
        responseFragmentIndex: -1,
        reasoningFragmentIndices: [],
        currentFragmentIndex: -1,
        fragmentCount: 0,
        debug: [],
        observedFragmentTypes: []
      };

      // Helper to track a fragment
      const trackFragment = (fragment, idx, req) => {
        if (debug && req.observedFragmentTypes.length < 10 && !req.observedFragmentTypes.includes(fragment.type)) {
          req.observedFragmentTypes.push(fragment.type);
        }
        // Track the real fragment id
        if (!req.fragmentIds) req.fragmentIds = [];
        if (!req.fragmentIds.includes(idx)) req.fragmentIds.push(idx);

        if (fragment.type === 'RESPONSE') {
          req.responseFragmentIndex = idx;
          req.currentFragmentIndex = idx;
          if (fragment.content) req.chunks.push(fragment.content);
        } else if (fragment.type === 'THINK' || fragment.type === 'THINKING' || fragment.type === 'REASONING' || fragment.type === 'REASONING_CONTENT') {
          if (!req.reasoningFragmentIndices.includes(idx)) req.reasoningFragmentIndices.push(idx);
          req.currentFragmentIndex = idx;
          if (fragment.content) req.reasoningChunks.push(fragment.content);
        } else {
          req.currentFragmentIndex = idx;
        }
      };

      // Helper to append content to the right fragment
      // DeepSeek uses -1 to mean "the currently active fragment" (the last one added).
      const appendContent = (fragIdx, content, req) => {
        // Resolve -1 to the real current fragment index
        const realIdx = fragIdx === -1 ? req.currentFragmentIndex : fragIdx;
        if (realIdx === -1) {
          // No active fragment yet — default to response
          req.chunks.push(content);
          return;
        }
        if (req.reasoningFragmentIndices.includes(realIdx)) {
          req.reasoningChunks.push(content);
        } else if (realIdx === req.responseFragmentIndex) {
          req.chunks.push(content);
        } else {
          // Unknown fragment — treat as response
          req.chunks.push(content);
          if (req.responseFragmentIndex === -1) req.responseFragmentIndex = realIdx;
        }
        req.currentFragmentIndex = realIdx;
      };

      // Helper to parse SSE data
      const parseSSEData = (text, req) => {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('event:') || !line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '{}') continue;

          try {
            const data = JSON.parse(dataStr);

            // Initial fragments — full response object with fragments array
            if (data.v?.response?.fragments && Array.isArray(data.v.response.fragments)) {
              for (const fragment of data.v.response.fragments) {
                // DeepSeek uses -1 as the fragment id in the path, but here it's a real id
                // We use fragmentCount as our local index
                const idx = fragment.id !== undefined ? fragment.id : req.fragmentCount++;
                trackFragment(fragment, idx, req);
              }
              // Mark status if present
              if (data.v.response.status === 'FINISHED') req.complete = true;
            }

            // Simple text append — {"v":"text"}
            // This continues the current active fragment (the last one appended to)
            if (data.v && typeof data.v === 'string' && !data.p && !data.o) {
              if (req.currentFragmentIndex !== -1 && req.reasoningFragmentIndices.includes(req.currentFragmentIndex)) {
                req.reasoningChunks.push(data.v);
              } else if (req.currentFragmentIndex !== -1 && req.currentFragmentIndex === req.responseFragmentIndex) {
                req.chunks.push(data.v);
              } else {
                // No active fragment yet — treat as response
                req.chunks.push(data.v);
                if (req.responseFragmentIndex === -1) req.responseFragmentIndex = req.currentFragmentIndex;
              }
            }

            // APPEND with path — {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
            if (data.o === 'APPEND' && data.p && typeof data.v === 'string') {
              const match = data.p.match(/response\/fragments\/(-?\d+)\/content/);
              if (match) {
                const fragIdx = parseInt(match[1], 10);
                appendContent(fragIdx, data.v, req);
              }
            }

            // Path without operator — {"p":"response/fragments/N/content","v":"text"}
            if (data.p && typeof data.v === 'string' && !data.o) {
              const match = data.p.match(/response\/fragments\/(-?\d+)\/content/);
              if (match) {
                const fragIdx = parseInt(match[1], 10);
                appendContent(fragIdx, data.v, req);
              }
            }

            // fragments APPEND — new fragment added
            if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
              for (const fragment of data.v) {
                const idx = fragment.id !== undefined ? fragment.id : req.fragmentCount++;
                trackFragment(fragment, idx, req);
              }
            }

            // BATCH operations — {"o":"BATCH","p":"response","v":[...]}
            if (data.o === 'BATCH' && data.p === 'response' && Array.isArray(data.v)) {
              for (const item of data.v) {
                if (item.p === 'fragments' && item.o === 'APPEND' && Array.isArray(item.v)) {
                  for (const fragment of item.v) {
                    const idx = fragment.id !== undefined ? fragment.id : req.fragmentCount++;
                    trackFragment(fragment, idx, req);
                  }
                }
                if (item.p && typeof item.v === 'string') {
                  const match = item.p.match(/fragments\/(-?\d+)\/content/);
                  if (match) {
                    const fragIdx = parseInt(match[1], 10);
                    appendContent(fragIdx, item.v, req);
                  }
                }
                if (item.p === 'status' && item.v === 'FINISHED') {
                  req.complete = true;
                }
              }
            }
          } catch {}
        }
      };

      if (!window.__deepseekIntercepted) {
        window.__deepseekIntercepted = true;

        // Intercept XMLHttpRequest
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this._url = url;
          this._method = method;
          return originalXHROpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function(body) {
          const url = this._url || '';

          if (url.includes('chat') && (url.includes('completion') || url.includes('message'))) {
            const activeReqId = Object.keys(window.__deepseekRequests || {})
              .find(id => window.__deepseekRequests[id]?.active);

            if (activeReqId) {
              const req = window.__deepseekRequests[activeReqId];
              req.debug.push(`XHR: ${url.substring(0, 100)}`);

              let lastIndex = 0;
              this.addEventListener('progress', () => {
                const text = this.responseText.substring(lastIndex);
                lastIndex = this.responseText.length;
                if (text) parseSSEData(text, req);
              });

              this.addEventListener('load', () => {
                const text = this.responseText.substring(lastIndex);
                if (text) parseSSEData(text, req);
                req.complete = true;
              });

              this.addEventListener('error', () => {
                req.error = 'XHR error';
                req.complete = true;
              });
            }
          }

          return originalXHRSend.call(this, body);
        };

        // Intercept fetch
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          const url = args[0]?.toString?.() || args[0]?.url || '';

          const activeReqId = Object.keys(window.__deepseekRequests || {})
            .find(id => window.__deepseekRequests[id]?.active);

          if (activeReqId && window.__deepseekRequests[activeReqId]) {
            window.__deepseekRequests[activeReqId].debug.push(`fetch: ${url.substring(0, 80)}`);
          }

          if (url.includes('chat') && (url.includes('completion') || url.includes('message'))) {
            const clone = response.clone();
            const reader = clone.body?.getReader();

            if (reader && activeReqId) {
              const req = window.__deepseekRequests[activeReqId];
              const decoder = new TextDecoder();

              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      req.complete = true;
                      break;
                    }
                    const text = decoder.decode(value, { stream: true });
                    parseSSEData(text, req);
                  }
                } catch (e) {
                  req.error = e.message;
                  req.complete = true;
                }
              })();
            }
          }
          return response;
        };

        // Intercept EventSource
        const OriginalEventSource = window.EventSource;
        window.EventSource = function(url, config) {
          const es = new OriginalEventSource(url, config);

          const activeReqId = Object.keys(window.__deepseekRequests || {})
            .find(id => window.__deepseekRequests[id]?.active);

          if (activeReqId) {
            const req = window.__deepseekRequests[activeReqId];
            req.debug.push(`EventSource: ${url.substring(0, 80)}`);

            es.addEventListener('message', (event) => {
              if (event.data) {
                parseSSEData(`data: ${event.data}`, req);
              }
            });

            es.addEventListener('error', () => {
              req.complete = true;
            });
          }

          return es;
        };
      }
    }, { reqId: requestId, debug: SSE_DEBUG });

    // Wait for input
    await page.waitForSelector('textarea', { timeout: 60000 });
    await sleep(500, 1000);

    // Configure model options (DeepThink, Search)
    const thinking = modelId.includes('thinking');
    const search = modelId.includes('search');

    // Try both English and French button names
    const thinkingClicked = await toggleButton(page, 'DeepThink', thinking) ||
                            await toggleButton(page, 'Pensée profonde', thinking);
    await sleep(200, 400);
    const searchClicked = await toggleButton(page, 'Search', search) ||
                          await toggleButton(page, 'Rechercher', search);
    await sleep(200, 400);

    log('INFO', `Toggle buttons: thinking=${thinking} (clicked=${thinkingClicked}), search=${search} (clicked=${searchClicked})`);

    // Type prompt using paste
    await page.click('textarea');
    await sleep(200, 300);
    await pasteText(page, 'textarea', prompt);
    await sleep(500, 1000);

    // Send message
    await page.keyboard.press('Enter');
    log('INFO', 'Message sent, polling SSE for chunks...');

    // ✨ HYBRID POLLING: SSE for real-time streaming + DOM for final markdown cleanup.
    // - SSE chunks give us raw text deltas as DeepSeek streams them (great for streaming UX)
    // - DOM final read gives us properly formatted markdown (tables, lists, bold) at the end
    let fullResponse = '';
    let fullReasoning = '';
    let lastChunkCount = 0;
    let lastReasoningCount = 0;
    let stableCount = 0;
    let thinkingPhaseActive = false;
    let responseStarted = false;
    let completionTicks = 0;
    const REQUIRED_COMPLETION_TICKS = 600; // 600 × 200ms = 120s (2 min) of stable state required
    const startTime = Date.now();
    const timeout = 900000; // 15 minutes (for very long generations)

    // ✨ NEW: Configurable timeouts (default: 120s thinking, 30s answer)
    const THINKING_STABLE_LIMIT = API_CONFIG.thinkingTimeout || 1200;
    const ANSWER_STABLE_LIMIT = API_CONFIG.answerTimeout || 300;

    while (Date.now() - startTime < timeout) {
      await sleep(200);

      // Read SSE chunks + DOM state in one go
      const result = await page.evaluate((reqId) => {
        const req = window.__deepseekRequests?.[reqId];
        const sseChunks = req?.chunks || [];
        const sseReasoning = req?.reasoningChunks || [];
        const sseComplete = req?.complete || false;
        const sseError = req?.error;
        const observedFragmentTypes = req?.observedFragmentTypes || [];

        // Also read DOM state for completion detection + markdown cleanup
        let reasoningText = '';
        const thinkEl = document.querySelector('.ds-think-content')
                     || document.querySelector('[class*="ds-think"]')
                     || document.querySelector('[class*="think-content"]');
        if (thinkEl) reasoningText = thinkEl.textContent?.trim() || '';

        // Note: We removed the stop-button and loading-indicator detection because
        // DeepSeek's UI doesn't use standard class names we can match reliably.
        // Instead, we rely on SSE complete flag + long stability timeout.

        return {
          sseChunks, sseReasoning, sseComplete, sseError, observedFragmentTypes,
          domReasoning: reasoningText
        };
      }, requestId);

      if (result.sseError && result.sseError !== 'Request not found') {
        log('WARN', 'SSE error', { error: result.sseError });
      }
      if (stableCount === 0 && result.observedFragmentTypes?.length > 0) {
        log('INFO', `SSE observed fragment types: [${result.observedFragmentTypes.join(', ')}]`);
      }

      // Process reasoning chunks from SSE
      if (result.sseReasoning.length > lastReasoningCount) {
        const newReasoning = result.sseReasoning.slice(lastReasoningCount);
        for (const chunk of newReasoning) {
          fullReasoning += chunk;
          if (isStreaming && onChunk) onChunk(chunk, true);
        }
        lastReasoningCount = result.sseReasoning.length;
        stableCount = 0;
        thinkingPhaseActive = true;
      }

      // Process response chunks from SSE — these are the raw streaming deltas
      if (result.sseChunks.length > lastChunkCount) {
        const newChunks = result.sseChunks.slice(lastChunkCount);
        for (const chunk of newChunks) {
          fullResponse += chunk;
          if (isStreaming && onChunk) onChunk(cleanChunk(chunk), false);
        }
        lastChunkCount = result.sseChunks.length;
        stableCount = 0;
        thinkingPhaseActive = false;
        responseStarted = true;
      } else if (fullResponse.length > 0 || fullReasoning.length > 0) {
        stableCount++;
      }

      // ✨ Completion detection: rely on SSE complete flag primarily.
      // If SSE says complete, we can stop (DOM will be read next for final markdown).
      // If SSE doesn't flag complete (some responses don't send FINISHED),
      // require a LONG stability period (10 seconds of no new content) before
      // assuming the response is done. This prevents premature termination
      // when DeepSeek pauses mid-generation to think.
      const sseDone = result.sseComplete && (fullResponse.length > 0 || fullReasoning.length > 0);

      if (sseDone) {
        log('INFO', `Response complete (SSE flagged complete)`);
        break;
      }

      // Fallback: stability-based completion (no SSE complete flag received)
      if (responseStarted && fullResponse.length > 0) {
        // Count ticks where no new content arrived
        if (result.sseChunks.length === lastChunkCount && result.sseReasoning.length === lastReasoningCount) {
          completionTicks++;
          if (completionTicks >= REQUIRED_COMPLETION_TICKS) {
            log('INFO', `Response complete (stable for ${completionTicks * 200}ms, no SSE complete flag)`);
            break;
          }
        } else {
          completionTicks = 0;
        }
      }

      // Stability timeouts (fallback if completion detection fails)
      if (thinkingPhaseActive || (fullReasoning.length > 0 && !responseStarted)) {
        if (stableCount > THINKING_STABLE_LIMIT) {
          log('INFO', `Thinking stable for ${(THINKING_STABLE_LIMIT * 200 / 1000).toFixed(0)}s, assuming complete`);
          break;
        }
      } else if (responseStarted && fullResponse.length > 0) {
        if (stableCount > ANSWER_STABLE_LIMIT) {
          log('INFO', `Response stable for ${(ANSWER_STABLE_LIMIT * 200 / 1000).toFixed(0)}s, assuming complete`);
          break;
        }
      }
    }

    // ✨ FINAL DOM MARKDOWN CLEANUP: After SSE completes, ALWAYS read the DOM and
    // convert to markdown. This is the canonical response — SSE was only for
    // real-time streaming UX. DOM preserves tables, lists, bold, headings, code blocks.
    // We read multiple times until the content stabilizes (no more growth) to ensure
    // we capture the complete response even if DOM lags behind SSE.
    if (true) {
      try {
        // Wait for DOM to fully render the last SSE chunks
        let domMd = '';
        let prevLen = 0;
        let stableReads = 0;
        const REQUIRED_STABLE_READS = 3; // 3 consecutive reads with no growth
        const MAX_READS = 15; // max 15 reads (~15 seconds)

        for (let i = 0; i < MAX_READS; i++) {
          await sleep(800);
          domMd = await page.evaluate(() => {
            const el = document.querySelector('.ds-assistant-message-main-content')
                    || document.querySelector('[class*="assistant-message-main-content"]');
            if (!el) return '';
            function pn(node) {
              if (node.nodeType === 3) return node.textContent;
              if (node.nodeType !== 1) return '';
              const tag = node.tagName.toLowerCase();
              const kids = () => Array.from(node.childNodes).map(pn).join('');
              switch (tag) {
                case 'h1': return '\n\n# ' + node.textContent.trim() + '\n\n';
                case 'h2': return '\n\n## ' + node.textContent.trim() + '\n\n';
                case 'h3': return '\n\n### ' + node.textContent.trim() + '\n\n';
                case 'h4': return '\n\n#### ' + node.textContent.trim() + '\n\n';
                case 'h5': return '\n\n##### ' + node.textContent.trim() + '\n\n';
                case 'h6': return '\n\n###### ' + node.textContent.trim() + '\n\n';
                case 'strong': case 'b': return '**' + kids() + '**';
                case 'em': case 'i': return '*' + kids() + '*';
                case 'code': return '`' + node.textContent + '`';
                case 'pre': return '\n```\n' + node.textContent + '\n```\n\n';
                case 'a': { const h = node.getAttribute('href') || ''; return '[' + node.textContent + '](' + h + ')'; }
                case 'br': return '\n';
                case 'hr': return '\n---\n\n';
                case 'blockquote': { const inner = kids().trim(); return '\n' + inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n'; }
                case 'p': return kids() + '\n\n';
                case 'ul': return '\n' + Array.from(node.children).map(li => '- ' + pn(li).trim()).join('\n') + '\n\n';
                case 'ol': return '\n' + Array.from(node.children).map((li, i) => (i + 1) + '. ' + pn(li).trim()).join('\n') + '\n\n';
                case 'li': return kids();
                case 'table': {
                  const rows = Array.from(node.querySelectorAll('tr'));
                  if (rows.length === 0) return kids();
                  const data = rows.map(row => Array.from(row.querySelectorAll('th, td')).map(c => c.textContent.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
                  const header = data[0];
                  const sep = header.map(() => '---');
                  const lines = ['| ' + header.join(' | ') + ' |', '| ' + sep.join(' | ') + ' |'];
                  for (let i = 1; i < data.length; i++) lines.push('| ' + data[i].join(' | ') + ' |');
                  return '\n\n' + lines.join('\n') + '\n\n';
                }
                case 'thead': case 'tbody': case 'tr': case 'th': case 'td': return kids();
                case 'img': { const a = node.getAttribute('alt') || ''; const s = node.getAttribute('src') || ''; return '![' + a + '](' + s + ')'; }
                case 'sup': return '';  // strip citation superscripts
                case 'span': return kids();
                default: return kids();
              }
            }
            let md = pn(el);
            md = md
              .replace(/\n{3,}/g, '\n\n')
              .replace(/-{1,2}\d+(?:-\d+)+(?=\s|$|[.,،؛!؟?])/g, '')
              .replace(/\s*--?\d+(?=\s|$|[.,،؛!؟?])/g, '')
              .replace(/[ \t]+([.,،؛!؟?])/g, '$1')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            return md;
          });

          if (domMd.length === prevLen) {
            stableReads++;
            if (stableReads >= REQUIRED_STABLE_READS) break;
          } else {
            stableReads = 0;
            prevLen = domMd.length;
          }
        }

        log('INFO', `DOM markdown stabilized after ${stableReads} stable reads: ${domMd.length} chars`);

        // ALWAYS use DOM markdown as the canonical response (preserves formatting)
        if (domMd && domMd.length > 20) {
          log('INFO', `Using DOM markdown: ${domMd.length} chars (SSE had ${fullResponse.length})`);
          fullResponse = domMd;
        }
      } catch (e) {
        log('WARN', 'DOM markdown cleanup failed', { error: e.message });
      }
    }

    // Also read thinking from DOM for consistency
    if (true) {
      try {
        const domReasoning = await page.evaluate(() => {
          const el = document.querySelector('.ds-think-content')
                  || document.querySelector('[class*="ds-think"]')
                  || document.querySelector('[class*="think-content"]');
          if (!el) return '';
          let text = el.textContent?.trim() || '';
          // Strip "Thought for X seconds" prefix
          text = text.replace(/^Thought for \d+ seconds?/i, '').trim();
          return text;
        });
        if (domReasoning && domReasoning.length > fullReasoning.length) {
          fullReasoning = domReasoning;
        }
      } catch {}
    }

    // Cleanup request
    await page.evaluate((reqId) => {
      if (window.__deepseekRequests?.[reqId]) {
        window.__deepseekRequests[reqId].active = false;
        setTimeout(() => {
          delete window.__deepseekRequests[reqId];
        }, 5000);
      }
    }, requestId);

    if (!fullResponse?.trim() && !fullReasoning?.trim()) {
      throw new Error('Empty response - no SSE chunks received');
    }
    if (!fullResponse?.trim() && fullReasoning?.trim()) {
      log('WARN', 'No answer content captured, using reasoning as fallback content');
      fullResponse = fullReasoning;
      fullReasoning = '';
    }

    log('INFO', `Page ${pageObj.id} generated ${fullResponse.length} chars` + (fullReasoning.length ? ` (reasoning: ${fullReasoning.length} chars)` : ''));
    return { content: fullResponse.trim(), reasoning: fullReasoning.trim() };

  } finally {
    releasePage(pageObj);
  }
}

// ==================== Tool Calling (Function Calling Simulation) ====================
// ✨ OpenAI-compatible tool calling via prompt injection + response parsing.
// Works with ANY OpenAI client (Open WebUI, LangChain, AutoGen, etc.)
//
// Flow:
//   1. Client sends `tools` array in request
//   2. We inject a system prompt describing available tools + JSON schema
//   3. DeepSeek responds — we parse the response for tool call JSON
//   4. If found, return `tool_calls` array (OpenAI format)
//   5. Client executes tool, sends result back as `role: "tool"` message
//   6. We convert tool result to text and feed it back to DeepSeek

// Convert OpenAI tools schema to a text description for the model
function describeToolsForPrompt(tools) {
  if (!tools || !tools.length) return '';

  let desc = 'You have access to the following tools. When you need to use a tool, respond with a JSON object in EXACTLY this format (and nothing else):\n\n';
  desc += '```json\n{"tool_calls": [{"name": "<tool_name>", "arguments": {"<arg>": "<value>"}}]}\n```\n\n';
  desc += 'Rules:\n';
  desc += '- Only use the JSON format above when you want to call a tool. Do NOT wrap it in markdown or add explanation.\n';
  desc += '- The JSON must be valid and parseable. Use double quotes for all strings.\n';
  desc += '- You can call multiple tools at once by adding them to the "tool_calls" array.\n';
  desc += '- After receiving tool results, use them to formulate your final answer.\n\n';
  desc += 'Available tools:\n\n';

  for (const tool of tools) {
    if (tool.type === 'function' && tool.function) {
      const fn = tool.function;
      desc += `### ${fn.name}\n`;
      if (fn.description) desc += `${fn.description}\n`;
      if (fn.parameters) {
        desc += 'Parameters:\n';
        desc += '```json\n' + JSON.stringify(fn.parameters, null, 2) + '\n```\n\n';
      } else {
        desc += 'Parameters: none\n\n';
      }
    }
  }

  return desc;
}

// Build the tool instruction prefix to inject before the user's prompt
function buildToolPromptPrefix(tools, toolChoice) {
  if (!tools || !tools.length) return '';

  let prefix = describeToolsForPrompt(tools);

  // Handle tool_choice
  if (toolChoice === 'none') {
    prefix += '\nIMPORTANT: Do NOT call any tools. Answer directly.\n';
  } else if (toolChoice === 'required') {
    prefix += '\nIMPORTANT: You MUST call at least one tool. Do not answer directly.\n';
  } else if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    prefix += `\nIMPORTANT: You MUST call the tool "${toolChoice.function.name}". Do not answer directly.\n`;
  }
  // 'auto' (default) — no extra instruction

  prefix += '\n---\n\n';
  return prefix;
}

// Convert messages array (with role:tool and role:assistant tool_calls) to a
// single text prompt that DeepSeek can understand. DeepSeek chat UI is stateless
// and doesn't support roles, so we flatten everything into one text block.
function convertMessagesToPrompt(messages, tools, toolChoice) {
  const toolPrefix = buildToolPromptPrefix(tools, toolChoice);
  let prompt = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      prompt += `[System Instructions]\n${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}\n\n`;
    } else if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('\n') : JSON.stringify(msg.content));
      prompt += `[User]\n${content}\n\n`;
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length) {
        // Previous assistant tool call — show it as a JSON block
        const calls = msg.tool_calls.map(tc => ({
          name: tc.function?.name || tc.name,
          arguments: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || tc.arguments)
        }));
        const callsJson = JSON.stringify(calls, null, 2);
        prompt += '[Assistant]\n```json\n{"tool_calls": ' + callsJson + '}\n```\n\n';
      } else if (msg.content) {
        prompt += `[Assistant]\n${msg.content}\n\n`;
      }
    } else if (msg.role === 'tool') {
      // Tool result — show it clearly
      const toolName = msg.name || msg.tool_call_id || 'tool';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      prompt += `[Tool Result: ${toolName}]\n${content}\n\n`;
    }
  }

  return toolPrefix + prompt.trim();
}

// Parse DeepSeek's response to extract tool calls.
// Looks for JSON blocks like: {"tool_calls": [{"name": "...", "arguments": {...}}]}
// Also handles: {"name": "...", "arguments": {...}} and raw function calls.
function parseToolCallsFromResponse(text) {
  if (!text) return null;

  // Strategy 1: Look for ```json ... ``` blocks containing tool_calls
  const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match;
  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        return { toolCalls: parsed.tool_calls, remainingText: text.replace(match[0], '').trim() };
      }
      // Single tool call object
      if (parsed.name && parsed.arguments !== undefined) {
        return { toolCalls: [parsed], remainingText: text.replace(match[0], '').trim() };
      }
    } catch {}
  }

  // Strategy 2: Look for bare JSON objects with tool_calls (no code block)
  // Match the outermost { ... } that contains tool_calls
  const toolCallsRegex = /\{\s*"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = toolCallsRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        return { toolCalls: parsed.tool_calls, remainingText: (text.substring(0, match.index) + text.substring(match.index + match[0].length)).trim() };
      }
    } catch {}
  }

  // Strategy 3: Look for {"name": "...", "arguments": {...}} patterns
  const nameArgsRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const foundCalls = [];
  let lastIndex = 0;
  let cleanedText = '';
  while ((match = nameArgsRegex.exec(text)) !== null) {
    try {
      const name = match[1];
      const args = JSON.parse(match[2]);
      foundCalls.push({ name, arguments: args });
      cleanedText += text.substring(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
    } catch {}
  }
  if (foundCalls.length) {
    cleanedText += text.substring(lastIndex);
    return { toolCalls: foundCalls, remainingText: cleanedText.trim() };
  }

  return null;
}

// Convert parsed tool calls to OpenAI format
function toOpenAIToolCalls(toolCalls) {
  return toolCalls.map((tc, idx) => ({
    id: `call_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
    }
  }));
}

// ==================== HTTP Server ====================
// DeepSeek model lineup (current as of 2026-07)
//
// Both V4-Flash and V4-Pro support:
//   - Thinking mode (DeepThink toggle on chat UI)
//   - Web Search (Search toggle on chat UI)
//   - 1M context, 384K max output, JSON output, Tool calls
//
// Note: legacy aliases `deepseek-chat` and `deepseek-reasoner` will be
// deprecated on 2026/07/24 → both now map to V4-Flash (non-thinking / thinking).
const MODELS = [
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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  return auth.replace('Bearer ', '') === AUTH_TOKEN;
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ✨ NEW: Check API expiration
  if (API_CONFIG.apiKey && isApiExpired()) {
    if (pathname === '/health') return sendJson(res, 200, { status: 'expired', message: 'API key has expired' });
    if (pathname.startsWith('/v1/')) return sendJson(res, 403, { error: { message: 'API key has expired', type: 'expired_error', code: 'api_expired' } });
  }

  // ✨ NEW: Rate limiting check
  if (API_CONFIG.apiKey && req.method === 'POST' && pathname.startsWith('/v1/')) {
    for (const checkType of ['minute', 'hour', 'day', 'month', 'tokens']) {
      const result = rateTracker.check(checkType);
      if (!result.ok) {
        return sendJson(res, 429, { error: { message: `Rate limit exceeded (${checkType}: ${result.limit} max). Retry after ${Math.ceil(result.resetIn / 60)} minutes.`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } });
      }
    }
  }

  if (pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', browser: !!browser, totalPages: pagePool.length, busyPages: pagePool.filter(p => p.busy).length, maxPages: MAX_PAGES });
  }

  // ✨ NEW: API info endpoint
  if (pathname === '/v1/api-info' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const info = getApiInfo();
    info.browser = !!browser; info.totalPages = pagePool.length; info.busyPages = pagePool.filter(p => p.busy).length; info.expired = isApiExpired();
    return sendJson(res, 200, info);
  }

  // ✨ NEW: Reload config without restart
  if (pathname === '/admin/reload' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        API_CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        rateTracker.init();
        log('INFO', 'Configuration reloaded from config.json');
        return sendJson(res, 200, { success: true, message: 'Config reloaded', config: API_CONFIG });
      }
      return sendJson(res, 404, { error: 'config.json not found' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    // ✨ NEW: Filter and rename models based on config
    let availableModels;
    if (API_CONFIG.models) {
      availableModels = MODELS.filter(m => {
        if (API_CONFIG.showThinking === false && m.id.includes('thinking')) return false;
        const cfg = API_CONFIG.models[m.id];
        return cfg ? cfg.enabled : false;
      }).map(m => {
        const cfg = API_CONFIG.models[m.id];
        const customId = cfg?.customName ? cfg.customName.toLowerCase().replace(/\s+/g, '-') : m.id;
        return { id: customId, object: 'model', created: Date.now(), owned_by: 'deepseek' };
      });
    } else {
      availableModels = MODELS.map(m => ({ id: m.id, object: 'model', created: Date.now(), owned_by: 'deepseek' }));
    }
    return sendJson(res, 200, { object: 'list', data: availableModels });
  }

  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { model = 'deepseek-v4-pro', messages = [], stream = false, tools = null, tool_choice = 'auto' } = body;
      if (!messages.length) return sendJson(res, 400, { error: 'No messages provided' });

      // ✨ NEW: Build prompt with tool calling support.
      // If tools are provided, we flatten the entire conversation (system, user, assistant, tool)
      // into a single text prompt with a tool instruction prefix.
      // If no tools, use the simple "last user message" approach (backward compatible).
      let prompt;
      const hasTools = tools && Array.isArray(tools) && tools.length > 0;
      if (hasTools) {
        prompt = convertMessagesToPrompt(messages, tools, tool_choice);
        log('INFO', `Tool calling enabled (${tools.length} tools, choice=${typeof tool_choice === 'object' ? JSON.stringify(tool_choice) : tool_choice})`);
      } else {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        if (!lastUserMsg) return sendJson(res, 400, { error: 'No user message found' });
        prompt = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : lastUserMsg.content.map(c => c.text || '').join('\n');
      }

      // ✨ NEW: Reverse map custom model names back to original IDs
      // CRITICAL: Preserve -thinking / -search suffixes because they control
      // whether the DeepThink and Search toggle buttons are pressed in generate().
      let resolvedModel = model;
      if (API_CONFIG.models) {
        // Extract suffixes from the incoming model name
        const hasThinking = model.includes('-thinking');
        const hasSearch = model.includes('-search');
        const suffix = (hasThinking ? '-thinking' : '') + (hasSearch ? '-search' : '');
        // Base model name without suffixes (what's actually stored in config)
        const baseModel = model.replace(/-thinking/g, '').replace(/-search/g, '');

        let found = false;
        // First: exact match on original ID (with suffixes, in case user enabled that exact variant)
        if (API_CONFIG.models[model]) {
          resolvedModel = model;
          found = true;
        }
        // Second: match base model (without suffixes) and re-attach the suffixes
        if (!found) {
          if (API_CONFIG.models[baseModel]) {
            resolvedModel = baseModel + suffix;
            found = true;
          }
        }
        // Third: match by custom name on the base model
        if (!found) {
          for (const [originalId, cfg] of Object.entries(API_CONFIG.models)) {
            if (!cfg.enabled) continue;
            const customId = cfg.customName ? cfg.customName.toLowerCase().replace(/\s+/g, '-') : originalId;
            if (customId === baseModel.toLowerCase().trim()) {
              resolvedModel = originalId + suffix;
              found = true;
              break;
            }
          }
        }
        log('INFO', `Incoming model: "${model}" → Resolved: "${resolvedModel}"`, { found, suffix });
      }

      const responseId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

        // ✨ For tool calling in streaming mode, we buffer the full response and
        // parse it at the end to extract tool_calls. This is necessary because
        // we can't know if the response contains tool calls until it's complete.
        let streamBuffer = '';
        let streamReasoning = '';

        const onChunk = (chunk, isReasoning = false) => {
          // ✨ NEW: Hide thinking from client if showThinking is false
          if (isReasoning && API_CONFIG.showThinking === false) {
            streamReasoning += chunk;
            return;
          }
          if (isReasoning) {
            streamReasoning += chunk;
            const chunkData = { id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] };
            res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
          } else {
            // If tools are present, buffer the content instead of streaming it
            // (we need to parse the full response to detect tool calls)
            if (hasTools) {
              streamBuffer += chunk;
            } else {
              const cleanedChunk = cleanChunk(chunk);
              const chunkData = { id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: cleanedChunk }, finish_reason: null }] };
              res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
            }
          }
        };

        try {
          await generate(prompt, resolvedModel, onChunk);

          // ✨ If tools were provided, parse the buffered response for tool calls
          if (hasTools && streamBuffer) {
            const parsed = parseToolCallsFromResponse(streamBuffer);
            if (parsed && parsed.toolCalls.length) {
              const openAIToolCalls = toOpenAIToolCalls(parsed.toolCalls);
              log('INFO', `Detected ${openAIToolCalls.length} tool call(s) in streaming response`);

              // Send the tool_calls as the final delta
              const toolCallDelta = {
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { tool_calls: openAIToolCalls },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(toolCallDelta)}\n\n`);

              // Send any remaining text as content (if any)
              if (parsed.remainingText && parsed.remainingText.trim()) {
                const contentDelta = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: parsed.remainingText }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(contentDelta)}\n\n`);
              }

              // Finish with tool_calls reason
              const finishData = { id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
              res.write(`data: ${JSON.stringify(finishData)}\n\n`);
              res.write('data: [DONE]\n\n');
            } else {
              // No tool calls detected — stream the buffered content now
              const cleanedContent = cleanResponse(streamBuffer);
              if (cleanedContent) {
                const contentDelta = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: cleanedContent }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(contentDelta)}\n\n`);
              }
              const finishData = { id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
              res.write(`data: ${JSON.stringify(finishData)}\n\n`);
              res.write('data: [DONE]\n\n');
            }
          } else {
            // No tools — normal finish
            const finishData = { id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
            res.write(`data: ${JSON.stringify(finishData)}\n\n`);
            res.write('data: [DONE]\n\n');
          }
        } catch (e) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); }
        return res.end();
      } else {
        const result = await generate(prompt, resolvedModel);
        const text = result?.content || result || '';
        const reasoning = result?.reasoning || '';
        const cleanedText = cleanResponse(text);

        // ✨ If tools were provided, parse the response for tool calls
        if (hasTools && cleanedText) {
          const parsed = parseToolCallsFromResponse(cleanedText);
          if (parsed && parsed.toolCalls.length) {
            const openAIToolCalls = toOpenAIToolCalls(parsed.toolCalls);
            log('INFO', `Detected ${openAIToolCalls.length} tool call(s) in response`);

            const message = {
              role: 'assistant',
              content: parsed.remainingText || null,
              tool_calls: openAIToolCalls
            };
            if (reasoning && API_CONFIG.showThinking !== false) message.reasoning_content = reasoning;

            return sendJson(res, 200, {
              id: responseId,
              object: 'chat.completion',
              created,
              model,
              choices: [{ index: 0, message, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            });
          }
        }

        // Normal response (no tool calls detected, or no tools provided)
        const message = { role: 'assistant', content: cleanedText };
        if (reasoning && API_CONFIG.showThinking !== false) message.reasoning_content = reasoning;
        return sendJson(res, 200, { id: responseId, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
    } catch (e) {
      log('ERROR', 'Generation failed', { error: e.message });
      return sendJson(res, 500, { error: e.message });
    }
  }

  sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
}

// ==================== Main ====================
async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║        DeepSeek API Server - Multi-Instance Template          ║
║        Config-driven | Rate Limited | Tor Ready               ║
║        All fixes: SSE Fragments + Smart Stability             ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  await initBrowser();

  // ✨ NEW: Initialize rate tracker
  rateTracker.init();

  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    log('INFO', `DeepSeek Server running on http://${HOST}:${PORT}`);
    log('INFO', `API Key: ${AUTH_TOKEN}`);
    log('INFO', `State File: ${STATE_FILE}`);
    log('INFO', `SSE Debug: ${SSE_DEBUG ? 'ENABLED' : 'disabled'}`);

    // ✨ NEW: Show API config info if running as managed instance
    if (API_CONFIG.apiKey) {
      const info = getApiInfo();
      log('INFO', `API: "${info.name}" | Key: ${info.apiKey.substring(0, 12)}... | Port: ${info.port}`);
      log('INFO', `Expires: ${info.expires} | Models: ${info.models} | Tor: ${info.torMode ? 'ON' : 'OFF'} | Thinking: ${info.showThinking ? 'ON' : 'OFF'}`);
      const lim = info.limits;
      if (lim.messagesPerMinute) log('INFO', `Limits: ${lim.messagesPerMinute}/min, ${lim.messagesPerHour}/hr, ${lim.messagesPerDay}/day, ${lim.messagesPerMonth}/month`);
      if (lim.monthlyTokens) log('INFO', `Token limit: ${lim.monthlyTokens.toLocaleString()}/month`);
    }

    const creds = loadCredentials();
    if (creds) { log('INFO', `Credentials: ${creds.email} (from ${process.env.DEEPSEEK_EMAIL ? 'env' : 'file'})`); }
    else { log('INFO', 'Credentials: Not configured'); }

    log('INFO', 'Endpoints:');
    log('INFO', `  GET  http://${HOST}:${PORT}/health               - Health check`);
    log('INFO', `  GET  http://${HOST}:${PORT}/v1/models            - List models`);
    log('INFO', `  POST http://${HOST}:${PORT}/v1/chat/completions  - Chat (stateless)`);
    if (API_CONFIG.apiKey) log('INFO', `  GET  http://${HOST}:${PORT}/v1/api-info          - API info`);
  });

  process.on('SIGINT', async () => {
    log('INFO', 'Shutting down...');
    rateTracker.save();
    if (context) await saveState();
    if (browser) await browser.close();
    process.exit(0);
  });
}

main().catch(e => { log('ERROR', 'Startup failed', { error: e.message }); process.exit(1); });
