/**
 * 服务端错误的**原样**呈现（S69/S70 共用）。
 *
 * 约束（任务书 §1.1.2）：`field` 路径与原因必须是**服务端返回的那串字符**，
 * 界面不许自己编。所以这里只做「取字段」和「排版」，不做任何措辞改写，
 * 也不把 `message` 拆开重写。
 *
 * 服务端各接口的错误载荷并不完全一致，这里按已知形状收口：
 * - `PUT /api/settings` → `{ code, field, allowed, message }`（**不含 `reason`**，
 *   `settings-store` 的 `checkMcpServerEntry` 内部有 `reason`，但路由层没转发；
 *   属服务端口径缺口，已在交接记 DEV-R36-1，界面缺省显示 `—` 而不是编一个）。
 * - `/api/agent/scene*` → `{ code, message }`，部分带 `reason`。
 */

import { ApiError } from './api';

export interface ServerErrorView {
  /** HTTP 状态（拿不到就是 0）。 */
  status: number;
  code: string;
  /** 服务端给的字段路径，例如 `mcp.servers[0].name`；没有就是空串。 */
  field: string;
  /** 服务端给的 reason（`NAME_PATTERN`…）；没有就是空串。 */
  reason: string;
  /** 服务端给的原因文本（`message`），逐字保留。 */
  message: string;
  /** 服务端给的允许值（已字符串化），没有就是空数组。 */
  allowed: string[];
}

/** @param {unknown} value */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把任意异常收成可渲染的错误视图；非 ApiError 也给出可读文本。 */
export function viewServerError(error: unknown): ServerErrorView {
  if (error instanceof ApiError) {
    const body = error.body ?? {};
    const allowedRaw = body.allowed;
    const allowed = Array.isArray(allowedRaw)
      ? allowedRaw.map((item) => (typeof item === 'string' ? item : JSON.stringify(item) ?? String(item)))
      : [];
    return {
      status: error.status,
      code: asString(body.code) || error.code,
      field: asString(body.field),
      reason: asString(body.reason),
      message: asString(body.message) || error.message,
      allowed,
    };
  }
  return {
    status: 0,
    code: 'CLIENT',
    field: '',
    reason: '',
    message: error instanceof Error ? error.message : String(error),
    allowed: [],
  };
}

/**
 * 一行摘要：`field · code · message`（缺的段自动省略）。
 * 只用于窄处（按钮旁、toast），完整信息仍由 `ErrorDetail` 逐字显示。
 */
export function summarizeServerError(view: ServerErrorView): string {
  const head = view.field === '' ? view.code : `${view.field} · ${view.code}`;
  return view.message === '' ? head : `${head} · ${view.message}`;
}
