import assert from 'node:assert/strict';
import test from 'node:test';
import { acpModelCatalog } from '../acp-models.mjs';
import { buildSceneRoster, pickSelection } from '../../studio/server/agent-scene.mjs';

const catalog = acpModelCatalog({
  models: {
    currentModelId: 'configured[high]',
    availableModels: [
      { modelId: 'listed[low]', name: 'Listed (low)' },
      { modelId: 'listed[high]', name: 'Listed (high)' },
    ],
  },
  configOptions: [{ category: 'model', options: [{ value: 'configured', name: 'Configured' }] }],
});

test('a local ACP client can return only grouped model configuration options', () => {
  const models = acpModelCatalog({ configOptions: [{
    id: 'local-model', category: 'model', currentValue: 'edit',
    options: [{ group: 'local', options: [{ value: 'fast', name: 'Fast' }, { value: 'edit', name: 'Edit' }] }],
  }] });
  assert.deepEqual(models.map((m) => [m.id, m.default, m.configId, m.wireIds['']]), [
    ['edit', true, 'local-model', 'edit'], ['fast', false, 'local-model', 'fast'],
  ]);
});

test('config-only current model and every listed effort retain their actual ACP wire IDs', () => {
  assert.deepEqual(catalog.map((item) => [item.id, item.label, item.default]), [
    ['configured', 'Configured', true],
    ['listed', 'Listed', false],
  ]);
  assert.equal(catalog[0]?.wireIds.high, 'configured[high]');
  assert.deepEqual(catalog[1]?.thinking.map((item) => item.id), ['low', 'high']);
  assert.equal(catalog[1]?.wireIds.low, 'listed[low]');
  assert.deepEqual(acpModelCatalog({}), []);
});

test('Codex and the built-in generator cannot execute each other’s models', () => {
  const roster = buildSceneRoster({
    provider: { id: 'mock', mock: true },
    providers: [{ id: 'acp-codex', models: catalog }],
    agents: [{ id: 'codex', available: true }],
    wiredAgents: ['codex'],
  });
  assert.equal(roster.defaults.agent, 'codex');
  assert.equal(roster.defaults.model, 'configured');
  assert.equal(roster.defaults.thinking, 'high');
  const selected = pickSelection({ agent: 'codex', model: 'listed', options: { thinking: 'low' } }, roster);
  assert.equal(selected.provider, 'acp-codex');
  assert.equal(selected.thinking, 'low');
  assert.throws(() => pickSelection({ agent: 'codex', model: 'builtin-scene-v1' }, roster), /没有可用模型/);
  assert.throws(() => pickSelection({ agent: 'local-scene', model: 'listed' }, roster), /没有可用模型/);
});

test('two connected agents sharing a model name route to the selected agent and report its session', () => {
  const roster = buildSceneRoster({
    provider: { id: 'mock', mock: true },
    providers: ['codex', 'opencode'].map((agentId) => ({ id: 'acp-' + agentId, agentId, models: catalog })),
    agents: ['codex', 'opencode'].map((id) => ({ id, available: true })),
    wiredAgents: ['codex', 'opencode'],
    activeConnection: { available: true, agentId: 'opencode', agentName: 'OpenCode', session: true, lastOk: true, models: catalog },
  });
  assert.equal(pickSelection({ agent: 'opencode', model: 'listed', options: { thinking: 'low' } }, roster).provider, 'acp-opencode');
  assert.equal(roster.providerStatus.provider.id, 'acp-opencode');
  assert.equal(roster.providerStatus.connection?.agentName, 'OpenCode');
  assert.deepEqual(roster.providerStatus.agents.wired, ['local-scene', 'codex', 'opencode']);
});
