// tests/node/loader.mjs: resolve /path imports to repo root
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith('/')) {
    const resolved = pathToFileURL(path.join(root, specifier));
    return { url: resolved.href, shortCircuit: true };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
