/** Tabler Icons 3.52.0 (MIT). Presentation only; button names and handlers live in their original components. */
import { createElement } from 'react';
import type { CSSProperties, ReactNode } from 'react';

const sources = {
  // Original creation-library symbols share the existing 24px icon grid.
  'media-library': new URL('../assets/creation-icons/media-library.svg', import.meta.url).href,
  'skill': new URL('../assets/creation-icons/skill.svg', import.meta.url).href,
  'waveform': new URL('../assets/creation-icons/waveform.svg', import.meta.url).href,
  'sticker': new URL('../assets/creation-icons/sticker.svg', import.meta.url).href,
  'pointer': new URL('../assets/editor-icons/pointer.svg', import.meta.url).href,
  'select': new URL('../assets/editor-icons/select.svg', import.meta.url).href,
  'cut': new URL('../assets/editor-icons/cut.svg', import.meta.url).href,
  'trash': new URL('../assets/editor-icons/trash.svg', import.meta.url).href,
  'magnet': new URL('../assets/editor-icons/magnet.svg', import.meta.url).href,
  'ripple': new URL('../assets/editor-icons/arrows-right-left.svg', import.meta.url).href,
  'grid': new URL('../assets/editor-icons/grid-dots.svg', import.meta.url).href,
  'prev-frame': new URL('../assets/editor-icons/player-skip-back.svg', import.meta.url).href,
  'next-frame': new URL('../assets/editor-icons/player-skip-forward.svg', import.meta.url).href,
  'zoom-out': new URL('../assets/editor-icons/zoom-out.svg', import.meta.url).href,
  'zoom-in': new URL('../assets/editor-icons/zoom-in.svg', import.meta.url).href,
  'fit': new URL('../assets/editor-icons/arrows-maximize.svg', import.meta.url).href,
  'search': new URL('../assets/editor-icons/search.svg', import.meta.url).href,
  'settings': new URL('../assets/editor-icons/adjustments-horizontal.svg', import.meta.url).href,
  'lock': new URL('../assets/editor-icons/lock.svg', import.meta.url).href,
  'unlock': new URL('../assets/editor-icons/lock-open.svg', import.meta.url).href,
  'eye': new URL('../assets/editor-icons/eye.svg', import.meta.url).href,
  'eye-off': new URL('../assets/editor-icons/eye-off.svg', import.meta.url).href,
  'volume': new URL('../assets/editor-icons/volume.svg', import.meta.url).href,
  'volume-off': new URL('../assets/editor-icons/volume-off.svg', import.meta.url).href,
  'solo': new URL('../assets/editor-icons/headphones.svg', import.meta.url).href,
  'chevron-down': new URL('../assets/editor-icons/chevron-down.svg', import.meta.url).href,
  'undo': new URL('../assets/editor-icons/arrow-back-up.svg', import.meta.url).href,
  'redo': new URL('../assets/editor-icons/arrow-forward-up.svg', import.meta.url).href,
  'more': new URL('../assets/editor-icons/dots.svg', import.meta.url).href,
  'project': new URL('../assets/editor-icons/folder-open.svg', import.meta.url).href,
  'versions': new URL('../assets/editor-icons/history.svg', import.meta.url).href,
  'export': new URL('../assets/editor-icons/upload.svg', import.meta.url).href,
  'layout': new URL('../assets/editor-icons/layout.svg', import.meta.url).href,
  'agent': new URL('../assets/editor-icons/message-circle.svg', import.meta.url).href,
  'motion': new URL('../assets/editor-icons/sparkles.svg', import.meta.url).href,
  'refresh': new URL('../assets/editor-icons/refresh.svg', import.meta.url).href,
  'play': new URL('../assets/editor-icons/player-play.svg', import.meta.url).href,
  'pause': new URL('../assets/editor-icons/player-pause.svg', import.meta.url).href,
  'home': new URL('../assets/editor-icons/player-track-prev.svg', import.meta.url).href,
  'end': new URL('../assets/editor-icons/player-track-next.svg', import.meta.url).href,
  'loop': new URL('../assets/editor-icons/repeat.svg', import.meta.url).href,
  'maximize': new URL('../assets/editor-icons/maximize.svg', import.meta.url).href,
  'minimize': new URL('../assets/editor-icons/minimize.svg', import.meta.url).href,
  'ratio': new URL('../assets/editor-icons/aspect-ratio.svg', import.meta.url).href,
  'stop': new URL('../assets/editor-icons/square.svg', import.meta.url).href,
  'microphone': new URL('../assets/editor-icons/microphone.svg', import.meta.url).href,
  'link': new URL('../assets/editor-icons/link.svg', import.meta.url).href,
  'unlink': new URL('../assets/editor-icons/unlink.svg', import.meta.url).href,
  'photo': new URL('../assets/editor-icons/photo.svg', import.meta.url).href,
  'music': new URL('../assets/editor-icons/music.svg', import.meta.url).href,
  'text': new URL('../assets/editor-icons/typography.svg', import.meta.url).href,
  'subtitles': new URL('../assets/editor-icons/subtitles.svg', import.meta.url).href,
  'transition': new URL('../assets/editor-icons/transition-right.svg', import.meta.url).href,
  'layers': new URL('../assets/editor-icons/layers-intersect.svg', import.meta.url).href,
  'batch': new URL('../assets/editor-icons/arrows-right-left.svg', import.meta.url).href,
} as const;

export type EditorIconName = keyof typeof sources;

export function editorIcon(name: EditorIconName, size = 16): ReactNode {
  return createElement('span', {
    className: 'editor-icon', 'aria-hidden': 'true', 'data-editor-icon': name,
    style: { width: size, height: size, maskImage: `url("${sources[name]}")`, WebkitMaskImage: `url("${sources[name]}")` } as CSSProperties,
  });
}
