/**
 * P25 的夹具与白名单：**测试与证据生成共用这一份**，免得"测试里 18 条、证据里 16 条"
 * 这种两处漂移。这里只放数据，不放断言。
 */

/**
 * 允许的差异白名单。**除白名单外任何差异都是回归**，不许为了让测试变绿而加条目。
 *
 * @typedef {{ id: string, reason: string, expect: 'render-throws' }} WhitelistEntry
 */

/** @type {WhitelistEntry[]} */
export const DIFF_WHITELIST = [
  {
    id: 'end-before-start',
    reason:
      '导出的成品必须拒绝坏字幕（end<start 会让 ASS 时间轴倒流、libass 行为未定义），' +
      '所以本包抛 SUBTITLE_PARSE_FAILED；预览不该因为一条坏 cue 白屏，所以 film-core 静默 skip。' +
      '两种都正确，但方向相反——这是产品语义的差异，不是 bug。',
    expect: 'render-throws',
  },
];

/**
 * 夹具：`text` 是原样字节，`format` 决定用哪种语法解析。
 * `why` 写这条夹具在守什么（评审看这个就知道覆盖够不够）。
 * @type {Array<{ id: string, format: 'vtt' | 'srt', text: string, why: string }>}
 */
export const FIXTURES = [
  {
    id: 'basic-vtt',
    format: 'vtt',
    why: '最普通的两条 cue（带标识行）',
    text: ['WEBVTT', '', '1', '00:00:01.000 --> 00:00:02.000', '第一句', '', '2', '00:00:03.000 --> 00:00:04.500', '第二句', ''].join('\n'),
  },
  {
    id: 'bom',
    format: 'vtt',
    why: '带 BOM 的文件（Windows 记事本导出的常态）',
    text: `\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBOM 之后的第一句\n`,
  },
  {
    id: 'note-and-style',
    format: 'vtt',
    why: 'NOTE / STYLE / REGION 整块跳过，不能当成 cue',
    text: [
      'WEBVTT',
      '',
      'NOTE 这是注释块',
      '第二行注释',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '注释之后的一句',
      '',
      'REGION',
      'id:fred width:40%',
      '',
    ].join('\n'),
  },
  {
    id: 'entities',
    format: 'vtt',
    why: 'HTML 实体还原（&amp; &lt; &gt; &nbsp;）',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA &amp; B &lt;tag&gt; C&nbsp;D\n',
  },
  {
    id: 'short-time',
    format: 'vtt',
    why: 'MM:SS.mmm 短时间戳（VTT 允许省略小时）',
    text: 'WEBVTT\n\n00:02.500 --> 00:04.000\n短时间戳这一句\n',
  },
  {
    id: 'inline-voice-and-italic',
    format: 'vtt',
    why: 'R14-C1 的原始现场：<v 阿宁><i>…</i> 必须烧成纯文本',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v 阿宁><i>第一句</i> &amp; 你好\n',
  },
  {
    id: 'inline-class-tag',
    format: 'vtt',
    why: '<c.red> 类名标签与自闭合 <br>',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.red>红色</c>与<br>换行\n',
  },
  {
    id: 'crlf',
    format: 'vtt',
    why: 'CRLF 行尾（Windows 编辑器保存的 vtt）',
    text: 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nCRLF 也要一样\r\n',
  },
  {
    id: 'cue-id',
    format: 'vtt',
    why: '标识行可以是数字也可以是文字；标识本身不进文本',
    text: [
      'WEBVTT',
      '',
      'cue-one',
      '00:00:01.000 --> 00:00:02.000',
      '文字标识',
      '',
      '42',
      '00:00:03.000 --> 00:00:04.000',
      '数字标识',
      '',
    ].join('\n'),
  },
  {
    id: 'srt-comma',
    format: 'srt',
    why: 'SRT 逗号毫秒',
    text: ['1', '00:00:01,000 --> 00:00:02,500', 'SRT 第一句', '', '2', '00:00:03,000 --> 00:00:04,000', 'SRT 第二句', ''].join('\n'),
  },
  {
    id: 'srt-no-header',
    format: 'srt',
    why: '无 WEBVTT 头的 SRT（最常见的一种旁挂 srt）',
    text: '00:00:01,000 --> 00:00:02,000\n没有头的 SRT\n\n00:00:03,000 --> 00:00:04,000\n第二条\n',
  },
  {
    id: 'multiline',
    format: 'vtt',
    why: '多行文本保留换行（预览折两行，烧录也要两行）',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n第一行文字\n第二行文字\n',
  },
  {
    id: 'empty-text',
    format: 'vtt',
    why: '只有时间没有文字的 cue：两边都必须丢掉',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\n有字的那条\n',
  },
  {
    id: 'overlap',
    format: 'vtt',
    why: '重叠 cue：顺序与条数都要一致（预览取 start 最大那条，烧录两条都在）',
    text: [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:05.000',
      '长的一条',
      '',
      '00:00:02.000 --> 00:00:03.000',
      '叠在上面的一条',
      '',
    ].join('\n'),
  },
  {
    id: 'end-before-start',
    format: 'vtt',
    why: '坏区间：本包抛错、film-core 丢弃（白名单第 1 条）',
    text: 'WEBVTT\n\n00:00:05.000 --> 00:00:04.000\n时间倒流的一条\n',
  },
  {
    id: 'header-metadata',
    format: 'vtt',
    why: 'WEBVTT 头带标题 + Kind/Language 元数据行',
    text: ['WEBVTT - 阿宁的视频', 'Kind: captions', 'Language: zh-CN', '', '00:00:01.000 --> 00:00:02.000', '头里带元数据', ''].join('\n'),
  },
  {
    id: 'timing-settings',
    format: 'vtt',
    why: '时间行带 align/position 设置，不能被当成时间戳的一部分',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10%\n带设置的一行\n',
  },
  {
    id: 'fast-cps',
    format: 'vtt',
    why: 'CPS 超限的短句（cpsWarn 只提示不拦，两边都要出这条）',
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:01.400\n这句话在四百毫秒里根本读不完\n',
  },
];

