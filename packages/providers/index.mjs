/**
 * `packages/providers` 入口（WP19 BYOK）。
 *
 *   import { createProvider, createKeyStore } from './packages/providers/index.mjs';
 *
 * 参考实现（3e6b217a 快照）**没有** provider/key/model 相关代码，全仓 grep
 * `anthropic` / `openai-responses` / `chat/completions` 零命中；所以这里是我方
 * 自定实现，不对应任何参考文件——交接里也这么写。
 */

export { createProvider, WIRES } from './client.mjs';
export { createKeyStore, fakeKey } from './keys.mjs';
export { ProviderError, codeForStatus, isUnsupportedToolsError } from './errors.mjs';
export { registerSecret, redactText, redactValue, clearSecrets } from './redact.mjs';
export { SseDecoder, isDoneFrame } from './sse.mjs';
export { createLimiter, createDeadline, resolveMaxOutputTokens } from './budget.mjs';
