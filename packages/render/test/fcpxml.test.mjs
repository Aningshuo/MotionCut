/**
 * P22 验收：FCPXML 1.9 导出（`fcpxml.mjs`）。
 *
 * 测试盯的是"结构错了 NLE 一定会打回来"的那几处：
 * 1. rational time 的写法（30fps 下 1 秒必须是 `30/30s`，不是 `1s`）；
 * 2. 视觉片段数、每条 clip 的 offset/start/duration 与 plan 对得上（±1 帧）；
 * 3. 网页片段降级成 gap 且带 note（不许假装能导）；
 * 4. 同一 lane 上的片段不重叠；主故事线连续；
 * 5. 回读解析器真的能读出问题（拿一份被改坏的 XML 验证它不瞎）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FCPXML_DTD_VERSION,
  buildFcpxml,
  frameRateOf,
  framesOf,
  parseFcpxml,
  parseRationalTime,
  rationalTime,
  verifyFcpxml,
} from '../fcpxml.mjs';

/**
 * 一个 30fps、30 秒、4 视频 + 4 网页 + 4 音频的计划（形状同 R10 的 film30）。
 * 故意标 any：测试里会就地改字段（去掉片段、改 speed、把 time 设成 null），
 * 让 TS 去追这些变更只会把测试写成类型体操。
 * @returns {any}
 */
function plan30() {
  const clips = [
    { id: 'take-1', at: 0, time: [0, 8], duration: 8 },
    { id: 'take-2', at: 8, time: [0, 7.5], duration: 7.5 },
    { id: 'take-3', at: 15.5, time: [0.5, 8], duration: 7.5 },
    { id: 'take-4', at: 23, time: [0, 7], duration: 7 },
  ];
  return {
    fps: 30,
    duration: 30,
    outputDuration: 30,
    frames: 900,
    stage: { w: 1280, h: 720 },
    visualClips: clips.map((c) => ({ ...c, kind: 'video', src: '/media/clip.mp4', speed: 1, box: {} })),
    sceneClips: [
      { id: 'card-a1', at: 0, time: [0, 8], src: 'scene-a.html#t=0,8' },
      { id: 'card-b1', at: 7.5, time: [0, 8], src: 'scene-b.html#t=0,8' },
      { id: 'card-c1', at: 15, time: [0, 8], src: 'scene-c.html#t=0,8' },
      { id: 'card-a2', at: 22.5, time: [0, 7.5], src: 'scene-a.html#t=0,7.5' },
    ],
    audioMix: {
      duration: 30,
      sampleRate: 48000,
      channels: 2,
      clips: [
        { src: '/media/tone.wav', at: 0, time: [0, 8], speed: 1, volume: 0.08, fade: [0, 0] },
        { src: '/media/tone.wav', at: 8, time: [0, 7.5], speed: 1, volume: 0.08, fade: [0, 0] },
        { src: '/media/tone.wav', at: 15.5, time: [0.5, 8], speed: 1, volume: 0.08, fade: [0, 0] },
        { src: '/media/tone.wav', at: 23, time: [0, 7], speed: 1, volume: 0.08, fade: [0, 0] },
      ],
    },
    warnings: [],
  };
}

test('P22-A3：30fps 下 1 秒是 30/30s，8 秒是 240/30s，7.5 秒是 225/30s', () => {
  const rate = frameRateOf(30);
  assert.equal(rate.frameDuration, '1/30s');
  assert.equal(rationalTime(1, rate), '30/30s');
  assert.equal(rationalTime(8, rate), '240/30s');
  assert.equal(rationalTime(7.5, rate), '225/30s');
  assert.equal(rationalTime(0, rate), '0/30s');
  assert.equal(framesOf(7.5, 30), 225);
  assert.equal(parseRationalTime('240/30s'), 8);
  assert.equal(parseRationalTime('1s'), null, '不接受简写：必须是 rational');
});

