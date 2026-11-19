#!/usr/bin/env node
// @ts-nocheck
/**
 * 子进程探针：新进程打开工程，打印摘要与哈希后退出。
 * 用于 M4-A9「关掉重开进程，解析结果与哈希不变」——必须是真实新进程，不是同进程重开。
 *
 * 用法：node open-once.mjs <projectDir>
 */

import { startStudio } from '../studio-server.mjs';
import { postJson } from './helpers.mjs';

const dir = process.argv[2];
if (typeof dir !== 'string' || dir === '') {
  process.stderr.write('usage: node open-once.mjs <projectDir>\n');
  process.exit(3);
}

const studio = await startStudio({ port: 0, vitePort: 59370, logger: () => undefined });
try {
  const opened = await postJson(`${studio.url}/api/projects/open`, { path: dir });
  if (opened.status !== 200 || opened.body?.ok !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: opened.status, body: opened.body })}\n`);
    process.exitCode = 1;
  } else {
    const project = opened.body.project;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        hash: project.sourceHash,
        summary: {
          stage: project.stage,
          fps: project.fps,
          trackCount: project.trackCount,
          clipCount: project.clipCount,
          durationSec: project.durationSec,
          diagnostics: project.diagnostics.length,
        },
        thumbnails: {
          requested: opened.body.thumbnails.requested,
          pending: opened.body.thumbnails.pending,
        },
      })}\n`,
    );
  }
} finally {
  await studio.close();
}
