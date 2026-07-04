#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const USERSCRIPT = path.join(DIR, 'douyin.user.js');
const DM_LIB = path.join(DIR, 'dm-bridge-lib.js');
const DM_FUNCS = path.join(DIR, 'dm-bridge-funcs.js');

const userscript = fs.readFileSync(USERSCRIPT, 'utf8');
const dmLib = fs.readFileSync(DM_LIB, 'utf8');
const dmFuncs = fs.readFileSync(DM_FUNCS, 'utf8');

// Backup
fs.writeFileSync(USERSCRIPT + '.bak', userscript, 'utf8');

// ═══ STEP 1: Insert DM_BRIDGE_CODE block before BRIDGE_CODE ═══
const dmInjection = [
  '  // ═══════════════════════════════════════════════════════════',
  '  // DM Bridge 库 (protobuf + 辅助函数)，注入页面上下文',
  '  // ═══════════════════════════════════════════════════════════',
  '  var DM_BRIDGE_CODE = (function () {/*',
  dmLib,
  '*/}).toString().match(/\\/\\*([\\s\\S]*)\\*\\//)[1];',
  '  unsafeWindow.eval(DM_BRIDGE_CODE);',
  '  console.log(\'[Bridge:Douyin] DM Bridge lib injected\');',
  '',
].join('\n');

const marker1 = '\n  var BRIDGE_CODE = (function () {/*\n';
const idx1 = userscript.indexOf(marker1);
if (idx1 === -1) { console.error('Cannot find BRIDGE_CODE'); process.exit(1); }
// Insert after the newline that starts the marker
let result = userscript.slice(0, idx1 + 1) + dmInjection + userscript.slice(idx1 + 1);

// ═══ STEP 2: Insert __bridge DM functions before getDetail ═══
const marker2 = '\n  getDetail: async function(awemeId){\n';
const idx2 = result.indexOf(marker2);
if (idx2 === -1) { console.error('Cannot find getDetail'); process.exit(1); }
result = result.slice(0, idx2 + 1) + dmFuncs + result.slice(idx2 + 1);

// ═══ STEP 3: Add auto-connect for DM WebSocket ═══
const autoConnect = [
  '  // ── Auto-connect DM WebSocket (3s delay) ──',
  '  setTimeout(function() {',
  '    try { (0, unsafeWindow.eval)(\'if(window.__bridge&&window.__bridge.connectDMWS)window.__bridge.connectDMWS();\'); } catch(e) {}',
  '  }, 3000);',
  '',
].join('\n');

const marker3 = '\n  // ── 启动轮询 ──\n  connect();\n';
const idx3 = result.indexOf(marker3);
if (idx3 !== -1) {
  result = result.slice(0, idx3 + 1) + autoConnect + result.slice(idx3 + 1);
} else {
  console.warn('Cannot find connect() — skipping auto-connect');
}

// ═══ Write ═══
fs.writeFileSync(USERSCRIPT, result, 'utf8');
console.log('Done:', USERSCRIPT);
console.log('Lines:', result.split('\n').length);
console.log('Backup:', USERSCRIPT + '.bak');
