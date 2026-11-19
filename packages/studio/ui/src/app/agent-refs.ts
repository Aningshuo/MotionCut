/**
 * Agent 引用清单（R118 · L5 · 验收 LI-A35）。
 *
 * ## 为什么单独一个纯模块
 *
 * `@` 菜单原来只列「工程 / 当前会话 / 草稿片段」三样，理由写在面板里：不列还没接的
 * 东西（列了就是假入口）。这一批把「所选元素 / 片段 / 素材 / 文件 / Skill」真的接上，
 * 对象一多，就地拼菜单会有三个后果：同一目标出现两次、跨工程的旧选中被当成当前目标、
 * 空清单与「加载失败」长得一样。所以候选的**拼装规则**全部放这里，面板只负责取数与画。
 *
 * ## 诚实口径（与本产品其它地方同一条）
 *
 * 1. **只列真的存在的东西**：素材来自 `GET /projects/:id/assets`，文件来自工程文档里
 *    片段真的引用到的相对路径，Skill 来自名册里服务端真读到的目录；一条都没有就
 *    **明说一条都没有**，不摆灰行假装「即将支持」。
 * 2. **引用 ≠ 导入轨道**：清单只是「本轮对话提到它」，不复制文件、不插入片段。
 *    进时间线仍然只有 `+` →「上传素材」那一条路。
 * 3. **引用 ≠ 上传**：本版 provider 不读附件内容，所以面板从不假装模型看过这些文件。
 *
 * 身份（`identity`）是**机器读的那一份**：元素是 `<clipId>::<elementKey>`，素材是
 * `assets/x.png`，文件是相对路径。标签（`label`）是给人看的那一份。两者分开写，
 * 免得「改个显示文案」把去重键改掉（那是串台类缺陷的经典来源）。
 */

export type RefKind = 'project' | 'session' | 'element' | 'clip' | 'asset' | 'file' | 'skill';

/** 顺序 = 菜单顺序：越靠近「我现在手上这个」的越靠前。 */
export const REF_KINDS: readonly RefKind[] = ['project', 'session', 'element', 'clip', 'asset', 'file', 'skill'];

/** 每一类最多列几行（菜单有高度上限；真要被截断就在末行说「还有 N 条」）。 */
export const REF_LIMITS = Object.freeze({ element: 1, clip: 12, asset: 20, file: 20, skill: 20 });

/** 类别短名（菜单右侧那个小签）：短到 232px 列宽下不换行。 */
export const REF_KIND_LABEL: Record<RefKind, string> = {
  project: '工程',
  session: '会话',
  element: '元素',
  clip: '片段',
  asset: '素材',
  file: '文件',
  skill: 'Skill',
};

export interface RefTarget {
  /** 去重键：`<kind>:<identity>`。同一个目标点两次只留一条。 */
  id: string;
  kind: RefKind;
  /** 给人看的一行（含目标身份）。 */
  label: string;
  /** 机器认的身份（不含前缀）。 */
  identity: string;
  /** tooltip：来源 + 这条引用**不会**做什么。 */
  title: string;
}

export interface RefSourceAsset {
  name: string;
  path: string;
  kind: string;
}

export interface RefInputs {
  projectId: string;
  projectName: string;
  session: { id: string; title: string } | null;
  /** 当前所选目标（**已经过工程校验**，见 `selectionFromDebug`）。 */
  selection: { clipId: string; elementKey: string } | null;
  /** 草稿声明要改的片段（`draft.scope`）。 */
  scopeClips: readonly string[];
  assets: readonly RefSourceAsset[];
  /** 工程里被片段引用到的文件（相对路径，去重后）。 */
  files: readonly string[];
  /** 服务端名册里真读到的 Skill 名。 */
  skills: readonly string[];
  limits?: Partial<typeof REF_LIMITS>;
}

/** 引用 id：`kind:identity`。空 identity 不造 id（否则会拼出 `clip:` 这种半条）。 */
export function refIdOf(kind: RefKind, identity: string): string {
  return identity === '' ? '' : `${kind}:${identity}`;
}

function rowOf(kind: RefKind, label: string, identity: string, title: string): RefTarget {
  return { id: refIdOf(kind, identity), kind, label, identity, title };
}

/**
 * 拼候选。顺序：工程 → 会话 → 元素 → 片段 → 素材 → 文件 → Skill。
 *
 * 去重按 `id`（先出现的那条留着）：同一个片段既是「所选片段」又在草稿 scope 里时
 * 只出现一次，而且留在「片段」段第一个 —— 它正是当前手上那一个。
 */
