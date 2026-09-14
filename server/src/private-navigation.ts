import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProtectedPasteBridge } from './protected-paste.js';

/** Deliberately narrow: existing Finance QBO publisher -> existing profile bridge.
 * No URL/path in tool arguments; no page result or exception can escape this seam.
 */
export async function navigatePrivateQboFile(
  bridge: ProtectedPasteBridge, profile: string | null, socketPath: string, pageId: number,
): Promise<string> {
  let bytes: Buffer | null = null;
  try {
    if (profile !== 'finance' || !Number.isSafeInteger(pageId) || pageId <= 0) return 'ERROR\n';
    const socketDir = dirname(resolve(socketPath));
    const cache = dirname(socketDir);
    if (!cache.endsWith('/profiles/finance/cache') || socketDir !== join(cache, 'vibe-mcp')) return 'ERROR\n';
    const directory = join(cache, 'qbo-oauth-state');
    const file = join(directory, 'authorization-url');
    for (const dir of [socketDir, directory]) {
      const st = await lstat(dir);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) || await realpath(dir) !== dir) return 'ERROR\n';
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.nlink !== 1 || st.size < 1 || st.size > 16_384) return 'ERROR\n';
      bytes = Buffer.alloc(16_385);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== st.size) return 'ERROR\n';
      const url = new URL(bytes.subarray(0, bytesRead).toString('utf8').trim());
      if (url.origin !== 'https://appcenter.intuit.com' || url.pathname !== '/connect/oauth2' || url.username || url.password || url.hash) return 'ERROR\n';
      const expected = { response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: 'https://qbo-oauth.aoclabs.ai/callback' };
      for (const [key, value] of Object.entries(expected)) {
        if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) return 'ERROR\n';
      }
      for (const key of ['state', 'client_id']) {
        if (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)) return 'ERROR\n';
      }
      if ([...url.searchParams.keys()].some(key => !['response_type','scope','redirect_uri','state','client_id'].includes(key))) return 'ERROR\n';
      // Unlink before dispatch: timeouts cannot cause an accidental repeated navigation.
      const current = await lstat(file);
      if (current.ino !== st.ino || current.dev !== st.dev) return 'ERROR\n';
      await unlink(file);
      const result = await bridge.callTool('navigate_page', { type: 'url', pageId, url: url.toString(), timeoutMs: 25_000 }, 30_000);
      return result.isError ? 'ERROR\n' : 'NAVIGATED\n';
    } finally { await handle.close(); }
  } catch { return 'ERROR\n'; }
  finally { bytes?.fill(0); }
}
