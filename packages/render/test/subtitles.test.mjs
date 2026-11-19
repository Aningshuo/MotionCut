/**
 * P23 字幕：解析 / 时间映射 / ASS 生成 / 字形覆盖。
 *
 * 这些用例全部是纯函数（不碰 ffmpeg、不碰工程），所以能在任何机器上跑。
 * 真正"烧进画面"的验证在 `.local-runs/sub2/runs/R12/evidence/p23-burn.json` 里，
 * 那是抽帧对比出来的，不是单测能替代的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SubtitleError,
  parseSubtitleText,
  parseTimestamp,
  findSidecar,
  mapCuesToTimeline,
  buildAssDocument,
  parseAssDocument,
  formatAssTime,
  formatVttTime,
  buildVttDocument,
  resolveSubtitleStyle,
  resolveSubtitleStyle as resolveStyle,
  resolveAssStyleFields,
  SUBTITLE_STYLE_DEFAULTS,
  parseStyleArg,
  checkGlyphCoverage,
  probeSubtitleBurnSupport,
  subtitleFilterArg,
  detectSubtitleFormat,
} from '../subtitles.mjs';

const VTT = `WEBVTT

1
00:00:02.500 --> 00:00:03.500
第一句
第二行

2
00:00:04.000 --> 00:00:05.000
第二句
`;

test('P23：VTT 解析出 cue 的起止与多行文本', () => {
  const parsed = /** @type {any} */ (parseSubtitleText(VTT, { format: 'vtt', source: 'a.vtt' }));
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0]?.startSec, 2.5);
  assert.equal(parsed.cues[0]?.endSec, 3.5);
  assert.equal(parsed.cues[0]?.text, '第一句\n第二行');
  assert.equal(parsed.cues[0]?.id, '1');
  assert.equal(parsed.empty, false);
});

test('P23：SRT 用逗号毫秒，也能解析', () => {
  const srt = '1\n00:00:01,250 --> 00:00:02,750\nhello\n';
  const parsed = /** @type {any} */ (parseSubtitleText(srt, { format: 'srt' }));
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0]?.startSec, 1.25);
  assert.equal(parsed.cues[0]?.endSec, 2.75);
});

test('P23：缺 WEBVTT 头 / 时间轴坏 / end<=start 都是 SUBTITLE_PARSE_FAILED', () => {
  assert.throws(() => parseSubtitleText('1\n00:00:01.000 --> 00:00:02.000\nx\n', { format: 'vtt' }), (err) => {
    return err instanceof SubtitleError && err.code === 'SUBTITLE_PARSE_FAILED';
  });
  assert.throws(() => parseSubtitleText('WEBVTT\n\n1\n00:00:02.500 -> 00:00:03.500\nx\n'), (err) => {
    return err instanceof SubtitleError && err.code === 'SUBTITLE_PARSE_FAILED';
  });
  assert.throws(() => parseSubtitleText('WEBVTT\n\n1\n00:00:05.000 --> 00:00:04.000\nx\n'), (err) => {
    return err instanceof SubtitleError && err.code === 'SUBTITLE_PARSE_FAILED';
  });
});

test('P23：时间戳越界（分钟 60）要报错，不能悄悄归一', () => {
  assert.throws(() => parseTimestamp('00:60:00.000', 'x.vtt', 3), /SUBTITLE_PARSE_FAILED/);
  assert.equal(parseTimestamp('01:02:03.500'), 3723.5);
  assert.equal(parseTimestamp('02:03.500'), 123.5);
});

test('P23：空 vtt 返回空 cues（是否失败由调用方决定）', () => {
  const parsed = /** @type {any} */ (parseSubtitleText('WEBVTT\n\n'));
  assert.equal(parsed.empty, true);
  assert.equal(parsed.cues.length, 0);
});

test('P23：扩展名决定格式，不猜内容', () => {
  assert.equal(detectSubtitleFormat('a.vtt'), 'vtt');
  assert.equal(detectSubtitleFormat('a.SRT'), 'srt');
  assert.equal(detectSubtitleFormat('a.ass'), null);
});

