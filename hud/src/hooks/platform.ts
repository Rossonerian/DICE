import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isSafeExternalUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return false;
    if (!parsed.hostname) return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    return true;
  } catch {
    return false;
  }
}

export async function openExternal(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false;
  if (isTauri()) {
    try {
      await openUrl(url);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    return win !== null;
  } catch {
    return false;
  }
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

export function normalizeUrl(u: unknown = ''): string {
  if (typeof u !== 'string') return '';
  return u.trim().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
}

export function hostOf(u: unknown = ''): string {
  if (typeof u !== 'string') return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
