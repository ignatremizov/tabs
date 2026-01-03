// tests/node/coverage-report.mjs: summarize V8 coverage output
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coverageDir = process.argv[2] || path.join(root, 'coverage');

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const next = ranges[i];
    if (next[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], next[1]);
    } else {
      merged.push(next);
    }
  }
  return merged;
}

function addRange(ranges, start, end) {
  if (end <= start) return;
  ranges.push([start, end]);
}

function bytesFromRanges(ranges) {
  let total = 0;
  for (const range of ranges) total += (range[1] - range[0]);
  return total;
}

function toPath(url) {
  if (url.startsWith('file://')) {
    const filePath = fileURLToPath(url);
    if (!filePath.startsWith(root)) return null;
    if (filePath.includes(`${path.sep}tests${path.sep}`)) return null;
    return filePath;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      const pathname = decodeURIComponent(parsed.pathname || '/');
      const filePath = path.join(root, pathname);
      if (!filePath.startsWith(root)) return null;
      if (filePath.includes(`${path.sep}tests${path.sep}`)) return null;
      return filePath;
    } catch {
      return null;
    }
  }
  return null;
}

if (!fs.existsSync(coverageDir)) {
  console.error(`Coverage directory not found: ${coverageDir}`);
  process.exit(1);
}

const files = fs.readdirSync(coverageDir).filter((name) => name.endsWith('.json'));
const byFile = new Map();

for (const name of files) {
  const jsonPath = path.join(coverageDir, name);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  for (const script of data.result || []) {
    const filePath = toPath(script.url || '');
    if (!filePath) continue;
    let entry = byFile.get(filePath);
    if (!entry) {
      const source = fs.readFileSync(filePath, 'utf8');
      entry = {
        size: Buffer.byteLength(source, 'utf8'),
        ranges: [],
        source
      };
      byFile.set(filePath, entry);
    }
    for (const fn of script.functions || []) {
      for (const range of fn.ranges || []) {
        if (range.count <= 0) continue;
        const isTopLevel = (
          fn.functionName === '' &&
          range.startOffset === 0 &&
          range.endOffset >= entry.size
        );
        if (isTopLevel) continue;
        addRange(entry.ranges, range.startOffset, range.endOffset);
      }
    }
  }
}

let totalLines = 0;
let totalLinesCovered = 0;
const rows = [];

for (const [filePath, entry] of byFile.entries()) {
  const merged = mergeRanges(entry.ranges);
  const source = entry.source;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lines = [];
  for (let i = 0; i < lineStarts.length; i++) {
    const start = lineStarts[i];
    const end = (i + 1 < lineStarts.length) ? lineStarts[i + 1] : source.length;
    const text = source.slice(start, end);
    lines.push({ start, end, text });
  }
  let coveredLines = 0;
  let countedLines = 0;
  for (const line of lines) {
    if (line.text.trim().length === 0) continue;
    countedLines += 1;
    let hit = false;
    for (const range of merged) {
      if (range[1] <= line.start) continue;
      if (range[0] >= line.end) break;
      hit = true;
      break;
    }
    if (hit) coveredLines += 1;
  }
  totalLines += countedLines;
  totalLinesCovered += coveredLines;
  const pct = countedLines > 0 ? (coveredLines / countedLines) * 100 : 0;
  rows.push({ filePath, pct });
}

rows.sort((a, b) => a.filePath.localeCompare(b.filePath));

for (const row of rows) {
  const rel = path.relative(root, row.filePath);
  console.log(`${row.pct.toFixed(1)}%  ${rel}`);
}

const totalPct = totalLines > 0 ? (totalLinesCovered / totalLines) * 100 : 0;
console.log(`\nTotal coverage (lines): ${totalPct.toFixed(1)}%`);
if (process.env.COVERAGE_BADGE_PATH) {
  const badgeValue = `${Math.round(totalPct)}%`;
  const badgePath = process.env.COVERAGE_BADGE_PATH;
  const current = fs.readFileSync(badgePath, 'utf8');
  const pattern = /coverage-(\d+)%25-/;
  const match = current.match(pattern);
  if (!match) {
    console.warn('Coverage badge not updated: pattern not found');
  } else {
    const next = current.replace(
      pattern,
      `coverage-${badgeValue.replace('%', '%25')}-`
    );
    if (next === current) {
      console.log(`Coverage badge already up to date: ${badgeValue}`);
    } else {
      fs.writeFileSync(badgePath, next, 'utf8');
      console.log(`Updated coverage badge: ${badgeValue}`);
    }
  }
}
