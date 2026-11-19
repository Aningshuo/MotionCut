/** @typedef {Record<string, string | number>} SceneParams */
/** @typedef {(id: string, value: string | number | undefined) => string} EditableField */
/** @param {string} label @param {string} value */
const words = (label, value) => ({ type: 'string', label, default: value });
/** @param {string} label @param {number} value */
const percentage = (label, value) => ({ type: 'number', label, default: value, min: 0, max: 100 });

export const MOTION_TEMPLATES = [
  { variant: 'folio', name: '折页章节片头', title: '镜头之间', subtitle: '一段影像，从这里开始。', accent: '#ff8d55', color: '#fff6e8',
    fields: { chapter: words('章节编号', '01'), section: words('章节名', '影像手记') } },
  { variant: 'compare', name: '双轨数据对照', title: '两种工作方式', subtitle: '用同一个指标观察变化', accent: '#207158', color: '#1a3429',
    fields: { labelA: words('第一项', '手动整理'), valueA: percentage('第一项百分比', 36), labelB: words('第二项', '批量整理'), valueB: percentage('第二项百分比', 84) } },
  { variant: 'dial', name: '环形进度读数', title: '项目完成度', subtitle: '已通过审核的片段占比', accent: '#7cbaff', color: '#edf5ff',
    fields: { value: percentage('完成百分比', 72), label: words('读数说明', '当前进度') } },
  { variant: 'route', name: '三拍流程节点', title: '把素材剪成故事', subtitle: '三个步骤完成一次粗剪', accent: '#b8df65', color: '#f2f4e9',
    fields: { step1: words('第一步', '挑选镜头'), step2: words('第二步', '排列节奏'), step3: words('第三步', '检查衔接') } },
];

const baseStyle = `
* { box-sizing:border-box; }
html, body { margin:0; width:1280px; height:720px; overflow:hidden; font-family:system-ui,-apple-system,'PingFang SC',sans-serif; }
main { position:absolute; inset:0; overflow:hidden; color:var(--ink); }
h1, p, ol { margin:0; }
h1 { font-size:var(--size); line-height:1.12; letter-spacing:-.045em; overflow-wrap:anywhere; }
header { position:relative; z-index:1; opacity:var(--enter); transform:translateY(calc((1 - var(--enter))*32px)); }
header p { margin-top:20px; font-size:27px; line-height:1.4; opacity:.77; }
`;

