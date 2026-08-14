// common/common.js: code shared by all scripts
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isFirefox } from '/api.js';


export function _ (...args) {
  return api.i18n.getMessage(...args);
}


// 0: errors + warnings only
// 1: add log() messages
// 2: add debug() messages
export let verbosity = 2;


// log() functions (debug/log/warn/error) have an odd interface.
// They try to attach a relevant part of a stack trace
// unless instructed not to.  And since the relevant part might
// change depending on how deep the caller is,
// the caller can specify a depth.
// Depth is the first arg, but can be omitted.
// A depth of 0 means "no stack trace".
// A depth of 1 or more means "descend this many extra levels".
// If omitted, it adds a track with no extra depth.
// Examples:
//   log('text', extra): default (stack trace, regular depth)
//     -> logCaller(console.log, 0, 'text', extra);
//   log(0, 'text', extra): (no stack trace)
//     -> console.log('text', extra);
//   log(1, 'text', extra): (stack trace, +1 depth)
//     -> logCaller(console.log, 1, 'text', extra);


export function debug (...args) {
  if (globalThis.__TKTSTO_TEST_QUIET__) return;
  if ((! verbosity) || (verbosity < 2)) return;
  logCallerMaybe(console.debug, ...args);
}


export function log (...args) {
  if (globalThis.__TKTSTO_TEST_QUIET__) return;
  if (! verbosity) return;
  logCallerMaybe(console.log, ...args);
}


export function warn (...args) {
  logCallerMaybe(console.warn, ...args);
}


export function error (...args) {
  logCallerMaybe(console.error, ...args);
}


function logCallerMaybe (logger, depth, ...args) {
  if (Number.isFinite(depth)) {
    // log(0, 'text', extra): -> console.log('text', extra);
    // no stack trace
    if (0 === depth) logger(...args);
    // log(1, 'text', extra): -> logCaller(console.log, 1, 'text', extra);
    // deeper stack trace
    else logCaller(logger, depth, ...args);
  }
  // log('text', extra): -> logCaller(console.log, 0, 'text', extra);
  // default stack trace
  // (depth is a message here, not a depth)
  else logCaller(logger, 0, depth, ...args);
}


// oh boy, get ready for some JANK
// We want to log the "Class.methodName" and "/dir/file.js:lineNum"
// of the caller, but Javascript doesn't have proper stack trace objects
// or caller introspection...  so we have to parse
// a text representation of the stack trace,
// (which is different for each browser)
// to extract the relevant info.
// Regexes ahoy!
function logCaller (logger, depth, msg, ...args) {
  // log a message, but insert the name of the caller first
  // Example stack trace we're parsing (Chrome):
  //   Error
  //     at logCaller (common.js:35:15)
  //     at debug (common.js:15:3)
  //     at Bkgd.onWindowFocusChanged (bkgd.js:385:5)
  // Or in Firefox:
  //   logCaller@moz-extension://extId/common/common.js:53:17
  //   debug@moz-extension://extId/common/common.js:22:12
  //   ensureCursorVisible@moz-extension://extId/view/treeview.js:1753:12
  //   ...
  try {
    const err = new Error();
    //console.debug(`logCaller(${depth})`, err.stack);
    let match, fn, script, junk;
    if (isFirefox) {
      // funcName@moz-extension://extId/dir/file.js:123:45
      const line = err.stack.split('\n')[3 + depth];
      if (line) {
        match = line.match(/(.*)@.*:\/\/[^\/]+(\/.*)/);
        if (match) [, fn, script] = match;
      }
    }
    else {  // Chrome
      // at async Class.funcName (ext://extId/file.js:123:45)
      // at async Class.funcName (/file.js:123:45)
      // at ext://extId/file.js:123:45
      // at /file.js:123:45
      const line = err.stack.split('\n')[4 + depth];
      if (line) {
        const m = line.match(/at (([^\(]+) \()?(.*:\/\/[^\/]+)?([^\)]+)\)?/);
        if (m) {
          fn = m[2];
          script = m[4];
        }
      }
    }
    if (fn || script) {
      fn = fn || '<anonymous>';
      logger(`${fn} ${script}\n${msg}`, ...args);
    }
    else logger(msg, ...args);
  } catch (err) {
    console.warn(err);
    logger(msg, ...args);
  }
}


export const jsonSchema = 'https://toykeeper.net/tktsto/session-backup-json-schema-v1';


