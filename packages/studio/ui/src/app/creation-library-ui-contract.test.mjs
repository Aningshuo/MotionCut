// @ts-nocheck -- Execute the actual TS handler declarations in an owned VM, without loading CSS or a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const { libraryActionTarget, libraryPreviewKind, safeLibraryPreviewUrl } = await import(new URL('./creation-library-types.ts', import.meta.url).href);

const library = ts.createSourceFile('creation-library.tsx', await fs.readFile(new URL('./creation-library.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const agent = ts.createSourceFile('agent-panel.ts', await fs.readFile(new URL('./agent-panel.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function find(ast, match) { let found; const visit = node => { if (!found && match(node)) found = node; if (!found) ts.forEachChild(node, visit); }; visit(ast); assert.ok(found, 'actual source declaration must exist'); return found; }
function context(globals = {}) { return vm.createContext({ exports: {}, ...globals }); }
function loadFunction(ast, name, sandbox) {
  const node = find(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(`${js}\nglobalThis.__tested = ${name};`, sandbox);
  return sandbox.__tested;
}
function loadInsert(sandbox) {
  const node = find(agent, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'insert' && ts.isArrowFunction(node.initializer));
  const js = ts.transpileModule(`globalThis.__tested = ${node.initializer.getText(agent)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(js, sandbox); return sandbox.__tested;
}
const own = value => JSON.parse(JSON.stringify(value));
function agentFixture(prompt = '') {
  const calls = { prompts: [], notices: [], errors: [], events: [], sends: 0 };
  const sandbox = context({ props: { projectId: 'p1' }, promptForInsert: { current: prompt },
    setPrompt: next => calls.prompts.push(next), setNotice: text => calls.notices.push(text), setError: value => calls.errors.push(typeof value === 'function' ? value(null) : value),
    window: { dispatchEvent: event => calls.events.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    fetch: () => { calls.sends++; throw new Error('insertion must not contact a provider'); },
  });
  sandbox.prepareLibraryPromptInsertion = loadFunction(agent, 'prepareLibraryPromptInsertion', sandbox);
  return { calls, sandbox, insert: loadInsert(sandbox) };
}

test('selected-text save request contains only the frozen real clip target, never the picked catalog card', () => {
  const build = loadFunction(library, 'selectedTextSaveRequest', context());
  const result = own(build(['edited-clip'], ' 改过的文字 '));
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { action: 'resource.save', name: '改过的文字', params: { category: 'text' }, target: { clipId: 'edited-clip', selectedClipIds: ['edited-clip'] } });
  assert.equal('itemId' in result.request, false); assert.equal('itemIds' in result.request, false);
  assert.equal(build([], '名称').ok, false); assert.equal(build(['a', 'b'], '名称').ok, false); assert.equal(build(['a'], ' ').ok, false);
});

test('the actual open/save handlers freeze the clicked clip even if timeline and catalog selections later change', async () => {
  const state = { dialog: null, name: '', requests: [], notices: [] };
  const sandbox = context({ props: { selectedClipIds: ['clicked-edited-clip'] }, picked: { id: 'builtin:text-basic' }, selected: ['builtin:text-basic'], category: 'text', dialogFolder: '',
    setMenu: () => {}, setDialog: value => { state.dialog = value; sandbox.dialog = value; }, setDialogName: value => { state.name = value; sandbox.dialogName = value; }, setDialogFolder: value => { sandbox.dialogFolder = value; }, setNotice: value => state.notices.push(value),
    request: async request => { state.requests.push(own(request)); return { ok: true }; },
  });
  sandbox.selectedTextSaveRequest = loadFunction(library, 'selectedTextSaveRequest', sandbox);
  loadFunction(library, 'openSelectedTextSave', sandbox)();
  assert.equal(state.dialog.clipId, 'clicked-edited-clip'); assert.equal(state.dialog.item, undefined);
  sandbox.props.selectedClipIds = ['later-selection']; sandbox.picked = { id: 'builtin:text-outline' };
  sandbox.dialogName = '编辑后的当前外观';
  await loadFunction(library, 'submitEdit', sandbox)({ preventDefault() {} });
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0].target.clipId, 'clicked-edited-clip');
  assert.equal('itemId' in state.requests[0], false); assert.equal(state.dialog, null);
});

test('ordinary right-click resource save still uses its actual resource and does not borrow timeline clip identity', async () => {
  const sent = []; const sandbox = context({ dialog: { action: 'resource.save', item: { id: 'builtin:text-basic' } }, dialogName: '模板副本', dialogFolder: '', selected: ['builtin:text-basic'], category: 'text',
    request: async request => { sent.push(own(request)); return { ok: true }; }, setDialog: () => {}, setNotice: () => {},
  });
  sandbox.selectedTextSaveRequest = loadFunction(library, 'selectedTextSaveRequest', sandbox);
  await loadFunction(library, 'submitEdit', sandbox)({ preventDefault() {} });
  assert.equal(sent[0].itemId, 'builtin:text-basic'); assert.equal('target' in sent[0], false);
});

test('the real AgentPanel insertion handler visibly rejects a 256KB skill and preserves the draft', () => {
  const { calls, sandbox, insert } = agentFixture('已有草稿');
  insert({ detail: { projectId: 'p1', text: 'x'.repeat(256 * 1024) } });
  assert.equal(calls.prompts.length, 0); assert.equal(sandbox.promptForInsert.current, '已有草稿');
  assert.equal(calls.errors[0].view.code, 'PROMPT_INSERT_TOO_LONG');
  assert.match(calls.notices[0], /16,000/); assert.match(calls.notices[0], /未执行/);
  assert.equal(calls.events[0].type, 'opencut:agent-prompt-insert-result'); assert.equal(calls.events[0].detail.ok, false);
  assert.equal(calls.sends, 0);
});

test('combined skill plus existing draft is checked, including the inserted separator', () => {
  const { calls, sandbox, insert } = agentFixture('abc');
  insert({ detail: { projectId: 'p1', text: 'x'.repeat(15997) } });
  assert.equal(calls.prompts.length, 0); assert.equal(sandbox.promptForInsert.current, 'abc');
  assert.match(calls.notices[0], /已有草稿/); assert.equal(calls.events[0].detail.ok, false);
});

test('valid skill insertion appends once, acknowledges it and never automatically sends', () => {
  const { calls, sandbox, insert } = agentFixture('draft');
  insert({ detail: { projectId: 'p1', text: 'skill one' } }); insert({ detail: { projectId: 'p1', text: 'skill two' } });
  assert.deepEqual(calls.prompts, ['draft\nskill one', 'draft\nskill one\nskill two']);
  assert.equal(sandbox.promptForInsert.current, calls.prompts[1]);
  assert.equal(calls.events.length, 2); assert.ok(calls.events.every(event => event.detail.ok)); assert.equal(calls.sends, 0);
  assert.match(calls.notices[1], /确认内容后再发送/);
});

test('wrong-project events cannot alter or acknowledge the current composer', () => {
  const { calls, insert } = agentFixture('draft'); insert({ detail: { projectId: 'other', text: 'skill' } });
  assert.deepEqual(calls.prompts, []); assert.deepEqual(calls.notices, []); assert.deepEqual(calls.events, []);
});

test('library and composer agree on the 16000 boundary and empty skills cannot look successful', () => {
  const validate = loadFunction(library, 'skillPromptInsertionError', context());
  const prepare = loadFunction(agent, 'prepareLibraryPromptInsertion', context());
  assert.equal(validate('x'.repeat(16000)), ''); assert.equal(prepare('', { projectId: 'p', text: 'x'.repeat(16000) }, 'p').ok, true);
  assert.notEqual(validate('x'.repeat(16001)), ''); assert.equal(prepare('', { projectId: 'p', text: 'x'.repeat(16001) }, 'p').ok, false);
  assert.notEqual(validate(undefined), ''); assert.notEqual(validate(' '), '');
});

test('the actual library request rejects an oversized successful backend response instead of showing success', async () => {
  const notices = []; const sandbox = context({ projectId: 'p1', snapshot: { sourceHash: 'a'.repeat(64) }, mounted: { current: true }, activeProject: { current: 'p1' }, skillInsertionFeedback: { current: null }, awaitingSkillInsertion: { current: false },
    props: { playhead: 0, selectedClipIds: [], onAction: async () => ({ ok: true, message: '已准备', agentPrompt: 'x'.repeat(17000) }) },
    setRequesting: () => {}, setNotice: value => notices.push(own(value)), libraryActionTarget,
  });
  sandbox.skillPromptInsertionError = loadFunction(library, 'skillPromptInsertionError', sandbox);
  const result = await loadFunction(library, 'request', sandbox)({ action: 'skill.use', itemId: 'skill:large' });
  assert.equal(result.ok, false); assert.equal(notices.at(-1).error, true); assert.match(notices.at(-1).text, /未执行/);
});

test('an AgentPanel insertion error received during refresh cannot be overwritten by a later backend success', async () => {
  const notices = []; const feedback = { current: null };
  const sandbox = context({ projectId: 'p1', snapshot: { sourceHash: 'a'.repeat(64) }, mounted: { current: true }, activeProject: { current: 'p1' }, skillInsertionFeedback: feedback, awaitingSkillInsertion: { current: false },
    props: { playhead: 0, selectedClipIds: [], onAction: async () => { feedback.current = { ok: false, code: 'PROMPT_INSERT_TOO_LONG', message: '草稿与技能合计超限，未发送' }; return { ok: true, message: '已准备', agentPrompt: 'small skill' }; } },
    setRequesting: () => {}, setNotice: value => notices.push(own(value)), libraryActionTarget,
  });
  sandbox.skillPromptInsertionError = loadFunction(library, 'skillPromptInsertionError', sandbox);
  const result = await loadFunction(library, 'request', sandbox)({ action: 'skill.use', itemId: 'skill:valid-but-draft-full' });
  assert.equal(result.ok, false); assert.equal(result.code, 'PROMPT_INSERT_TOO_LONG'); assert.equal(notices.at(-1).error, true); assert.match(notices.at(-1).text, /未发送/);
});

test('a previous project skill request finishing cannot clear the new project insertion wait state', async () => {
  let finish; const awaiting = { current: false }; const active = { current: 'p1' }; const notices = [];
  const sandbox = context({ projectId: 'p1', snapshot: { sourceHash: 'a'.repeat(64) }, mounted: { current: true }, activeProject: active, skillInsertionFeedback: { current: null }, awaitingSkillInsertion: awaiting,
    props: { playhead: 0, selectedClipIds: [], onAction: () => new Promise(resolve => { finish = resolve; }) },
    setRequesting: () => {}, setNotice: value => notices.push(own(value)), libraryActionTarget,
  });
  sandbox.skillPromptInsertionError = loadFunction(library, 'skillPromptInsertionError', sandbox);
  const pending = loadFunction(library, 'request', sandbox)({ action: 'skill.use', itemId: 'skill:old-project' });
  active.current = 'p2'; awaiting.current = true;
  finish({ ok: true, agentPrompt: 'valid skill' }); await pending;
  assert.equal(awaiting.current, true); assert.equal(notices.length, 1); // The first request may clear its own initial notice only.
});

test('Artwork thumbnails keep native img dragging available for the parent card handler', () => {
  const sandbox = context({ useState: () => [false, () => {}], useEffect: () => {},
    libraryPreviewKind: item => item.mediaKind === 'still' ? 'image' : 'video', safeLibraryPreviewUrl: value => value,
    h: (tag, props) => ({ tag, props }),
  });
  const artwork = loadFunction(library, 'Artwork', sandbox);
  const thumbnail = artwork({ item: { id: 'video', name: 'Video', thumbUrl: '/thumb.png' } });
  const image = artwork({ item: { id: 'image', name: 'Image', mediaKind: 'still', previewUrl: '/still.png' } });
  assert.equal(thumbnail.tag, 'img'); assert.notEqual(thumbnail.props.draggable, false);
  assert.equal(image.tag, 'img'); assert.notEqual(image.props.draggable, false);
});

function previewFixture(item) {
  const states = []; const refs = []; const effects = []; const frames = new Map(); const calls = { messages: [], applies: 0, requests: 0, cancelled: [] };
  let stateIndex = 0; let refIndex = 0; let effectIndex = 0; let pending = []; let serial = 0; let now = 0;
  const host = { postMessage: (value, origin) => calls.messages.push({ value: own(value), origin }) };
  Object.defineProperty(host, 'film', { get() { throw new Error('opaque preview must never read child.film'); } });
  const sandbox = context({ URL, window: { location: { href: 'http://127.0.0.1:1234/studio/' } }, performance: { now: () => now }, libraryPreviewKind, safeLibraryPreviewUrl,
    useState: initial => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: initial => { const index = refIndex++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
    useEffect: (callback, deps) => { const index = effectIndex++; const before = effects[index]; if (!before || deps.some((value, i) => !Object.is(value, before.deps[i]))) { effects[index] = { deps, cleanup: before?.cleanup }; pending.push(() => { effects[index].cleanup?.(); effects[index].cleanup = callback(); }); } },
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; }, cancelAnimationFrame: id => { calls.cancelled.push(id); frames.delete(id); },
    h: (tag, props, ...children) => { if (tag === 'iframe' && props?.ref) props.ref.current = { contentWindow: host }; return { tag, props: props || {}, children: children.flat(Infinity) }; },
    iconButton: (label, glyph, onClick, options) => ({ tag: 'button', props: { 'aria-label': label, onClick, ...options }, children: [] }), editorIcon: () => null,
    fetch: () => { calls.requests++; throw new Error('preview controls must not call the server'); },
  });
  const component = loadFunction(library, 'PreviewContent', sandbox);
  const fixture = { calls, item, tree: null,
    render() { stateIndex = 0; refIndex = 0; effectIndex = 0; pending = []; this.tree = component({ item: this.item, disabled: false, onApply: () => { calls.applies++; } }); const work = [...pending]; for (const effect of work) effect(); return this.tree; },
    find(test) { const walk = node => { if (!node || typeof node !== 'object') return null; if (test(node)) return node; for (const child of node.children || []) { const found = walk(child); if (found) return found; } return null; }; return walk(this.tree); },
    advance(time) { now = time; const work = [...frames.values()]; frames.clear(); for (const callback of work) callback(now); this.render(); },
    dispose() { for (const effect of effects) effect.cleanup?.(); },
  }; fixture.render(); return fixture;
}

test('actual page preview requests motion host and sends initial load/play/seek controls without applying the resource', () => {
  const ui = previewFixture({ id: 'scene', name: 'Scene', category: 'template', kind: 'page', mediaKind: 'page', previewUrl: '/scene.html?preview=thumbnail&token=opaque#scene', durationSec: 4 });
  let iframe = ui.find(node => node.tag === 'iframe'); const source = new URL(iframe.props.src);
  assert.equal(source.searchParams.get('preview'), 'motion'); assert.equal(source.searchParams.getAll('preview').length, 1); assert.equal(source.hash, '#scene');
  assert.equal(iframe.props.sandbox, 'allow-scripts'); assert.equal(iframe.props.sandbox.includes('allow-same-origin'), false);
  assert.deepEqual(ui.calls.messages[0], { value: { type: 'opencut:resource-preview-control', playing: true, time: 0, duration: 4 }, origin: '*' });
  const beforeLoad = ui.calls.messages.length; iframe.props.onLoad(); assert.equal(ui.calls.messages.length, beforeLoad + 1);
  ui.find(node => node.props['aria-label'] === '暂停预览').props.onClick(); ui.render(); assert.equal(ui.calls.messages.at(-1).value.playing, false);
  ui.find(node => node.tag === 'input' && node.props.type === 'range').props.onChange({ currentTarget: { value: '2.25' } }); ui.render();
  assert.deepEqual(ui.calls.messages.at(-1).value, { type: 'opencut:resource-preview-control', playing: false, time: 2.25, duration: 4 });
  assert.equal(ui.find(node => node.tag === 'input').props.value, 2.25); assert.equal(ui.calls.applies, 0); assert.equal(ui.calls.requests, 0);
  ui.dispose();
});

test('preview local clock updates the time/range and loops without posting every animation frame', () => {
  const ui = previewFixture({ id: 'transition', name: 'Transition', category: 'transition', kind: 'page', previewUrl: '/transition.html', durationSec: 2 });
  const initial = ui.calls.messages.length; ui.advance(750);
  assert.equal(ui.find(node => node.tag === 'input').props.value, 0.75); assert.equal(ui.calls.messages.length, initial);
  ui.advance(2250); assert.equal(ui.find(node => node.tag === 'input').props.value, 0.25); assert.equal(ui.calls.messages.length, initial);
  ui.find(node => node.props['aria-label'] === '暂停预览').props.onClick(); ui.render();
  assert.equal(ui.calls.messages.at(-1).value.time, 0.25); const paused = ui.calls.messages.length;
  ui.advance(3250); assert.equal(ui.find(node => node.tag === 'input').props.value, 0.25); assert.equal(ui.calls.messages.length, paused);
  assert.ok(ui.calls.cancelled.length > 0); ui.dispose();
});

test('page preview invalid duration uses two seconds, seeks clamp, and failed preview removes its controls', () => {
  const ui = previewFixture({ id: 'scene', name: 'Scene', category: 'template', kind: 'page', previewUrl: '/scene.html', durationSec: NaN });
  const range = ui.find(node => node.tag === 'input'); assert.equal(range.props.max, 2);
  range.props.onChange({ currentTarget: { value: '99' } }); ui.render(); assert.equal(ui.calls.messages.at(-1).value.time, 2);
  ui.find(node => node.tag === 'input').props.onChange({ currentTarget: { value: '-5' } }); ui.render(); assert.equal(ui.calls.messages.at(-1).value.time, 0);
  ui.find(node => node.tag === 'iframe').props.onError(); ui.render();
  assert.equal(ui.find(node => node.tag === 'input'), null); assert.ok(ui.find(node => node.props.role === 'alert')); ui.dispose();
});

test('ordinary video and audio previews retain native controls and do not acquire page control messages', () => {
  for (const [mediaKind, tag] of [['video', 'video'], ['sound', 'audio']]) {
    const ui = previewFixture({ id: tag, name: tag, category: 'media', mediaKind, kind: mediaKind, previewUrl: '/source.' + (tag === 'video' ? 'mp4' : 'wav') });
    assert.equal(ui.find(node => node.tag === tag).props.controls, true); assert.equal(ui.find(node => node.tag === 'input'), null);
    assert.equal(ui.calls.messages.length, 0); assert.equal(ui.calls.requests, 0); assert.equal(ui.calls.applies, 0); ui.dispose();
  }
});

test('a successfully imported HTML scene becomes visible and selected in the media pane, with no automatic timeline apply', async () => {
  const calls = { actions: [], categories: [], selected: [] };
  const sandbox = context({ projectId: 'one', activeProject: { current: 'one' }, snapshot: {}, props: { selectedClipIds: [] }, setNotice: () => {},
    request: async value => { calls.actions.push(own(value)); return { ok: true, itemId: 'project:scenes/new/scene.html' }; },
    changeCategory: value => calls.categories.push(value), setSelected: value => calls.selected.push(own(value)),
  });
  await loadFunction(library, 'importTextFile', sandbox)({ name: 'new.html', text: async () => '<html></html>' }, 'page');
  assert.deepEqual(calls.categories, ['media']); assert.deepEqual(calls.selected, [['project:scenes/new/scene.html']]);
  assert.deepEqual(calls.actions.map(x => x.action), ['resource.import-page']);
});

function ordinaryImportFixture(onImport) {
  const calls = { imports: [], notices: [], requests: 0 };
  const state = { category: 'template', scope: 'folder:old', selected: ['previous-card'], anchor: 'previous-card', query: 'old-query', mediaKind: 'video', menu: {}, requesting: false };
  const globals = { projectId: 'one', mounted: { current: true }, activeProject: { current: 'one' },
    props: { onImport: async files => { calls.imports.push(files); await onImport(); }, onLayerCategory: () => { throw new Error('import must not activate layers'); } },
    setCategory: x => { state.category = x; }, setScope: x => { state.scope = x; }, setSelected: x => { state.selected = own(x); }, setAnchor: x => { state.anchor = x; }, setQuery: x => { state.query = x; }, setMediaKind: x => { state.mediaKind = x; }, setMenu: x => { state.menu = x; }, setRequesting: x => { state.requesting = x; }, setNotice: x => { calls.notices.push(own(x)); },
    fetch: () => { calls.requests++; throw new Error('import view selection must not apply a resource'); },
  };
  const sandbox = context(globals); sandbox.changeCategory = loadFunction(library, 'changeCategory', sandbox);
  return { state, calls, sandbox, importFiles: loadFunction(library, 'importFiles', sandbox) };
}

test('normal file picker/drop import success reveals the media pool and clears filters without inventing returned resource identities', async () => {
  const f = ordinaryImportFixture(async () => {}), files = [{ name: 'source.mp4' }, { name: 'card.html' }];
  await f.importFiles(files);
  assert.equal(f.calls.imports.length, 1); assert.equal(f.calls.imports[0], files);
  assert.deepEqual(f.state, { category: 'media', scope: 'all', selected: [], anchor: '', query: '', mediaKind: 'all', menu: null, requesting: false });
  assert.deepEqual(f.calls.notices.at(-1), { error: false, text: '已导入 2 个文件' }); assert.equal(f.calls.requests, 0);
});

test('normal import failure retains the current pane/filter/selection and reports failure; empty input is a no-op', async () => {
  const f = ordinaryImportFixture(async () => { throw new Error('fixture-import-failed'); });
  await f.importFiles([{ name: 'bad.mp4' }]);
  assert.equal(f.state.category, 'template'); assert.equal(f.state.scope, 'folder:old'); assert.deepEqual(f.state.selected, ['previous-card']); assert.equal(f.state.query, 'old-query'); assert.equal(f.state.mediaKind, 'video'); assert.equal(f.state.requesting, false);
  assert.equal(f.calls.notices.at(-1).error, true); assert.equal(f.calls.requests, 0);
  const before = JSON.stringify({ state: f.state, calls: f.calls }); await f.importFiles([]); assert.equal(JSON.stringify({ state: f.state, calls: f.calls }), before);
});

test('old-project or unmounted import completion cannot navigate or update a new pane on success or failure', async () => {
  for (const moved of ['project', 'unmount']) for (const fail of [false, true]) {
    let finish; const gate = new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('old-project-failure')) : resolve(); });
    const f = ordinaryImportFixture(() => gate); const pending = f.importFiles([{ name: 'old.mp4' }]);
    if (moved === 'project') f.sandbox.activeProject.current = 'two'; else f.sandbox.mounted.current = false;
    const before = JSON.stringify({ state: f.state, notices: f.calls.notices }); finish(); await pending;
    assert.equal(JSON.stringify({ state: f.state, notices: f.calls.notices }), before, `${moved}/${fail}: no stale state update`); assert.equal(f.calls.requests, 0);
  }
});
