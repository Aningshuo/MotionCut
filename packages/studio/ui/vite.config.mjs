/**
 * Studio 渲染层（Vite 包）。
 *
 * 端口不写死：从 `OPENCUT_ENV_JSON`（缺省 lane 的 env.json）读 `vitePort` / `studioPort`。
 * - 构建产物给 Studio 静态服务用（`packages/studio/ui/dist`）；
 * - `dev` 时把 `/api`、`/healthz`、`/events` 代理到 Studio 自己的端口，页面代码里一律用相对路径。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** @returns {{ studioPort?: number, vitePort?: number }} */
function readEnv() {
  const envPath = process.env.OPENCUT_ENV_JSON ?? join(repoRoot, '.local-runs', 'main', 'env.json');
  try {
    const parsed = JSON.parse(readFileSync(envPath, 'utf8'));
    return {
      studioPort: Number.isInteger(parsed?.studioPort) ? parsed.studioPort : undefined,
      vitePort: Number.isInteger(parsed?.vitePort) ? parsed.vitePort : undefined,
    };
  } catch {
    return {};
  }
}

const env = readEnv();
const vitePort = env.vitePort ?? 59370;
const studioPort = env.studioPort ?? 59369;
const studioTarget = `http://127.0.0.1:${studioPort}`;

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target: studioTarget, changeOrigin: false },
      '/healthz': { target: studioTarget, changeOrigin: false },
      '/events': { target: `ws://127.0.0.1:${studioPort}`, ws: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
  },
  build: {
    outDir: join(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
  },
});