// unused
// make a date tuple similar to python
//export function dateTuple (date) {
//  if (undefined === date) date = new Date(Date.now());
//  const result = [
//    // year, month, day, hour, minute, second, ms, weekday, tzOffsetMinutes
//    date.getFullYear(), date.getMonth()+1, date.getDate(),
//    date.getHours(), date.getMinutes(), date.getSeconds(),
//    date.getMilliseconds(), date.getDay(), date.getTimezoneOffset()
//  ];
//  return result;
//}


// WTF, javascript doesn't have strftime()
export function dateTupleStrings (date) {
  if (undefined === date) date = new Date(Date.now());
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // calculate timezone offset string, like '+05:00' or '-3:30'
  let tzOffset = date.getTimezoneOffset();
  const ipart = Math.floor(tzOffset);
  const fpart = tzOffset % 1;
  if (tzOffset < 0) tzOffset = String(ipart / 60.0);
  else tzOffset = '+' + String(ipart / 60.0);
  tzOffset = tzOffset + ':' + String(Math.floor(fpart * 60)).padStart(2, '0');
  // build the tuple of strings
  const result = [
    // year, month, day, hour, minute, second, ms, weekday, tzOffsetMinutes
    String(date.getFullYear()).padStart(4,'0'),
    String(date.getMonth()+1).padStart(2,'0'),  // getMonth() is 0 to 11
    String(date.getDate()).padStart(2,'0'),
    String(date.getHours()).padStart(2,'0'),
    String(date.getMinutes()).padStart(2,'0'),
    String(date.getSeconds()).padStart(2,'0'),
    String(date.getMilliseconds()).padStart(3,'0'),
    weekdays[date.getDay()],
    tzOffset
  ];
  return result;
}


export function fmtDate (date) {
  if (! date) return '';
  // serialized dates turn into a plain number; convert it back
  if ('number' === typeof date) date = new Date(date);
  // generate ISO 8601 style timestamp string in local time zone
  return date.toLocaleString("en-CA", { hour12: false });
}

const emitSourceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
globalThis.__tktstoEmitSourceId = emitSourceId;
export { emitSourceId };
let emitRequestCounter = 0;

const emitFailureState = {
  lastWarnAt: 0
};

function reportEmitFailure (name, args, tries, maxTries) {
  const now = Date.now();
  const cooldownMs = Number.isFinite(emit.failureCooldownMs)
    ? Math.max(0, emit.failureCooldownMs)
    : 0;
  if (cooldownMs &&
      emitFailureState.lastWarnAt &&
      (now - emitFailureState.lastWarnAt) < cooldownMs) {
    return;
  }
  emitFailureState.lastWarnAt = now;
  const detail = {
    name,
    args,
    tries,
    maxTries,
    status: 'Background not responding; actions may be delayed.'
  };
  if ('function' === typeof emit.onFailure) {
    try {
      emit.onFailure(detail);
    } catch (err) {
      error(1, 'emit.onFailure error', err);
    }
  }
  if (('undefined' !== typeof CustomEvent) && globalThis.dispatchEvent) {
    try {
      globalThis.dispatchEvent(new CustomEvent('tktsto_emit_failure', { detail }));
    } catch (err) {
      error(1, 'emit failure event error', err);
    }
  }
}

