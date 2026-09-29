import { useEffect, useState } from 'react';
import { noteRender } from '../core/telemetry';

/**
 * Fullscreen toggle. On entering, also tries to lock landscape — browsers only
 * allow that while fullscreen (Android Chrome yes, iPad Safari no).
 *
 * iPhone Safari (and some in-app browsers) can't make a PAGE fullscreen at all.
 * There the button explains the other way in: Add to Home Screen — the web
 * manifest then launches it fullscreen + landscape. Already launched that way → hidden.
 */
export function FullscreenButton() {
  noteRender();
  const [on, setOn] = useState(isFullscreen());
  const [tip, setTip] = useState(false);

  useEffect(() => {
    const onChange = () => setOn(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  if (isStandalone()) return null; // opened from the home screen: already fullscreen

  const toggle = async () => {
    if (!canFullscreen()) {
      setTip((t) => !t);
      return;
    }
    try {
      if (isFullscreen()) {
        await (document.exitFullscreen?.() ?? (document as WebkitDoc).webkitExitFullscreen?.());
        return;
      }
      const root = document.documentElement as WebkitEl;
      await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen?.());
      // Best effort: not supported everywhere, and that's fine.
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {});
    } catch {
      setTip(true); // refused — show the home-screen route instead
    }
  };

  return (
    <span className="fs">
      <button type="button" className="fs__btn" onClick={() => void toggle()}>
        {on ? '⤢ Exit fullscreen' : '⛶ Fullscreen'}
      </button>
      {tip && (
        <span className="fs__tip" onClick={() => setTip(false)}>
          This browser can't go fullscreen from a page. Use <b>Share → Add to Home Screen</b> (Safari) or{' '}
          <b>⋮ → Add to Home screen</b> (Chrome), then open it from the home screen — it starts fullscreen and
          landscape. Tap to close.
        </span>
      )}
    </span>
  );
}

type WebkitDoc = Document & { webkitExitFullscreen?: () => Promise<void>; webkitFullscreenElement?: Element | null };
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

function isFullscreen(): boolean {
  return !!(document.fullscreenElement ?? (document as WebkitDoc).webkitFullscreenElement);
}

function canFullscreen(): boolean {
  const root = document.documentElement as WebkitEl;
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

function isStandalone(): boolean {
  return (
    matchMedia('(display-mode: fullscreen)').matches ||
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
