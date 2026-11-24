import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri()) {
    try {
      await openUrl(url);
      return;
    } catch {
      /* fall through to window.open */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

let simulated = 94;
export async function getHudMemoryMb(): Promise<number> {
  if (isTauri()) {
    try {
      const v = await invoke<number>('get_hud_memory_mb');
      if (typeof v === 'number' && isFinite(v)) return Math.round(v * 10) / 10;
    } catch {
      /* fall back */
    }
  }
  simulated = Math.max(88, Math.min(99, simulated + (Math.random() - 0.5) * 1.2));
  return Math.round(simulated * 10) / 10;
}

export function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