test('P22：NTSC 帧率写成 1001/30000s，陌生帧率直接抛错', () => {
  const ntsc = frameRateOf(29.97);
  assert.equal(ntsc.frameDuration, '1001/30000s');
  // 29.97 下"1 秒"不是整数帧，能精确表达的是"1 帧" = 1001/30000s（≈0.03337s）
  assert.equal(rationalTime(1 / ntsc.fps, ntsc), '1001/30000s');
  // 30 帧 = 30×1001/30000s ≈ 1.001s（NTSC 的"一秒"本来就不是整 30 帧）
  assert.equal(rationalTime(30 / ntsc.fps, ntsc), '30030/30000s');
  assert.throws(() => frameRateOf(12.5), /unsupported fps/);
});

test('P22-A1/A2：生成 → 回读，片段数与时长都对得上', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  const parsed = parseFcpxml(xml);
  assert.equal(parsed.version, FCPXML_DTD_VERSION);

  const check = verifyFcpxml(xml, plan);
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
  assert.equal(check.visualClipsInXml, plan.visualClips.length);
  assert.equal(check.durationFrames, 900);
  assert.equal(check.expectedFrames, 900);

  // 每条视觉片段的 offset/duration/start 都要能对回 plan（±1 帧）
  const byName = new Map(check.clips.map((c) => [c.name, c]));
  for (const clip of plan.visualClips) {
    const found = byName.get(clip.id);
    assert.ok(found, `missing ${clip.id}`);
    if (!found) continue;
    assert.equal(found.offsetRaw, `${Math.round(clip.at * 30)}/30s`);
    assert.equal(found.durationRaw, `${Math.round(clip.duration * 30)}/30s`);
    assert.equal(found.startRaw, `${Math.round(clip.time[0] * 30)}/30s`);
  }
  // 贴三个原始值，供人工核对
  assert.equal(byName.get('take-1')?.offsetRaw, '0/30s');
  assert.equal(byName.get('take-2')?.offsetRaw, '240/30s');
  assert.equal(byName.get('take-3')?.startRaw, '15/30s');
});

test('P22-A4：网页片段降级成 gap + note，条数对得上', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  const check = verifyFcpxml(xml, plan);
  assert.equal(check.gaps.length, plan.sceneClips.length);
  for (const gap of check.gaps) {
    assert.match(gap.note, /no media file/);
    assert.match(gap.note, /Re-create it in the NLE/);
    assert.match(gap.name, /web scene not exported/);
  }
  // 不许出现"假装导出了网页"的 asset-clip：非视觉片段只能是音频
  const visualNames = new Set(plan.visualClips.map((/** @type {any} */ c) => c.id));
  for (const clip of check.clips) {
    if (visualNames.has(clip.name)) continue;
    assert.match(clip.name, /^audio-\d+$/, `unexpected asset-clip ${clip.name}`);
  }
});

test('P22：同一条 lane 上不重叠，主故事线连续覆盖整片', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  const parsed = parseFcpxml(xml);
  /** @type {Map<string, Array<{ from: number, to: number }>>} */
  const lanes = new Map();
  for (const el of parsed.elements) {
    if (el.name !== 'asset-clip' && el.name !== 'gap') continue;
    if (el.parent !== 'spine') continue;
    const lane = el.attrs.lane ?? 'primary';
    const start = parseRationalTime(el.attrs.offset) ?? 0;
    const duration = parseRationalTime(el.attrs.duration) ?? 0;
    const list = lanes.get(lane) ?? [];
    list.push({ from: start, to: start + duration });
    lanes.set(lane, list);
  }
  for (const [lane, spans] of lanes) {
    spans.sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok((spans[i]?.from ?? 0) >= (spans[i - 1]?.to ?? 0) - 1e-6, `lane ${lane} overlaps at ${spans[i]?.from}`);
    }
  }
  // 主故事线：从 0 开始，连续到片尾
  const primary = lanes.get('primary') ?? [];
  assert.ok(primary.length > 0);
  assert.equal(primary[0]?.from, 0);
  let cursor = 0;
  for (const span of primary.sort((a, b) => a.from - b.from)) {
    assert.ok(Math.abs(span.from - cursor) < 1e-6, `primary storyline has a hole at ${cursor}`);
    cursor = span.to;
  }
  assert.ok(Math.abs(cursor - 30) < 1e-6, `primary ends at ${cursor}, expected 30`);
});

