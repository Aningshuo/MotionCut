import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { bareSrcOf } from '../../../../film-core/track-audio.mjs';
import { frameMsAt } from '../../../../layers/frame-ms.mjs';
import { cellRangeInView, THUMB_W } from './filmstrip';

/** Build the same file URL as the resource library, including the scene's relative directory. */
function thumbnailUrl(projectId: string, src: string): string {
  const source = bareSrcOf(src);
  const parts = source.split('/');
  if (!projectId || !/\.html?$/i.test(source) || /[\\\0]/.test(source) ||
      /^[a-z][a-z\d+.-]*:/i.test(source) || parts.some(part => !part || part.startsWith('.'))) return '';
  const item = encodeURIComponent(`project:${source}`);
  return `/api/projects/${encodeURIComponent(projectId)}/creation-library/files/${item}/${parts.map(encodeURIComponent).join('/')}?preview=thumbnail`;
}

function SceneTile({ url, left, ms }: { url: string; left: number; ms: number }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const seek = () => {
    // A sandboxed scene has an opaque origin. Only a sampling time is passed.
    frame.current?.contentWindow?.postMessage({ type: 'opencut:thumbnail-time', ms }, '*');
  };
  useEffect(seek, [ms, url]);
  return createElement('iframe', {
    ref: frame, src: url, title: '网页场景缩略图', sandbox: 'allow-scripts', referrerPolicy: 'no-referrer',
    tabIndex: -1, className: 'tl-clip-scene-thumb', style: { left }, onLoad: seek,
  });
}

/** Visible tiles sample source time at the same positions as video frames. */
export function SceneFilmstrip({ projectId, src, width, height, pps, speed, sourceIn, sourceOut }: {
  projectId: string;
  src: string;
  width: number;
  height: number;
  pps: number;
  speed: number;
  sourceIn: number;
  sourceOut: number;
}): ReactNode {
  const strip = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ from: 0, to: -1 });
  const url = width > 0 && height > 0 && pps > 0 ? thumbnailUrl(projectId, src) : '';

  useEffect(() => {
    const node = strip.current;
    const scroller = node?.closest('.timeline');
    if (!node || !scroller || !url) return;
    let frame = 0;

    function measure() {
      frame = 0;
      const bounds = node!.getBoundingClientRect();
      const view = scroller!.getBoundingClientRect();
      const intersects = bounds.top < view.bottom && bounds.bottom > view.top &&
        bounds.left < view.right && bounds.right > view.left && bounds.width > 0;
      const { from, to } = intersects ? cellRangeInView({
        stripLeft: bounds.left, stripWidth: bounds.width, cssWidth: width,
        viewLeft: view.left, viewRight: view.right, count: Math.ceil(width / THUMB_W),
      }) : { from: 0, to: -1 };
      setRange(previous => previous.from === from && previous.to === to ? previous : { from, to });
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    resize.observe(node);
    const visibility = new IntersectionObserver(schedule, { root: scroller });
    visibility.observe(node);
    scroller.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      scroller.removeEventListener('scroll', schedule);
    };
  }, [url, width]);

  if (!url) return null;
  const tiles = [];
  for (let index = range.from; index <= range.to && index * THUMB_W < width; index++) {
    const left = index * THUMB_W;
    const ms = frameMsAt(sourceIn + left / pps * speed, Number.isFinite(sourceOut) ? sourceOut : null);
    tiles.push(createElement(SceneTile, { key: index, url, left, ms }));
  }
  return createElement('div', {
    ref: strip, className: 'tl-clip-strip tl-clip-strip-scene', 'data-testid': 'scene-filmstrip', 'aria-hidden': true,
  }, tiles);
}