test('P23：#t=2,6 + at + speed 的映射（这条是 A4/A5 的核心）', () => {
  const sources = [
    {
      path: 'a.vtt',
      format: /** @type {'vtt'} */ ('vtt'),
      clipId: 'take-a',
      src: '/p/a.mp4',
      cues: [
        { index: 1, startSec: 2.5, endSec: 3.5, text: 'one', id: null },
        { index: 2, startSec: 4.0, endSec: 5.0, text: 'two', id: null },
      ],
    },
  ];
  const clips = [
    { id: 'take-a', kind: 'video', src: '/p/a.mp4', at: 0, time: [2, 6], speed: 1, duration: 4 },
  ];
  const mapped = mapCuesToTimeline({ sources, clips, durationSec: 4, fps: 30 });
  assert.equal(mapped.cues.length, 2);
  assert.equal(mapped.cues[0]?.startSec, 0.5);
  assert.equal(mapped.cues[0]?.endSec, 1.5);
  assert.equal(mapped.cues[1]?.startSec, 2);
  assert.equal(mapped.cues[1]?.endSec, 3);

  // speed=2：时间按 2× 压缩
  const fast = mapCuesToTimeline({
    sources,
    clips: [{ id: 'take-a', kind: 'video', src: '/p/a.mp4', at: 0, time: [2, 8], speed: 2, duration: 3 }],
    durationSec: 3,
    fps: 30,
  });
  // 帧对齐向外取整：0.25 → 7/30（floor），0.75 → 23/30（ceil）
  assert.ok(Math.abs((fast.cues[0]?.startSec ?? 0) - 7 / 30) < 1e-9, `start=${fast.cues[0]?.startSec}`);
  assert.ok(Math.abs((fast.cues[0]?.endSec ?? 0) - 23 / 30) < 1e-9, `end=${fast.cues[0]?.endSec}`);
});

test('P23：cue 全在片段窗口外 → 警告但不抛错', () => {
  const sources = [
    {
      path: 'a.vtt',
      format: /** @type {'vtt'} */ ('vtt'),
      clipId: 'take-a',
      src: '/p/a.mp4',
      cues: [{ index: 1, startSec: 20, endSec: 21, text: 'late', id: null }],
    },
  ];
  const mapped = mapCuesToTimeline({
    sources,
    clips: [{ id: 'take-a', kind: 'video', src: '/p/a.mp4', at: 0, time: [2, 6], speed: 1, duration: 4 }],
    durationSec: 4,
    fps: 30,
  });
  assert.equal(mapped.cues.length, 0);
  assert.match(mapped.warnings.join('\n'), /fall outside the clip window/);
});

test('P23：同一条素材被两个片段复用，各算一份', () => {
  const sources = [
    {
      path: 'a.vtt',
      format: /** @type {'vtt'} */ ('vtt'),
      clipId: 'a1',
      src: '/p/a.mp4',
      cues: [{ index: 1, startSec: 0.5, endSec: 1.5, text: 'x', id: null }],
    },
  ];
  const clips = [
    { id: 'a1', kind: 'video', src: '/p/a.mp4', at: 0, time: [0, 4], speed: 1, duration: 4 },
    { id: 'a2', kind: 'video', src: '/p/a.mp4', at: 4, time: [0, 4], speed: 1, duration: 4 },
  ];
  const mapped = mapCuesToTimeline({ sources, clips, durationSec: 8, fps: 30 });
  assert.deepEqual(
    mapped.cues.map((cue) => [cue.startSec, cue.endSec, cue.clipId]),
    [
      [0.5, 1.5, 'a1'],
      [4.5, 5.5, 'a2'],
    ],
  );
});