export async function emit (name, args, extra) {
  if (emit.disabled) return;  // abort if we're turned off
  // Older callers passed the retry flag directly as the third argument.
  if ('boolean' === typeof extra) extra = { retry: extra };
  const retry = (undefined === extra?.retry) ? true : extra.retry;
  const port = extra?.port;
  const requiresResponse = ((! emit.isBkgd) && name?.startsWith?.('tree_'))
    || (name?.startsWith?.('bkgd_') && ('bkgd_ping' !== name));

  // ensure valid args
  if (!((typeof name === 'string') || (name instanceof String)))
    throw new TypeError(`emit(name): name was not a string: ${name}`);
  if (undefined === args) args = {};
  else args = { ...args };
  args['msg'] = name;
  if (! args.sourceId) args.sourceId = emitSourceId;
  if (name.startsWith('bkgd_')
    && ('bkgd_ping' !== name)
    && (! args.requestId)) {
    emitRequestCounter += 1;
    args.requestId = `${emitSourceId}-${emitRequestCounter.toString(36)}`;
  }
  // debug info except for noisy pings
  if ('bkgd_ping' !== name) debug(1, `emit(${name})`, args, extra);
  // abort if we're the Bkgd script and there are no receivers
  if (emit.isBkgd && (0 === emit.bkgd.ports.length)) {
    debug(1, 'emit(bkgd): no receivers');
    return;
  }
  // dict-ify parameters so they can be serialized
  for (const key in args) {
    if (args[key] && args[key].toDict) args[key] = args[key].toDict();
  }
  // get ready to try more than once,
  // because sometimes the service worker gets killed
  // and needs a few moments to wake up before it can respond
  let response;
  let delivered = false;
  let lastError;
  let attempts = 0;
  const maxTries = Number.isFinite(emit.maxTries)
    ? Math.max(1, emit.maxTries)
    : 10;
  const attemptLimit = retry ? maxTries : 1;
  const retryDelayMs = Number.isFinite(emit.retryDelayMs)
    ? Math.max(0, emit.retryDelayMs)
    : 50;
  const startTime = performance.now();
  while ((! delivered) && (attempts < attemptLimit)) {
    attempts += 1;
    try {
      // Port.postMessage() returns void, no reply expected
      if (port) {
        //debug(1, `portEmit(${name}):`, port, args);
        port.postMessage(args);
        response = {};
      }
      // runtime.sendMessage() expects a reply
      else {
        response = await api.runtime.sendMessage(args);
        // Tree mutations require a background persistence acknowledgement.
        // Firefox can resolve sendMessage() with undefined when nobody
        // responds, which otherwise looks indistinguishable from success.
        if (requiresResponse && (! response)) {
          const acknowledgement = name.startsWith('tree_')
            ? 'persistence acknowledgement'
            : 'background response';
          throw new Error(`missing ${acknowledgement}`);
        }
      }
      delivered = true;
      if ('bkgd_ping' !== name) {
        if (('bkgd_getTree' === name) && ('string' === typeof response)) {
          debug(1, `emit(${name}) response: ${response.length} JSON bytes`);
        }
        else {
          debug(1, `emit(${name}) response:`, response);
        }
      }
    } catch (err) {
      lastError = err;
      log(1, `emit(${name}) error, try #${attempts}`, err, args);
      if (attempts < attemptLimit) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  if (! delivered) {
    // If message delivery failed repeatedly, surface it in the UI.
    error(1, `emit(${name}) exceeded maximum retries`, name, args);
    reportEmitFailure(name, args, attempts, attemptLimit);
    if (requiresResponse) {
      const detail = lastError?.message || String(lastError || 'unknown error');
      throw new Error(`${name}: message delivery failed: ${detail}`);
    }
  }
  const endTime = performance.now();
  if ('bkgd_ping' !== name)
    debug(1, `emit(${name}) elapsed: ${endTime - startTime} ms`);
  if (requiresResponse && response?.error) {
    throw new Error(`${name}: ${response.error}`);
  }
  return response;
}

emit.maxTries = 10;
emit.retryDelayMs = 50;
emit.failureCooldownMs = 30000;
emit.onFailure = null;

export function sanitizeClientId (clientId) {
  if (! clientId) return '';
  return String(clientId).replace(/[^a-zA-Z0-9]/g, '');
}

export function isIllegalURL (url) {
  if (! url) return false;

  let allowedPrefixes = [ 'http:', 'https:' ];
  let illegalPrefixes = [];

  if (isFirefox) {
    // Firefox has some annoying limitations on what extensions can do
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1275209
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1412498
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1420405
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1864001
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create
    // May be allowed eventually?
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1266960
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1787179
    allowedPrefixes = [
      'about:blank',
      'about:home',  // allowed, but auto-redirects to about:blank
    ];
    illegalPrefixes = [
      'file:',
      'about:',
      'chrome:',
      'javascript:',
      'data:',
    ];
  }

  // always allow these (overrides illegalPrefixes)
  for (const prefix of allowedPrefixes)
    if (url.startsWith(prefix)) return false;

  // these are banned
  for (const prefix of illegalPrefixes)
    if (url.startsWith(prefix)) return true;

  // if no match, assume it's allowed
  return false;
}


export function isNewTabPage (url) {
  const prefixes = [
    // firefox, librewolf, ...
    'about:newtab',
    'about:blank',
    'about:home',
    'about://newtab',
    'about://blank',
    'about://home',
    // chrome, chromium, ...
    'chrome://newtab',
    // edge
    'edge://newtab',
    'edge://new-tab-page',
    // vivaldi
    'chrome://vivaldi-webui/startpage',
  ];
  for (const prefix of prefixes)
    if (url.startsWith(prefix)) return true;
  return false;
}
