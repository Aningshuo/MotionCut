/**
 * MCP stdio 传输（WP18）。
 *
 * MCP 的 stdio：一行一条 JSON-RPC 消息，UTF-8，`\n` 结尾。stdout **只准**写协议
 * 消息——任何 `console.log` 都会把客户端弄崩，所以这里把日志一律导向 stderr。
 *
 * 三条健壮性：
 * 1. 坏 JSON → `-32700`（带 id:null），进程不死；
 * 2. 通知（无 id）不回包；
 * 3. stdin 关闭 → 等在途请求 settle 后退出码 0。
 */

import { LineDecoder, RPC, encodeMessage, rpcError } from './jsonrpc.mjs';

/**
 * @param {{
 *   server: { handle: (message: any) => Promise<object | null> },
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<void>} stdin 结束且队列清空后 resolve
 */
export function serveStdio(opts) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));

  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  /** @type {() => void} */
  let resolveDone = () => {};
  /** @type {Promise<void>} */
  const done = new Promise((resolve) => {
    resolveDone = () => resolve();
  });

  const send = (/** @type {unknown} */ message) => {
    output.write(encodeMessage(message));
  };

  const decoder = new LineDecoder({
    onMessage: (message) => {
      tail = tail
        .then(async () => {
          const response = await opts.server.handle(message);
          if (response) send(response);
        })
        .catch((err) => {
          log(`INTERNAL: ${/** @type {Error} */ (err)?.message ?? err}`);
          const id = /** @type {any} */ (message)?.id ?? null;
          send(rpcError(id, RPC.INTERNAL_ERROR, 'internal error'));
        });
    },
    onGarbage: (line) => {
      log(`parse error: ${line.slice(0, 200)}`);
      send(rpcError(null, RPC.PARSE_ERROR, 'parse error: invalid JSON'));
    },
  });

  input.on('data', (chunk) => decoder.push(/** @type {Buffer} */ (chunk)));
  input.on('end', () => {
    decoder.end();
    tail.then(() => resolveDone());
  });
  input.on('error', (err) => {
    log(`stdin error: ${/** @type {Error} */ (err).message}`);
    tail.then(() => resolveDone());
  });

  return done;
}