test('P23：ASS 时间格式与回读', () => {
  assert.equal(formatAssTime(0), '0:00:00.00');
  assert.equal(formatAssTime(65.25), '0:01:05.25');
  assert.equal(formatAssTime(3723.5), '1:02:03.50');
  assert.equal(formatVttTime(65.25), '00:01:05.250');

  const ass = buildAssDocument({
    cues: [
      { index: 1, startSec: 0.5, endSec: 1.5, text: '第一句\n第二行', id: null },
      { index: 2, startSec: 2, endSec: 3, text: 'a{b}c', id: null },
    ],
    size: { w: 1280, h: 720 },
    style: { fontSizeRatio: 0.05, bottomSafeRatio: 0.1 },
  });
  const back = parseAssDocument(ass);
  assert.equal(back.playRes.w, 1280);
  assert.equal(back.playRes.h, 720);
  assert.equal(back.fontSize, 36); // 720 * 0.05
  // R14-C2 改了 MarginV 的口径：舞台的 `bottom` 是到**行盒**底边，行盒比字号高，
  // 半行距会把字顶上去。所以 = 高×安全区 + (lineHeight−1)/2×字号
  //   = 720×0.1 + (1.25−1)/2×36 = 72 + 4.5 = 76.5 → **floor 76**（R32 起向下取整：
  //     安全区是下限，取整只能往里收；round 会给 77，比安全区更靠外 0.5px）
  // 这个数不是"凑"出来的：R14-A3 在 720p 上量到旧口径会让成片比预览低 4.54px。
  assert.equal(back.marginV, 76);
  // 同一个数也由单一入口（toAssStyle）给出：resolveAssStyleFields 的 marginV
  assert.equal(
    resolveAssStyleFields({
      size: { w: 1280, h: 720 },
      style: resolveSubtitleStyle({ fontSizeRatio: 0.05, bottomSafeRatio: 0.1 }),
    }).fields.marginV,
    76,
  );
  assert.equal(back.cues.length, 2);
  assert.equal(back.cues[0]?.startSec, 0.5);
  assert.equal(back.cues[0]?.endSec, 1.5);
  assert.equal(back.cues[0]?.text, '第一句\\N第二行');
  assert.match(back.cues[1]?.text ?? '', /\\\{b\\\}c/);
});

test('P23：样式默认值对齐副线1（0.04 / 0.08），未知键要报错', () => {
  const style = resolveSubtitleStyle(undefined);
  /* R32：0.045 → 0.04（参照 `s8.md`）。bottomSafeRatio 没动。 */
  assert.equal(style.fontSizeRatio, 0.04);
  assert.equal(style.bottomSafeRatio, 0.08);
  assert.equal(resolveSubtitleStyle({ fontSizeRatio: 0.06 }).fontSizeRatio, 0.06);
  assert.throws(() => resolveSubtitleStyle({ fontSizeRatio: -1 }), /SUBTITLE_UNSUPPORTED/);
  assert.deepEqual(parseStyleArg('fontSizeRatio=0.05,bold=1'), { fontSizeRatio: 0.05, bold: true });
  assert.deepEqual(parseStyleArg('{"fontFamily":"PingFang SC"}'), { fontFamily: 'PingFang SC' });
  assert.throws(() => parseStyleArg('nonsense'), /SUBTITLE_UNSUPPORTED/);
});

