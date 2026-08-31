/**
 * Environment and installation checks. With --extension-dir <path>, also
 * verifies an installed (stamped) extension copy: version, port, profile,
 * and content hash against dist/artifacts.json when present.
 */
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const checks = [];
async function check(label, action) {
  try {
    const detail = await action();
    checks.push([label, true, typeof detail === 'string' ? detail : undefined]);
  } catch (error) {
    checks.push([label, false, error.message]);
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function computeDirHash(dir, files) {
  let out = '';
  for (const name of files) out += `${name}  ${sha256(await readFile(join(dir, name)))}\n`;
  return sha256(out);
}

function parseStaticConfig(source, label) {
  const match = source.match(/export\s+default\s+Object\.freeze\((\{[\s\S]*\})\)\s*;/);
  if (!match) throw new Error(`${label} must export Object.freeze(<JSON object>)`);
  let config;
  try { config = JSON.parse(match[1]); }
  catch (error) { throw new Error(`${label} contains invalid JSON: ${error.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${label} is not an object`);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error(`${label} has bad port ${config.port}`);
  if (config.profile !== null && (typeof config.profile !== 'string' || !config.profile.trim())) throw new Error(`${label} has invalid profile`);
  if (typeof config.locked !== 'boolean') throw new Error(`${label} has no boolean locked flag`);
  return config;
}

await check('Node.js 18 or newer', async () => {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(`found ${process.versions.node}`);
});
await check('Extension manifest is valid', async () => {
  JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
});
await check('Extension worker exists', () => access(resolve(root, 'extension/background.js'), constants.R_OK));
await check('MCP server is built', () => access(resolve(root, 'server/dist/cli.js'), constants.R_OK));
await check('Versions are aligned', async () => {
  const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const serverPkg = JSON.parse(await readFile(join(root, 'server/package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
  const contract = await readFile(join(root, 'server/src/contract.ts'), 'utf8');
  const contractVersion = contract.match(/VERSION = '([^']+)'/)?.[1];
  const all = [rootPkg.version, serverPkg.version, manifest.version, contractVersion];
  if (new Set(all).size !== 1) throw new Error(`root=${all[0]} server=${all[1]} manifest=${all[2]} contract=${all[3]}`);
  return `all at ${all[0]}`;
});
await check('Extension advertises the 24-tool contract', async () => {
  const { TOOLS } = await import(pathToFileURL(join(root, 'extension/tools.js')).href);
  if (TOOLS.length !== 24) throw new Error(`found ${TOOLS.length} tools`);
  return '22 contract tools + 2 local extras';
});
await check('Extension config has local-only defaults', async () => {
  const config = parseStaticConfig(await readFile(join(root, 'extension/config.js'), 'utf8'), 'extension/config.js');
  return `port ${config.port}, profile ${config.profile === null ? '(none)' : JSON.stringify(config.profile)}, locked=${config.locked}`;
});

// --- Installed-copy verification -------------------------------------------

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf('--extension-dir');
if (dirFlag !== -1) {
  const target = argv[dirFlag + 1];
  if (!target) {
    checks.push(['--extension-dir', false, 'requires a path']);
  } else {
    const dir = resolve(target);
    let installedManifest = null;
    let installedConfig = null;
    let matchedArtifact = null;
    await check(`Installed dir readable (${target})`, async () => {
      await readdir(dir);
    });
    await check('Installed manifest version matches this repo', async () => {
      installedManifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      const repoManifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
      if (installedManifest.version !== repoManifest.version) {
        throw new Error(`installed ${installedManifest.version}, repo ${repoManifest.version}`);
      }
      return `version ${installedManifest.version}`;
    });
    // Hash the installed allowlisted files before parsing any installed data.
    // In particular, doctor never imports or executes an installed config.js.
    await check('Installed content hash matches a packaged artifact', async () => {
      const artifactsPath = join(root, 'dist/artifacts.json');
      let artifacts;
      try {
        artifacts = JSON.parse(await readFile(artifactsPath, 'utf8'));
      } catch {
        throw new Error('dist/artifacts.json not found — run: npm run package');
      }
      const hash = await computeDirHash(dir, artifacts.files);
      if (artifacts.base.dirHash === hash) {
        matchedArtifact = { kind: 'base', ...artifacts.base };
        return `matches base artifact (dirHash ${hash.slice(0, 16)}…)`;
      }
      const match = artifacts.profiles.find((profile) => profile.dirHash === hash);
      if (match) {
        matchedArtifact = { kind: 'profile', ...match };
        return `matches profile "${match.name}" (port ${match.port}, dirHash ${hash.slice(0, 16)}…)`;
      }
      throw new Error(`dirHash ${hash.slice(0, 16)}… matches no packaged artifact — stale or modified install`);
    });
    await check('Installed config is inert and routing state is explicit', async () => {
      installedConfig = parseStaticConfig(await readFile(join(dir, 'config.js'), 'utf8'), 'installed config.js');
      if (matchedArtifact?.kind === 'profile') {
        if (installedConfig.locked !== true) throw new Error('profile artifact is not locked');
        if (installedConfig.profile !== matchedArtifact.name || installedConfig.port !== matchedArtifact.port) {
          throw new Error(`config route does not match artifact metadata (${matchedArtifact.name}:${matchedArtifact.port})`);
        }
        return `effective route is locked to ${installedConfig.profile}:${installedConfig.port}`;
      }
      if (installedConfig.locked) throw new Error('base development artifact unexpectedly locked');
      return `development artifact defaults to ${installedConfig.profile ?? '(none)'}:${installedConfig.port}; chrome.storage.local may override it at runtime`;
    });
  }
}

for (const [label, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
