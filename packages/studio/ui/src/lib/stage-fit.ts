/**
 * 画幅适配（副线1 · WP13 / NEW-03）
 *
 * 工程画布（stage，场景 px）放进任意尺寸的容器时的**真实画面框**：
 * - contain：整幅可见，短边受限，四周 letterbox；
 * - cover：填满容器，超出部分裁掉（画面框可能大于容器，x/y 为负）。
 *
 * 覆盖、选中框、吸附、命中测试都必须用**画面框坐标系**（stage px），
 * 不能直接拿容器坐标当场景坐标 —— 否则点黑边会选中层、点画面内会偏移。
 *
 * 纯函数：不读 DOM、不读时钟。DOM 只负责把计算出的框画出来（见 stage-fit.html 夹具）。
 */

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface ClientPoint {
  readonly x: number;
  readonly y: number;
}

export interface BaseRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PictureFrame extends BaseRect {
  readonly stage: Size;
  readonly container: Size;
  readonly fit: 'contain' | 'cover';
  /** 容器 px / 场景 px。 */
  readonly scale: number;
}

export const FIT_EPS = 1e-9;

/** 画面框：contain 取较小比例，cover 取较大比例；两者都保持宽高比。 */
export function pictureFrame(stage: Size, container: Size, fit: 'contain' | 'cover' = 'contain'): PictureFrame {
  if (!(stage.w > 0) || !(stage.h > 0) || !(container.w > 0) || !(container.h > 0)) {
    throw new RangeError(`非法尺寸：stage=${stage.w}x${stage.h} container=${container.w}x${container.h}`);
  }
  const sx = container.w / stage.w;
  const sy = container.h / stage.h;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = stage.w * scale;
  const h = stage.h * scale;
  return {
    x: (container.w - w) / 2,
    y: (container.h - h) / 2,
    w,
    h,
    scale,
    stage,
    container,
    fit
  };
}

/** 容器坐标 → 场景坐标（可能落在 [0,stage] 之外：cover 时被裁掉的区域）。 */
export function clientToStage(frame: PictureFrame, p: ClientPoint): ClientPoint {
  return { x: (p.x - frame.x) / frame.scale, y: (p.y - frame.y) / frame.scale };
}

/** 场景坐标 → 容器坐标。 */
export function stageToClient(frame: PictureFrame, p: ClientPoint): ClientPoint {
  return { x: frame.x + p.x * frame.scale, y: frame.y + p.y * frame.scale };
}

/** 点是否真的落在画面上：既在容器内，又映射进 [0,stage]（cover 时排除被裁掉的部分）。 */
export function insidePicture(frame: PictureFrame, p: ClientPoint): boolean {
  if (p.x < 0 || p.y < 0 || p.x > frame.container.w || p.y > frame.container.h) return false;
  const s = clientToStage(frame, p);
  return s.x >= -FIT_EPS && s.y >= -FIT_EPS && s.x <= frame.stage.w + FIT_EPS && s.y <= frame.stage.h + FIT_EPS;
}

/** letterbox（画面外的容器区域）；cover 时四边为 0。 */
export function letterbox(frame: PictureFrame): { top: number; right: number; bottom: number; left: number } {
  return {
    top: Math.max(0, frame.y),
    left: Math.max(0, frame.x),
    right: Math.max(0, frame.container.w - (frame.x + frame.w)),
    bottom: Math.max(0, frame.container.h - (frame.y + frame.h))
  };
}

/** 画面在容器内的可见矩形（cover 时被裁）。 */
export function visibleRect(frame: PictureFrame): BaseRect {
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(frame.container.w, frame.x + frame.w);
  const bottom = Math.min(frame.container.h, frame.y + frame.h);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/** 画面内的归一化坐标（0..1）；改画幅时覆盖用它保持“贴在画面上同一个位置”。 */
export function stageFraction(frame: PictureFrame, p: ClientPoint): { fx: number; fy: number } {
  return { fx: (p.x - frame.x) / frame.w, fy: (p.y - frame.y) / frame.h };
}

/** 由归一化坐标回到容器坐标。 */
export function clientAtFraction(frame: PictureFrame, fx: number, fy: number): ClientPoint {
  return { x: frame.x + fx * frame.w, y: frame.y + fy * frame.h };
}

/** 两个画面框是否相同（默认 1e-6 px）。 */
export function sameFrame(a: PictureFrame, b: PictureFrame, eps = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.w - b.w) <= eps &&
    Math.abs(a.h - b.h) <= eps &&
    Math.abs(a.scale - b.scale) <= eps
  );
}

/** 容器尺寸不变、工程画布换了形状：返回新画面框（覆盖只需按归一化坐标重投影）。 */
export function refitStage(frame: PictureFrame, nextStage: Size): PictureFrame {
  return pictureFrame(nextStage, frame.container, frame.fit);
}