test('P23：字形检查把 .LastResort 当"不存在"（豆腐字体不算覆盖）', async () => {
  /** @type {any[][]} */
  const calls = [];
  const fakeExec = async (/** @type {string} */ file, /** @type {readonly string[]} */ args = []) => {
    calls.push([file, ...args]);
    if (args[0] === '--version') return { stdout: 'fontconfig 2.15', stderr: '' };
    const charset = args[0] ?? '';
    if (charset === ':charset=2a6a5') return { stdout: '.LastResort\n', stderr: '' };
    if (charset === ':charset=41') return { stdout: 'Helvetica\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await checkGlyphCoverage({ texts: ['A𪚥'], execFileImpl: fakeExec });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.missing.map((/** @type {any} */ m) => m.codePoint), ['U+2A6A5']);
  assert.equal(result.checked, 2);
  assert.ok(calls.some((call) => call[1] === '--version'));
});

test('P23：没有 fc-list 时是 NOT_RUN，不假装检过', async () => {
  const fakeExec = async () => {
    const err = new Error('spawn fc-list ENOENT');
    /** @type {any} */ (err).code = 'ENOENT';
    throw err;
  };
  const result = await checkGlyphCoverage({ texts: ['中文'], execFileImpl: fakeExec });
  assert.equal(result.status, 'NOT_RUN');
  assert.match(String(result.reason), /fc-list/);
});

test('P23：ffmpeg 没有 subtitles 滤镜时（exit 0 + Unknown filter）要判为不可用', async () => {
  // 真实坑：`ffmpeg -h filter=subtitles` 在缺滤镜时也 exit 0，只看退出码会误判
  const missing = async (/** @type {string} */ file, /** @type {readonly string[]} */ args = []) => {
    if (args.includes('-version')) return { stdout: 'ffmpeg version 8.1.2\n', stderr: '' };
    return { stdout: "Unknown filter 'subtitles'.\n", stderr: '' };
  };
  const probeMissing = await probeSubtitleBurnSupport('ffmpeg', missing);
  assert.equal(probeMissing.ok, false);
  assert.match(probeMissing.detail, /libass/);

  const full = async (/** @type {string} */ file, /** @type {readonly string[]} */ args = []) => {
    if (args.includes('-version')) return { stdout: 'ffmpeg version 8.0\n', stderr: '' };
    return { stdout: 'Filter subtitles\n  Render text subtitles onto input video using the libass library.\n', stderr: '' };
  };
  const probeFull = await probeSubtitleBurnSupport('/opt/ffmpeg-full', full);
  assert.equal(probeFull.ok, true);
  assert.equal(probeFull.version, 'ffmpeg version 8.0');
});

test('P23：滤镜参数把路径包进单引号', () => {
  assert.equal(subtitleFilterArg('/tmp/a b/c.ass'), "subtitles=filename='/tmp/a b/c.ass'");
});

test('quotes a Windows drive and a literal quote through both FFmpeg filter parsers', () => {
  assert.equal(
    subtitleFilterArg(String.raw`C:\剪辑 项目\O'Brien,[v2].ass`),
    String.raw`subtitles=filename='C\:/剪辑 项目/O\'\''Brien,[v2].ass'`,
  );
  assert.equal(
    subtitleFilterArg(String.raw`\\server\share\剪辑 项目.ass`),
    "subtitles=filename='//server/share/剪辑 项目.ass'",
  );
});

test('P23：旁挂 vtt 写成成片时间（不是原样复制）', () => {
  const vtt = buildVttDocument({
    cues: [
      { startSec: 0.5, endSec: 1.5, text: '第一句' },
      { startSec: 2, endSec: 3, text: '第二句' },
    ],
  });
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.500 --> 00:00:01\.500\n第一句\n/);
  const parsed = /** @type {any} */ (parseSubtitleText(vtt, { format: 'vtt' }));
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0]?.startSec, 0.5);
});

test('P23：行内标记必须清洗（与 film-core 同口径；不清洗会原样烧进画面）', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v 阿宁><i>第一句</i> &amp; 你好\n';
  const parsed = /** @type {any} */ (parseSubtitleText(vtt, { format: 'vtt' }));
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, '第一句 & 你好');
  const ass = buildAssDocument({ cues: parsed.cues, size: { w: 1280, h: 720 } });
  const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:'));
  assert.ok(dialogue);
  assert.doesNotMatch(dialogue, /<v |<i>|&amp;/);
  assert.match(dialogue, /第一句 & 你好$/);
});

test('P23：空文本 cue 丢掉（时间线没有它，烧录也不该多一条空字幕）', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nb\n';
  const parsed = /** @type {any} */ (parseSubtitleText(vtt, { format: 'vtt' }));
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, 'b');
});