test('P22：视频之间的空档用 gap 填，不会让时间线塌缩', () => {
  const plan = plan30();
  plan.visualClips = [plan.visualClips[0], { ...plan.visualClips[3], at: 25, duration: 5 }];
  plan.outputDuration = 30;
  const xml = buildFcpxml(plan, { projectName: 'gap-test' });
  const check = verifyFcpxml(xml, plan);
  assert.equal(check.ok, true);
  assert.equal(check.durationFrames, 900);
  assert.ok(xml.includes('<gap name="gap"'), 'expected a filler gap between clips');
});

test('P22-A5：不内嵌媒体，30 秒片远小于 200KB', () => {
  const xml = buildFcpxml(plan30(), { projectName: 'film30' });
  assert.ok(Buffer.byteLength(xml, 'utf8') < 200 * 1024, `too big: ${Buffer.byteLength(xml)}`);
  assert.ok(!xml.includes('base64'));
  assert.ok(!xml.includes('<data'));
  // src 必须是 file:// 绝对路径
  assert.match(xml, /src="file:\/\/\//);
});

test('P22：纯音频素材标 hasVideo="0" 且不带 format（否则 NLE 会当视频轨去解）', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  const parsed = parseFcpxml(xml);
  const assets = parsed.elements.filter((el) => el.name === 'asset');
  const video = assets.find((el) => el.attrs.name === 'clip.mp4');
  const audio = assets.find((el) => el.attrs.name === 'tone.wav');
  assert.ok(video && audio);
  assert.equal(video.attrs.hasVideo, '1');
  assert.equal(video.attrs.hasAudio, '0');
  assert.equal(video.attrs.format, 'r1');
  assert.equal(audio.attrs.hasVideo, '0');
  assert.equal(audio.attrs.hasAudio, '1');
  assert.equal(audio.attrs.format, undefined, 'audio-only asset must not carry a video format');
});

test('P22：同一条素材既做画面又做声音时，两个标志都立起来', () => {
  const plan = plan30();
  plan.audioMix.clips = [{ ...plan.audioMix.clips[0], src: '/media/clip.mp4' }];
  const xml = buildFcpxml(plan, { projectName: 'shared' });
  const asset = parseFcpxml(xml).elements.find((el) => el.name === 'asset' && el.attrs.name === 'clip.mp4');
  assert.equal(asset?.attrs.hasVideo, '1');
  assert.equal(asset?.attrs.hasAudio, '1');
});

test('P22：名字里的 & < > 会被转义，回读能还原', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'A & B <cut>', eventName: 'E & E' });
  assert.match(xml, /name="A &amp; B &lt;cut&gt;"/);
  assert.ok(!/name="A & B/.test(xml), 'raw & must not survive');
  const parsed = parseFcpxml(xml);
  const project = parsed.elements.find((el) => el.name === 'project');
  assert.equal(project?.attrs.name, 'A & B <cut>');
});

test('P22：回读校验器不瞎——故意改坏 duration 必须报错', () => {
  const plan = plan30();
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  // 精确改 take-2 那一条 clip 的 duration（asset 上也有 240/30s，不能误伤）
  const broken = xml.replace(/(<asset-clip ref="r2" name="take-2"[^>]*duration=")225\/30s(")/, '$1210/30s$2');
  assert.notEqual(broken, xml, 'tamper must actually change something');
  const check = verifyFcpxml(broken, plan);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /duration/.test(p)), check.problems.join('; '));
});

test('P22：网页片段没有 #t=in,out（时长未知）时跳过并记账，不编一个长度', () => {
  const plan = plan30();
  plan.sceneClips = [{ id: 'bad', at: 0, time: null, src: 'scene-x.html' }];
  const xml = buildFcpxml(plan, { projectName: 'film30' });
  const check = verifyFcpxml(xml, plan);
  assert.equal(check.gaps.length, 0);
  assert.match(xml, /<fcpxml/);
});

test('P22：变速片段会挂 note 说明没写 timeMap（不静默丢信息）', () => {
  const plan = plan30();
  plan.visualClips = [{ ...plan.visualClips[0], speed: 2 }];
  const xml = buildFcpxml(plan, { projectName: 'speed' });
  assert.match(xml, /note="speed 2x is not represented/);
});
