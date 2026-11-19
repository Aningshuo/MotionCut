/// <reference types="vite/client" />

import { createElement as h } from 'react';
import { editorIcon } from './editor-icons';

export function motionCutMark(className: string) {
  const props = { className, 'aria-hidden': true, 'data-testid': 'brand-logo' };
  const logoUrl = import.meta.env.VITE_MOTIONCUT_BRAND_URL;
  return logoUrl
    ? h('img', { ...props, src: logoUrl, alt: '' })
    : h('span', props, editorIcon('media-library', 23));
}
