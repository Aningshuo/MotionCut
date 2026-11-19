#!/usr/bin/env node
/**
 * M65 证据/单测用的假 ACP 进程。
 *
 * 只做两件事：回 `initialize`、回 `session/new`，并把**收到的 `session/new` params**
 * 原样写进 `--capture <file>`。它不 implements 任何工具，也不读设置——
 * 「设置 → mcpServers」这段映射发生在客户端（`acp.mjs`），这里只是收包方。
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const captureIndex = argv.indexOf('--capture');
const captureFile = captureIndex >= 0 ? argv[captureIndex + 1] : '';

/** @param {string} text */
function writeCapture(text) {
  if (!captureFile) return;
  try {
    fs.writeFileSync(captureFile, text, 'utf8');
  } catch {
    /* 证据文件写不了不影响协议应答 */
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (line === '') continue;
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'mock-acp-capture', version: '0.0.0' },
            agentCapabilities: { loadSession: false },
            authMethods: [{ id: 'none', name: 'Mock' }],
          },
        })}\n`,
      );
      continue;
    }
    if (msg.method === 'session/new') {
      writeCapture(`${JSON.stringify({ params: msg.params }, null, 2)}\n`);
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'mock-capture-session', cwd: msg.params?.cwd ?? '' },
        })}\n`,
      );
      continue;
    }
    if (typeof msg.id === 'number') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } })}\n`,
      );
    }
  }
});

process.stdin.on('end', () => process.exit(0));