export function collectRefs(input: RefInputs): RefTarget[] {
  const limits = { ...REF_LIMITS, ...(input.limits ?? {}) };
  const out: RefTarget[] = [];
  const seen = new Set<string>();
  const push = (row: RefTarget): void => {
    if (row.id === '' || seen.has(row.id)) return;
    seen.add(row.id);
    out.push(row);
  };

  if (input.projectId !== '') {
    const name = input.projectName === '' ? input.projectId : input.projectName;
    push(rowOf('project', `工程 · ${name}`, input.projectId, '引用当前工程（只做提示，不导入轨道）'));
  }
  if (input.session !== null && input.session.id !== '') {
    const title = input.session.title === '' ? '未命名会话' : input.session.title;
    push(rowOf('session', `会话 · ${title}`, input.session.id, '引用当前会话（历史只读；回合记在这条会话上）'));
  }
  if (input.selection !== null && input.selection.elementKey !== '') {
    const { clipId, elementKey } = input.selection;
    /* 元素的身份必须带片段：同一帧被两个片段引用时，只写元素串会落到错的那条上。 */
    const identity = clipId === '' ? elementKey : `${clipId}::${elementKey}`;
    push(
      rowOf(
        'element',
        `元素 · ${elementKey}${clipId === '' ? '' : ` @ ${clipId}`}`,
        identity,
        '引用当前所选元素（片段 + 元素定位串；只做提示，不改画面）',
      ),
    );
  }
  const clips: string[] = [];
  if (input.selection !== null && input.selection.clipId !== '') clips.push(input.selection.clipId);
  for (const id of input.scopeClips) if (id !== '') clips.push(id);
  for (const id of clips.slice(0, limits.clip)) {
    push(rowOf('clip', `片段 · ${id}`, id, '引用时间线上的片段（只做提示，不插入/不改动它）'));
  }
  for (const asset of input.assets.slice(0, limits.asset)) {
    const rel = asset.path === '' ? asset.name : asset.path;
    const size = asset.kind === '' ? '' : `（${asset.kind}）`;
    push(rowOf('asset', `素材 · ${asset.name}${size}`, rel, `引用素材库里的 ${rel}（不上传、不插入轨道）`));
  }
  for (const file of input.files.slice(0, limits.file)) {
    push(rowOf('file', `文件 · ${file}`, file, `引用工程内的 ${file}（只做提示；本轮 provider 不读文件内容）`));
  }
  for (const skill of input.skills.slice(0, limits.skill)) {
    push(rowOf('skill', `Skill · ${skill}`, skill, '引用已安装的 Skill（只做提示；本版不执行 Skill）'));
  }
  return out;
}

/** 被上限截掉的条数（菜单末行要说「还有 N 条」，不能默默少一半）。 */
export function refOverflowOf(input: RefInputs): number {
  const limits = { ...REF_LIMITS, ...(input.limits ?? {}) };
  const clipExtra = Math.max(0, input.scopeClips.length - limits.clip);
  return (
    clipExtra +
    Math.max(0, input.assets.length - limits.asset) +
    Math.max(0, input.files.length - limits.file) +
    Math.max(0, input.skills.length - limits.skill)
  );
}

/** 加一条（幂等）。返回**新数组**，调用方直接 setState。 */
export function addRef(rows: readonly RefTarget[], row: RefTarget): RefTarget[] {
  if (row.id === '' || rows.some((item) => item.id === row.id)) return [...rows];
  return [...rows, row];
}

/** 移除一条（按 id）。 */
export function removeRef(rows: readonly RefTarget[], id: string): RefTarget[] {
  return rows.filter((item) => item.id !== id);
}

/**
 * 从 App 写的调试出口读「当前所选目标」，并做**工程校验**。
 *
 * 为什么读这个全局：`App.tsx` 归 MAIN，本批不抢那一行；这份 `__selectedTarget` 是
 * App 唯一写入点 `writeTarget()` 落下的**同一份**目标（s208 量具也从这里读），字段
 * 与 `selected-target.ts` 的 `SelectedTarget` 逐字对齐。等 MAIN 把 prop 接进来，
 * 这里换成一个可选 prop 即可，规则不动。
 *
 * 工程不匹配 → 一律当没有选中（跨工程引用比不引用坏得多）。
 */
export function selectionFromDebug(
  raw: unknown,
  projectId: string,
): { clipId: string; elementKey: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const owner = typeof item.projectId === 'string' ? item.projectId : '';
  if (projectId === '' || owner !== projectId) return null;
  const clipId = typeof item.clipId === 'string' ? item.clipId : '';
  const elementKey = typeof item.elementKey === 'string' ? item.elementKey : '';
  if (clipId === '' && elementKey === '') return null;
  return { clipId, elementKey };
}

/**
 * 文档 → 「工程内被引用到的文件」清单（`clip.src` 去 `#t=` 与开头的 `./`，去重保序）。
 *
 * 只取相对路径：绝对路径/URL 不列（引用一条 http 地址既不是「工程文件」，
 * 也会把外部依赖说成项目内容）。
 */
export function filesOfDoc(doc: unknown): string[] {
  const tracks = (doc as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(tracks)) return [];
  const out: string[] = [];
  for (const track of tracks) {
    const clips = (track as { clips?: unknown } | null)?.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      const src = (clip as { src?: unknown } | null)?.src;
      if (typeof src !== 'string' || src === '') continue;
      const bare = (src.split('#')[0] ?? '').replace(/^\.\//, '');
      if (bare === '' || /^[a-z]+:\/\//i.test(bare) || bare.startsWith('/')) continue;
      if (!out.includes(bare)) out.push(bare);
    }
  }
  return out;
}
