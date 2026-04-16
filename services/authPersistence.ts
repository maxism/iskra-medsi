import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_KEY = '@mtsdengi_auth_v1';
const MAX_LS_VALUE_LEN = 4096; // skip bloated values (base64 images, etc.)
const MAX_LS_KEYS = 50;

export interface AuthSnapshot {
  cookies: string;
  localStorage: Record<string, string>;
  savedAt: number;
}

export async function saveAuthSnapshot(snapshot: AuthSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(snapshot));
    console.log('[Auth] Saved. localStorage keys:', Object.keys(snapshot.localStorage).length);
  } catch (e) {
    console.warn('[Auth] Save failed:', e);
  }
}

export async function loadAuthSnapshot(): Promise<AuthSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as AuthSnapshot;
    console.log('[Auth] Loaded snapshot from', new Date(snap.savedAt).toLocaleString('ru-RU'));
    return snap;
  } catch (e) {
    console.warn('[Auth] Load failed:', e);
    return null;
  }
}

export async function clearAuthSnapshot(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_KEY);
}

/**
 * Builds a compact JS string that restores auth state into a fresh WebView.
 * Designed to run inside injectedJavaScriptBeforeContentLoaded — before page scripts.
 */
export function buildAuthRestoreScript(snapshot: AuthSnapshot): string {
  const parts: string[] = ['(function(){'];

  // Restore localStorage keys
  let count = 0;
  for (const [key, value] of Object.entries(snapshot.localStorage)) {
    if (count >= MAX_LS_KEYS) break;
    if (value.length > MAX_LS_VALUE_LEN) continue;
    // JSON.stringify handles all escaping — no manual \n issues
    parts.push(
      'try{localStorage.setItem(' +
        JSON.stringify(key) + ',' +
        JSON.stringify(value) +
      ');}catch(e){}'
    );
    count++;
  }

  // Restore accessible (non-HTTP-only) cookies
  if (snapshot.cookies) {
    const pairs = snapshot.cookies
      .split(';')
      .map(function (c) { return c.trim(); })
      .filter(Boolean);
    for (const pair of pairs) {
      parts.push(
        'try{document.cookie=' + JSON.stringify(pair + '; path=/') + ';}catch(e){}'
      );
    }
  }

  parts.push('})();');
  return parts.join('');
}