/** @type {Record<string, (params: SceneParams, field: EditableField) => { artwork: string, style: string }>} */
const layouts = {
  folio(p, field) {
    return {
      artwork: `<div class="paper-stack" aria-hidden="true"><i></i><i></i><i></i></div><div class="section">${field('section',p.section)}<span class="rule"></span></div><div class="chapter">${field('chapter',p.chapter)}</div>`,
      style: `
.folio { background:#202a36; }
.folio header { position:absolute; left:86px; bottom:86px; width:810px; }
.section { position:absolute; top:72px; left:86px; display:flex; align-items:center; gap:28px; font-size:23px; color:var(--accent); letter-spacing:.12em; }
.rule { height:2px; width:calc(125px * var(--draw)); background:currentColor; }
.chapter { position:absolute; top:69px; right:75px; color:var(--ink); font:600 36px/1 ui-monospace,monospace; }
.paper-stack { position:absolute; inset:0; overflow:hidden; }
.paper-stack i { position:absolute; display:block; width:490px; height:720px; left:72%; top:36%; border:2px solid var(--accent); background:#293340; transform-origin:bottom right; }
.paper-stack i:nth-child(1) { transform:translateY(calc((1 - var(--enter))*190px)) rotate(-26deg); }
.paper-stack i:nth-child(2) { transform:translateY(calc((1 - var(--draw))*210px)) rotate(-16deg); }
.paper-stack i:nth-child(3) { background:var(--accent); transform:translateY(calc((1 - var(--late))*240px)) rotate(-6deg); }`,
    };
  },
  compare(p, field) {
    /** @param {string} key @param {string | number | undefined} value @param {string | number | undefined} label */
    const row = (key, value, label) => `<div class="comparison-row"><div class="comparison-label">${field('label'+key,label)}${field('value'+key,value+'%')}</div><div class="track"><i style="--value:${value}%"></i></div></div>`;
    return {
      artwork: `<section class="rows">${row('A',p.valueA,p.labelA)}${row('B',p.valueB,p.labelB)}</section>`,
      style: `
.compare { padding:75px 90px; background:#f1f3e8; }
.rows { position:absolute; left:90px; right:90px; bottom:80px; display:grid; gap:36px; }
.comparison-label { display:flex; align-items:baseline; justify-content:space-between; gap:24px; margin-bottom:9px; font-size:30px; }
.comparison-label span:last-child { font:600 38px/1 ui-monospace,monospace; color:var(--accent); }
.track { height:24px; background:#142b2014; }
.track i { display:block; height:100%; width:var(--value); background:var(--accent); transform-origin:left; transform:scaleX(var(--draw)); }
.comparison-row:first-child .track i { opacity:.53; }.comparison-row:last-child .track i { transform:scaleX(var(--late)); }`,
    };
  },
  dial(p, field) {
    return {
      artwork: `<div class="meter"><svg viewBox="0 0 400 400" aria-hidden="true"><circle class="ticks" cx="200" cy="200" r="183"/><circle cx="200" cy="200" r="155"/><circle class="reading" pathLength="100" cx="200" cy="200" r="155"/></svg><div class="readout">${field('value',p.value+'%')}${field('label',p.label)}</div></div>`,
      style: `
.dial { background:#142237; }.dial header { position:absolute; left:85px; top:38%; width:560px; border-left:6px solid var(--accent); padding-left:27px; }
.meter { position:absolute; width:475px; height:475px; right:88px; top:122px; }
.meter svg { display:block; width:100%; transform:rotate(-90deg); fill:none; stroke:#ffffff19; stroke-width:17px; }
.meter .ticks { stroke-width:5px; stroke-dasharray:2 12; stroke:var(--ink); opacity:.42; }
.meter .reading { stroke:var(--accent); stroke-linecap:round; stroke-dasharray:${p.value} 100; stroke-dashoffset:calc(${p.value} * (1 - var(--draw))); }
.readout { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; opacity:var(--enter); }
.readout span:first-child { font:650 88px/1 ui-monospace,monospace; letter-spacing:-.07em; }.readout span:last-child { color:var(--accent); font-size:23px; }`,
    };
  },
  route(p, field) {
    const nodes = ['step1','step2','step3'].map((key,index) => `<li><b>0${index+1}</b>${field(key,p[key])}</li>`).join('');
    return {
      artwork: `<ol class="route-nodes">${nodes}</ol>`,
      style: `
.route { background:#272f2a; padding:78px 86px; }
.route-nodes { position:absolute; left:88px; right:88px; bottom:92px; padding:0; list-style:none; display:grid; grid-template-columns:repeat(3,1fr); gap:30px; }
.route-nodes::before { content:''; position:absolute; left:0; right:0; top:61px; height:4px; background:var(--accent); transform-origin:left; transform:scaleX(var(--draw)); }
.route-nodes li { position:relative; display:flex; flex-direction:column; align-items:flex-start; gap:23px; opacity:var(--enter); transform:translateY(calc((1 - var(--enter))*20px)); }
.route-nodes li:nth-child(2) { opacity:var(--draw); }.route-nodes li:nth-child(3) { opacity:var(--late); }
.route-nodes b { font:600 25px/1 ui-monospace,monospace; color:var(--accent); }
.route-nodes b::after { content:''; display:block; margin-top:24px; width:26px; height:26px; border:5px solid var(--accent); border-radius:50%; background:#272f2a; }
.route-nodes span { font-size:35px; line-height:1.25; }`,
    };
  },
};

/** @param {{variant: string, category: string, name: string}} item @param {SceneParams} params @param {(value: unknown) => string} escape */
export function motionSceneHtml(item, params, escape) {
  const layout = Object.hasOwn(layouts, item.variant) && item.category === 'template' ? layouts[item.variant] : null;
  if (!layout) return null;
  /** @type {EditableField} */
  const field = (id, value) => `<span id="${id}" data-aiedit-id="${id}">${escape(value)}</span>`;
  const { artwork, style } = layout(params, field);
  const head = `<header><h1 id="title" data-aiedit-id="title">${escape(params.title)}</h1><p id="subtitle" data-aiedit-id="subtitle">${escape(params.subtitle)}</p></header>`;
  const palette = `:root{--ink:${params.color};--accent:${params.accent};--size:${params.fontSize}px}`;
  // Drive every animated property from clip-local time so export and reverse seeks reproduce preview.
  const script = `
const duration = ${params.duration};
function eased(x) { const u = Math.min(1, Math.max(0, x)); return 1 - (1-u) ** 3; }
window.film = {
  meta: {duration, previewTime: duration * .45},
  ready: async () => {},
  frame(time) {
    const phase = Math.max(0, Number(time) || 0) / duration;
    const style = document.documentElement.style;
    style.setProperty('--enter', eased(phase / .18));
    style.setProperty('--draw', eased((phase - .08) / .29));
    style.setProperty('--late', eased((phase - .18) / .28));
  }
};
window.film.frame(window.film.meta.previewTime);`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1280,height=720,initial-scale=1"><title>${escape(item.name)}</title><style>${palette}${baseStyle}${style}</style></head><body><main id="composition" class="${item.variant}">${head}${artwork}</main><script>${script}</script></body></html>`;
}
