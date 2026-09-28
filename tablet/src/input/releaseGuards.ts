/**
 * Global "let go of everything" triggers. A missed pointerup must never leave
 * throttle held, so anything that can swallow one releases all touch input:
 *
 *   window blur          another app / notification took focus
 *   visibilitychange     tab hidden, screen locked
 *   pagehide             navigating away / closing
 *
 * Hidden or leaving also disarms — the driver can't see the screen any more.
 */

import { releaseAllTouch } from './touchState';

export function installReleaseGuards(disarm: () => void): () => void {
  const onBlur = () => releaseAllTouch();
  const onHide = () => {
    releaseAllTouch();
    disarm();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') onHide();
  };

  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
