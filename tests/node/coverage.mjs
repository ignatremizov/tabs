// tests/node/coverage.mjs: run node tests with V8 coverage
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coverageDir = path.join(root, 'coverage');
const loader = path.join(root, 'tests/node/loader.mjs');
const runner = path.join(root, 'tests/node/run-tests.mjs');
const report = path.join(root, 'tests/node/coverage-report.mjs');
const browser = path.join(root, 'tests/node/browser-coverage.mjs');

fs.rmSync(coverageDir, { recursive: true, force: true });

const testRun = spawnSync(
  process.execPath,
  ['--experimental-loader', loader, runner],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_V8_COVERAGE: coverageDir
    }
  }
);

if (testRun.status !== 0) process.exit(testRun.status || 1);

const browserRun = spawnSync(
  process.execPath,
  [browser, coverageDir],
  { cwd: root, stdio: 'inherit' }
);

if (browserRun.status !== 0) process.exit(browserRun.status || 1);

const reportRun = spawnSync(
  process.execPath,
  [report, coverageDir],
  { cwd: root, stdio: 'inherit' }
);

process.exit(reportRun.status || 0);
