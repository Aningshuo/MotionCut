/**
 * 多序列错误的**人话 + 下一步**（S73）。
 *
 * 分工写死：
 * - 服务端返回的 `code` / `field` / `message` **逐字显示**（`server-error.ts` 负责取字段）；
 * - 这个文件只提供「这句错误对人意味着什么」和「现在该做什么」两句补充，不改写服务端文本。
 *
 * 三条删除拒绝（`SEQUENCE_PROTECTED` / `SEQUENCE_IS_CURRENT` / `SEQUENCE_LAST`）的顺序
 * 与 `packages/studio/server/sequences.mjs` 的判定顺序**无关**：服务端先判 LAST、再判
 * PROTECTED、最后判 IS_CURRENT（只剩一条时删 main 报 LAST）。这里三条都写全，
 * 因为它们对用户是三种不同的处境。
 */

export interface SequenceErrorCopy {
  /** 一句人话（<= 24 字，直接显示在错误块标题下）。 */
  say: string;
  /** 下一步建议（具体动作，不说「请重试」这种空话）。 */
  next: string;
}

const PROTECTED: SequenceErrorCopy = {
  say: 'main 是默认序列，不能删。',
  next: '想缩小工程就删别的序列，或把 main 里的片段删掉——main 本身永远保留。',
};
const IS_CURRENT: SequenceErrorCopy = {
  say: '这条正在编辑，服务端不让删。',
  next: '先切到别的序列，再回来删它。',
};
const LAST: SequenceErrorCopy = {
  say: '这是最后一个序列，删了就再没有东西可打开。',
  next: '至少留一条序列（main）；要清空内容就在序列里删片段。',
};

const COPY: Record<string, SequenceErrorCopy> = Object.freeze({
  SEQUENCE_EXISTS: {
    say: '这个序列名已经有人用了。',
    next: '换一个名字再建（只允许小写字母、数字、- 和 _，2–32 位，字母或数字开头）。',
  },
  SEQUENCE_NAME_INVALID: {
    say: '名字不合规，服务端拒了。',
    next: '按规则改：小写字母或数字开头，只含 a-z 0-9 - _，长度 2–32。',
  },
  SEQUENCE_STAGE_INVALID: {
    say: '画幅不合法。',
    next: '用对话框里的三个预设之一（16:9 / 9:16 / 4:3），宽高都在 1–8192 之间。',
  },
  SEQUENCE_PROTECTED: PROTECTED,
  SEQUENCE_IS_CURRENT: IS_CURRENT,
  SEQUENCE_LAST: LAST,
  SEQUENCE_NOT_FOUND: {
    say: '这条序列已经不在了。',
    next: '刷新一下列表；如果刚被别处删掉，切到 main 继续。',
  },
  SEQUENCES_INDEX_INVALID: {
    say: '工程的多序列索引坏了。',
    next: '先把 .film/sequences.json 备份出来再修；界面这边不要继续写，避免越写越乱。',
  },
  FILM_NOT_FOUND: {
    say: '工程当前没打开（服务端不认这个 id）。',
    next: '在左侧重新打开这个工程，再操作序列。',
  },
});

/** 未知码也给一句话，别把用户丢在裸 code 上。 */
const FALLBACK: SequenceErrorCopy = Object.freeze({
  say: '服务端拒绝了这次操作。',
  next: '看下面的 field / code / message 原文；需要的话把这三行一起发出来。',
});

/** @param {string} code */
export function sequenceErrorCopy(code: string): SequenceErrorCopy {
  return COPY[code] ?? FALLBACK;
}

const RULES: ReadonlyArray<{ code: string; text: string }> = Object.freeze([
  Object.freeze({ code: 'SEQUENCE_PROTECTED', text: PROTECTED.say }),
  Object.freeze({ code: 'SEQUENCE_IS_CURRENT', text: IS_CURRENT.say }),
  Object.freeze({ code: 'SEQUENCE_LAST', text: LAST.say }),
]);

/**
 * 删除对话框里**常驻**的三条规则（不依赖报错就会出现）。
 *
 * 为什么常驻：删除按钮本身只在「非 main、非当前」时出现，所以 `SEQUENCE_PROTECTED`
 * 与 `SEQUENCE_LAST` 这两条在正常操作里**根本点不出来**。不写出来，用户只会看到
 * 「有的行没有删除按钮」而不知道为什么。
 */
export const SEQUENCE_DELETE_RULES = RULES;

/** 新建对话框的画幅预设（与服务端 `stage` 的 {w,h} 一一对应）。 */
export const SEQUENCE_STAGE_PRESETS = Object.freeze([
  Object.freeze({ id: '16x9', label: '16:9 横屏', note: '1920×1080', w: 1920, h: 1080 }),
  Object.freeze({ id: '9x16', label: '9:16 竖屏', note: '1080×1920', w: 1080, h: 1920 }),
  Object.freeze({ id: '4x3', label: '4:3 方屏', note: '1440×1080', w: 1440, h: 1080 }),
]);
