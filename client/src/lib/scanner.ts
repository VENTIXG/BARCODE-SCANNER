/**
 * Barcode scanner support.
 *
 * USB / Bluetooth scanners in HID (keyboard wedge) mode "type" the code very
 * fast and finish with Enter (or Tab). Scanner screens use a focused input;
 * this module additionally catches scans typed while no input has focus, by
 * detecting fast keystroke bursts on the window.
 */
import { useEffect, useRef } from 'react';

const MAX_KEY_GAP_MS = 50; // human typing is much slower than this
const MIN_LENGTH = 3;

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** Calls `onScan` when a scanner burst is typed while focus is not in a form field. */
export function useGlobalScan(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    let buffer = '';
    let last = 0;
    let fastKeys = 0;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(document.activeElement) || e.ctrlKey || e.altKey || e.metaKey) return;
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buffer.length >= MIN_LENGTH && fastKeys >= buffer.length - 1) {
          e.preventDefault();
          const code = buffer;
          buffer = '';
          fastKeys = 0;
          cb.current(code);
        } else {
          buffer = '';
          fastKeys = 0;
        }
        return;
      }
      if (e.key.length !== 1) return;
      if (gap > MAX_KEY_GAP_MS) {
        buffer = e.key;
        fastKeys = 0;
      } else {
        buffer += e.key;
        fastKeys++;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

// ---- Audio feedback -------------------------------------------------------------

let ctx: AudioContext | null = null;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem('ims-sound') !== 'off';
  } catch {
    return true;
  }
}
export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem('ims-sound', on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

function tone(freq: number, start: number, duration: number, volume = 0.08) {
  if (!ctx) ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.value = volume;
  osc.connect(gain).connect(ctx.destination);
  const t = ctx.currentTime + start;
  osc.start(t);
  osc.stop(t + duration);
}

export function beep(kind: 'ok' | 'error' | 'warn' = 'ok') {
  if (!soundEnabled()) return;
  try {
    if (kind === 'ok') tone(1400, 0, 0.07);
    else if (kind === 'warn') (tone(700, 0, 0.1), tone(700, 0.15, 0.1));
    else (tone(220, 0, 0.18, 0.1), tone(180, 0.22, 0.25, 0.1));
  } catch {
    /* audio not available */
  }
}
