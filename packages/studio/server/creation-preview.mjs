/** Isolated resource preview: owns only its iframe, never a Studio capability. */
export function creationPreviewScript(motion = false) {
  return `<script>(${resourcePreview.toString()})(${motion === true});<` + `/script>`;
}

/** @param {boolean} motion */
function resourcePreview(motion) {
  let running = motion, time = motion ? 0 : 1, duration = 6, parentDuration = false, previous = performance.now(), drawing = false;
  let readyToSample = false, hasSampleTime = false;
  const film = () => /** @type {any} */ (window).film;
  function fit() {
    const meta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    const w = Number(/width=(\d+)/.exec(meta)?.[1]) || 1280;
    const h = Number(/height=(\d+)/.exec(meta)?.[1]) || Math.round(w * 9 / 16);
    const scale = Math.min(innerWidth / w, innerHeight / h);
    document.documentElement.style.setProperty('width', '100%', 'important');
    document.documentElement.style.setProperty('height', '100%', 'important');
    document.documentElement.style.setProperty('background', 'repeating-conic-gradient(#242424 0% 25%,#303030 0% 50%) 0 0 / 16px 16px', 'important');
    Object.assign(document.body.style, { width: w + 'px', height: h + 'px', position: 'absolute', margin: '0', transformOrigin: '0 0', transform: `translate(${(innerWidth - w * scale) / 2}px,${(innerHeight - h * scale) / 2}px) scale(${scale})` });
  }
  async function draw() {
    if (drawing) return;
    drawing = true;
    const sample = time;
    try {
      await film()?.frame?.(sample);
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = sample * 1000; }
      for (const node of document.querySelectorAll('video,audio')) {
        const media = /** @type {HTMLMediaElement} */ (node);
        media.pause();
        if (Number.isFinite(media.duration) && Math.abs(media.currentTime - sample) > .03) media.currentTime = Math.min(sample, Math.max(0, media.duration - .01));
      }
    } finally {
      drawing = false;
      if (!motion && sample !== time) void draw().catch(() => {});
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    if (!motion) {
      if (event.data?.type !== 'opencut:thumbnail-time' || !Number.isSafeInteger(event.data.ms) || event.data.ms < 0) return;
      time = event.data.ms / 1000;
      hasSampleTime = true;
      if (readyToSample) void draw().catch(() => {});
      return;
    }
    if (event.data?.type !== 'opencut:resource-preview-control') return;
    if (Number.isFinite(event.data.duration) && event.data.duration > 0) { duration = Math.min(86400, event.data.duration); parentDuration = true; }
    time = Math.min(time, duration);
    if (Number.isFinite(event.data.time)) time = Math.max(0, Math.min(duration, event.data.time));
    if (typeof event.data.playing === 'boolean') running = event.data.playing;
    previous = performance.now();
    void draw().catch(() => {});
  });
  fit(); new ResizeObserver(fit).observe(document.documentElement);
  const ready = film()?.ready;
  Promise.resolve(typeof ready === 'function' ? ready.call(film()) : ready).then(() => {
    const metaDuration = Number(film()?.meta?.duration);
    if (!parentDuration && metaDuration > 0 && Number.isFinite(metaDuration)) duration = Math.min(86400, metaDuration);
    if (!motion && !hasSampleTime && Number.isFinite(film()?.meta?.previewTime)) time = Math.max(0, Math.min(duration, film().meta.previewTime));
    readyToSample = true;
    void draw().catch(() => {});
    if (!motion) return;
    /** @param {number} now */
    function tick(now) {
      const elapsed = Math.min(.1, Math.max(0, (now - previous) / 1000)); previous = now;
      if (running) { time = (time + elapsed) % duration; void draw().catch(() => {}); }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch(() => {});
}
