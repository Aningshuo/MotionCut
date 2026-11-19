/** @typedef {{ id: string, label: string, default: boolean, thinking: {id:string,label:string}[], speed: never[], wireIds: Record<string,string>, configId?:string }} AcpModel */

/** The Codex ACP bridge advertises exact wire IDs, including the effort where supported.
 * Keep those IDs for the request and expose the model and effort separately to the UI.
 * @param {any} session
 */
export function acpModelCatalog(session) {
  /** @type {Map<string, AcpModel>} */
  const models = new Map();
  const current = session?.models?.currentModelId;
  const entries = [...(session?.models?.availableModels ?? [])];
  // Custom configurations can open a real session with a model outside the public picker.
  if (typeof current === 'string' && current && !entries.some((item) => (item?.modelId ?? item?.id) === current)) {
    entries.push({ modelId: current });
  }
  for (const item of entries) {
    const wire = item?.modelId ?? item?.id;
    if (typeof wire !== 'string' || !wire) continue;
    const variant = /^(.+)\[([^\]]+)\]$/.exec(wire);
    const id = variant?.[1] ?? wire;
    const effort = variant?.[2] ?? '';
    const label = typeof item.name === 'string' ? item.name.replace(/\s*\([^()]*\)$/, '') : id;
    /** @type {AcpModel} */
    const model = models.get(id) ?? { id, label, default: false, thinking: [], speed: [], wireIds: Object.create(null) };
    if (Object.hasOwn(model.wireIds, effort)) continue;
    model.wireIds[effort] = wire;
    if (effort) {
      const option = { id: effort, label: effort };
      if (wire === current) model.thinking.unshift(option);
      else model.thinking.push(option);
    }
    model.default ||= wire === current;
    models.set(id, model);
  }
  const config = session?.configOptions?.find((/** @type {any} */ item) => item.category === 'model');
  const options = (config?.options ?? []).flatMap((/** @type {any} */ item) => Array.isArray(item.options) ? item.options : [item]);
  for (const option of options) {
    if (typeof option.value !== 'string') continue;
    const model = models.get(option.value);
    if (model && typeof option.name === 'string') model.label = option.name;
    if (!model && typeof config.id === 'string' && option.value) {
      models.set(option.value, { id: option.value, label: option.name || option.value,
        default: option.value === config.currentValue, thinking: [], speed: [], wireIds: { '': option.value }, configId: config.id });
    }
  }
  return [...models.values()].sort((left, right) => Number(right.default) - Number(left.default));
}
