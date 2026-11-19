import { AgentSessions } from './acp.mjs';
import { defaultSearchDirs, findFirstExecutable, KNOWN_AGENTS } from './probe.mjs';

/** Local programs with a stdio ACP entry point. No installation or login on discovery. */
export const LOCAL_ACP = [
  { id: 'claude-code', adapter: 'claude-agent-acp', args: [] },
  { id: 'cursor-agent', args: ['acp'] },
  { id: 'opencode', args: ['acp'] },
  { id: 'copilot', args: ['--acp'] },
  { id: 'gemini-cli', args: ['--acp'] },
  { id: 'codebuddy', args: ['--acp'] },
  { id: 'qwen', args: ['--acp'] },
  { id: 'kimi', args: ['acp'] },
  { id: 'minimax', args: ['acp'] },
  { id: 'deepseek', args: ['--profile', 'acp'] },
  { id: 'antigravity', args: ['acp'] },
];

/** @param {typeof LOCAL_ACP[number]} entry @param {Parameters<typeof import('./codex-acp.mjs').createCodexAcpSessions>[0]} options */
export async function openLocalAcp(entry, options) {
  const definition = KNOWN_AGENTS.find((item) => item.id === entry.id);
  const dirs = defaultSearchDirs();
  const program = await findFirstExecutable(definition?.commands ?? [], dirs);
  const command = entry.adapter ? await findFirstExecutable([entry.adapter], dirs) : program;
  if (!program || !command) throw Object.assign(new Error('未找到本机连接组件'), { code: program ? 'ADAPTER_NOT_INSTALLED' : 'AGENT_NOT_INSTALLED' });
  const sessions = new AgentSessions({
    ...options, command, args: entry.args,
    extraEnv: entry.id === 'claude-code' ? { CLAUDE_CODE_EXECUTABLE: program } : {},
  });
  return { sessions, adapter: { path: command, version: 'ACP' }, codex: { path: program } };
}