test('P23：findSidecar 优先 .vtt', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-sidecar-'));
  await fs.writeFile(path.join(dir, 'a.mp4'), 'x');
  await fs.writeFile(path.join(dir, 'a.srt'), '1\n00:00:01,000 --> 00:00:02,000\ns\n');
  assert.deepEqual(await findSidecar(path.join(dir, 'a.mp4')), { path: path.join(dir, 'a.srt'), format: 'srt' });
  await fs.writeFile(path.join(dir, 'a.vtt'), 'WEBVTT\n\n');
  assert.deepEqual(await findSidecar(path.join(dir, 'a.mp4')), { path: path.join(dir, 'a.vtt'), format: 'vtt' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('P25-A2：描边按字号换算（与舞台 strokeWidthRatio 同一个旋钮），并锁住各画幅的对照表', () => {
  const style = resolveSubtitleStyle(undefined);
  // 舞台：stroke = 0.055 × fontSize（CSS `stroke-width` 是描边带**总宽**）。
  // ASS `Outline` 是带**外扩量**（带总宽 = 2×Outline），所以写进 ASS 时是它的一半。
  // 0.055 是 R31 从参照 `Sy.outline` 的 `stroke.widthEm` 抄来的（原文偏移见 subtitle-style.mjs）。
  assert.equal(style.strokeWidthRatio, 0.055);
  assert.equal(style.outlineRatio, null);
  // 默认字体不是舞台族表第一个具体族 PingFang SC：它在 libass 8.0 里只渲出 0.703em
  // （R14-A3 实测，见 README）。要同族可用 fontScale=1.42 补回来。
  assert.equal(style.fontFamily, 'Heiti SC');
  assert.equal(style.lineHeight, 1.25);
  assert.equal(style.fontScale, 1);
  assert.equal(style.cpsWarn, 17);

  /** 每种画幅：[高, 字号, ASS Outline] @type {Array<[number, number, number]>} */
  const table = [
    /* R32（0.045→0.04）重算：字号 ×4 格全降，描边 1920 那格 2→2 不变、2160 那格 3→2。 */
    [720, 29, 1],
    [1080, 43, 1],
    [1920, 77, 2],
    [2160, 86, 2],
  ];
  for (const [height, fontSize, outline] of table) {
    // 不传 layout 时舞台 = 画布；字号/描边都从 S41 的 toAssStyle 出（P37 起不再本文件手算）
    const fields = resolveAssStyleFields({ size: { w: Math.round((height * 16) / 9), h: height } }).fields;
    assert.equal(fields.fontSizePx, fontSize, `fontSize @${height}`);
    assert.equal(fields.outlinePx, outline, `outline @${height}`);
  }

  // 旧口径仍可用：显式给 outlineRatio 就按画面高算（老配置不会静默变样）
  const legacy = resolveSubtitleStyle({ outlineRatio: 0.0025 });
  assert.equal(legacy.outlineRatio, 0.0025);
  assert.equal(resolveAssStyleFields({ size: { w: 1280, h: 720 }, style: legacy }).fields.outlinePx, 2);
  assert.equal(resolveAssStyleFields({ size: { w: 3840, h: 2160 }, style: legacy }).fields.outlinePx, 5);

  // ASS 里写出来的就是算出来的那个数（R32：1920 高 × 0.04 = 76.8 → 77）
  const ass = buildAssDocument({ cues: [], size: { w: 1080, h: 1920 } });
  assert.match(ass, /Style: Default,Heiti SC,77,/);
  assert.match(ass, /,1,2,3,2,/); // BorderStyle,Outline,Shadow,Alignment
});

test('P25-A2：cpsWarn 以舞台为准（17），且不影响渲染', () => {
  assert.equal(SUBTITLE_STYLE_DEFAULTS.cpsWarn, 17);
  const slow = buildAssDocument({
    cues: [{ index: 1, startSec: 0, endSec: 2, text: '一句正常长度的话', id: null }],
    size: { w: 1280, h: 720 },
  });
  const fast = buildAssDocument({
    cues: [{ index: 1, startSec: 0, endSec: 0.2, text: '一句正常长度的话', id: null }],
    size: { w: 1280, h: 720 },
  });
  // 同样文字、只是时长不同（CPS 差 10 倍）：ASS 除了时间没有任何差别
  assert.equal(slow.split('\n').filter((l) => l.startsWith('Style:')).join(), fast.split('\n').filter((l) => l.startsWith('Style:')).join());
});

/* ── P32：字幕随画幅缩放 ───────────────────────────────────────────── */

test('P32：layout 的几何 = 舞台尺寸 × scale + 留边偏移（竖屏 / 4K）', () => {
  const style = resolveSubtitleStyle(undefined);
  // 竖屏 1080×1920 + letterbox：scale = min(1080/1280, 1920/720) = 0.84375，
  // 画面 1080×607.5 居中 → 上下各留 656.25px
  const portraitScale = 1080 / 1280;
  const portraitOffsetY = (1920 - 720 * portraitScale) / 2;
  assert.equal(portraitScale, 0.84375);
  assert.equal(portraitOffsetY, 656.25); // 720 × 0.84375 = 607.5，上下各留 656.25

  const portrait = buildAssDocument({
    cues: [{ index: 1, startSec: 0, endSec: 2, text: '竖屏字幕', id: null }],
    size: { w: 1080, h: 1920 },
    layout: { stage: { w: 1280, h: 720 }, scale: portraitScale, offset: { x: 0, y: portraitOffsetY } },
  });
  assert.match(portrait, /PlayResX: 1080/);
  assert.match(portrait, /PlayResY: 1920/);
  /* R32：字号 24 = round(720 × 0.04 × 0.84375)；描边 1；
     MarginV 707 = floor((57.6+3.6)×0.84375 + 656.25) —— 精确值 707.8875，
     R32 起向下取整（原来 round 给 708，比安全区更靠外 0.11px）。 */
  assert.match(portrait, /Style: Default,Heiti SC,24,/);
  const parsed = parseAssDocument(portrait);
  assert.equal(parsed.marginV, 707);

  // 若按输出画布高直接算（旧口径）：77px + MarginV 163 —— 字比预览大 3.2 倍，
  // 而且 163 落在下方黑边里（画面只到 y=1264）。这条断言是"旧行为长什么样"的钉子。
  const naive = buildAssDocument({ cues: [], size: { w: 1080, h: 1920 } });
  assert.match(naive, /Style: Default,Heiti SC,77,/);
  assert.equal(parseAssDocument(naive).marginV, 163);

  // 4K 3840×2160：scale = 3，正好铺满、无留边 → 字号 86、描边 2、MarginV 183
  // （R32：183.6 → floor 183；round 会给 184）
  const fourK = buildAssDocument({
    cues: [],
    size: { w: 3840, h: 2160 },
    layout: { stage: { w: 1280, h: 720 }, scale: 3, offset: { x: 0, y: 0 } },
  });
  assert.match(fourK, /Style: Default,Heiti SC,86,/);
  assert.equal(parseAssDocument(fourK).marginV, 183);
});

test('P32：720p 传「恒等 layout」与不传 layout 逐字节相同（回归钉）', () => {
  const cues = [
    { index: 1, startSec: 0.5, endSec: 2, text: '同一句', id: null },
    { index: 2, startSec: 3, endSec: 4, text: '第二句', id: null },
  ];
  const without = buildAssDocument({ cues, size: { w: 1280, h: 720 } });
  const withIdentity = buildAssDocument({
    cues,
    size: { w: 1280, h: 720 },
    layout: { stage: { w: 1280, h: 720 }, scale: 1, offset: { x: 0, y: 0 } },
  });
  assert.equal(withIdentity, without);
});

test('P32：layout 的 stage 非法时退回画布（不能把字缩成 0 或 NaN）', () => {
  const cues = [{ index: 1, startSec: 0, endSec: 1, text: '回归', id: null }];
  const zeroStage = buildAssDocument({
    cues,
    size: { w: 1280, h: 720 },
    layout: { stage: { w: 0, h: 0 } },
  });
  // R32：退回 1280×720 画布后字号 29、MarginV 61
  assert.match(zeroStage, /Style: Default,Heiti SC,29,/);
  assert.equal(parseAssDocument(zeroStage).marginV, 61);

  // size 本身非法（0/NaN）时退回 1280×720，与 R15 一致
  assert.match(buildAssDocument({ cues, size: { w: 0, h: 0 } }), /PlayResX: 1280\nPlayResY: 720/);
});
