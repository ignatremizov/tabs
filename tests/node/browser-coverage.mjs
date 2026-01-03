// tests/node/browser-coverage.mjs: collect browser coverage via CDP
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coverageDir = process.argv[2] || path.join(root, 'coverage');
const port = 9234;
let debugPort = 9222;

const testPages = [
  '/tests/dom-safety.test.html',
  '/tests/tree-node.test.html?env=chrome',
  '/tests/tree-node.test.html?env=firefox',
  '/tests/merge-open-windows.test.html?env=chrome',
  '/tests/merge-open-windows.test.html?env=firefox'
];

function filePathForUrl(urlPath) {
  const filePath = path.join(root, urlPath.split('?')[0]);
  return filePath;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const filePath = filePathForUrl(req.url || '/');
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function findChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    'google-chrome',
    'chromium',
    'chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of pathDirs) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {}
    }
  }
  return null;
}

async function waitForDebugger() {
  const url = `http://127.0.0.1:${debugPort}/json/version`;
  const deadline = Date.now() + 15000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      lastStatus = res.status;
      if (res.ok) return await res.json();
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const statusMsg = (lastStatus !== null) ? ` (last status: ${lastStatus})` : '';
  throw new Error(`Timed out waiting for Chrome debugger${statusMsg}`);
}

async function createPageTarget() {
  const listUrl = `http://127.0.0.1:${debugPort}/json/list`;
  const createUrl = `http://127.0.0.1:${debugPort}/json/new?about:blank`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const listRes = await fetch(listUrl);
      if (listRes.ok) {
        const targets = await listRes.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {}
    try {
      const res = await fetch(createUrl);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out creating Chrome target');
}

async function connectWebSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return ws;
}

function createCdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const cb of listeners.get(msg.method)) cb(msg.params || {});
    }
  };

  function on(method, cb) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(cb);
    return () => {
      const list = listeners.get(method) || [];
      const idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  function send(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  return { send, on };
}

async function waitForTestDone(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'window.__TEST_DONE__ === true',
      returnByValue: true
    });
    if (result && result.result && result.result.value === true) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for test completion');
}

async function run() {
  fs.mkdirSync(coverageDir, { recursive: true });
  const server = await startServer();
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    server.close();
    throw new Error('Chrome binary not found. Set CHROME_BIN.');
  }
  debugPort = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });

  const userDataDir = fs.mkdtempSync(path.join(coverageDir, 'chrome-profile-'));
  const chrome = spawn(chromeBin, [
    '--headless',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=1200,800'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    chrome.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn(`Chrome stderr: ${msg}`);
    });
    chrome.on('exit', (code) => {
      if (code !== null) console.warn(`Chrome exited with code ${code}`);
    });

    await waitForDebugger();
    console.log(`Connected to Chrome debugger on ${debugPort}`);
    const target = await createPageTarget();
    const ws = await connectWebSocket(target.webSocketDebuggerUrl);
    const cdp = createCdpClient(ws);

    let pageLogs = [];
    let pageErrors = [];
    let currentPage = null;

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const args = (params.args || []).map((arg) => arg.value).filter(Boolean);
      if (currentPage) pageLogs.push(`[${params.type}] ${args.join(' ')}`);
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      if (!currentPage) return;
      const details = params.exceptionDetails || {};
      const text = details.text || 'Exception';
      pageErrors.push(text);
    });

    for (const page of testPages) {
      currentPage = page;
      pageLogs = [];
      pageErrors = [];
      const loadPromise = new Promise((resolve) => {
        const handler = () => {
          off();
          resolve();
        };
        const off = cdp.on('Page.loadEventFired', handler);
      });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${page}` });
      await loadPromise;
      try {
        await waitForTestDone(cdp, 20000);
      } catch (err) {
        const logMsg = pageLogs.slice(-10).join('\n');
        const errMsg = pageErrors.slice(-5).join('\n');
        throw new Error(
          `Timeout waiting for tests: ${page}\n` +
          (errMsg ? `Errors:\n${errMsg}\n` : '') +
          (logMsg ? `Logs:\n${logMsg}\n` : '')
        );
      }
    }

    const coverage = await cdp.send('Profiler.takePreciseCoverage');
    await cdp.send('Profiler.stopPreciseCoverage');

    const out = path.join(coverageDir, `browser-coverage-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify({ result: coverage.result }, null, 2), 'utf8');

    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
