#!/usr/bin/env node
/**
 * Deterministic extension packager for fleet deployment.
 *
 * Produces dist/local-browser-extension-<version>.zip (the unstamped base)
 * and, for each requested profile, a stamped directory + zip whose config.js
 * carries that profile's port and name. Zips use the store method with fixed
 * 1980 timestamps and sorted entries, so identical sources always produce
 * byte-identical archives (verifiable via the .sha256 sidecars).
 *
 * Usage:
 *   node scripts/package-extension.mjs
 *   node scripts/package-extension.mjs --profile alpha:19901 --profile beta:19902
 *   node scripts/package-extension.mjs --profiles fleet.json   # [{"name":"alpha","port":19901}, ...]
 *   node scripts/package-extension.mjs --output-dir /tmp/browser-mcp-dist --profile test:21901
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Sorted allowlist — the complete deployable extension. */
const EXTENSION_FILES = [
  'background.js',
  'config.js',
  'handshake.js',
  'manifest.json',
  'options.html',
  'options.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'redaction.js',
  'tools.js',
];

function fail(message) {
  console.error(`package-extension: ${message}`);
  process.exit(1);
}

// --- Version-sync preflight -------------------------------------------------

const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(await readFile(join(root, 'server/package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
const contractSource = await readFile(join(root, 'server/src/contract.ts'), 'utf8');
const contractVersion = contractSource.match(/VERSION = '([^']+)'/)?.[1];
const versions = { 'package.json': rootPkg.version, 'server/package.json': serverPkg.version, 'extension/manifest.json': manifest.version, 'server/src/contract.ts': contractVersion };
if (new Set(Object.values(versions)).size !== 1) {
  fail(`version mismatch across sources: ${JSON.stringify(versions)}`);
}
const version = manifest.version;

// --- Profile arguments ------------------------------------------------------

const profiles = [];
let outputDir = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--output-dir') {
    const path = argv[++i];
    if (!path) fail('--output-dir requires a path');
    outputDir = resolve(path);
  } else if (arg === '--profile') {
    const spec = argv[++i] ?? '';
    const match = spec.match(/^([^:]+):(\d+)$/);
    if (!match) fail(`--profile expects name:port, got "${spec}"`);
    profiles.push({ name: match[1], port: Number(match[2]) });
  } else if (arg === '--profiles') {
    const file = argv[++i];
    if (!file) fail('--profiles requires a JSON file path');
    const parsed = JSON.parse(await readFile(resolve(file), 'utf8'));
    if (!Array.isArray(parsed)) fail(`--profiles file must contain a JSON array`);
    for (const entry of parsed) profiles.push({ name: entry.name, port: Number(entry.port) });
  } else {
    fail(`unknown option: ${arg}`);
  }
}
const distDir = outputDir ?? join(root, 'dist');
for (const profile of profiles) {
  if (typeof profile.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(profile.name)) {
    fail(`invalid profile name "${profile.name}" (use letters, digits, dot, dash, underscore)`);
  }
  if (!Number.isInteger(profile.port) || profile.port < 1024 || profile.port > 65535) {
    fail(`invalid port ${profile.port} for profile "${profile.name}" (1024-65535)`);
  }
}
if (new Set(profiles.map((p) => p.name)).size !== profiles.length) fail('profile names must be unique');
if (new Set(profiles.map((p) => p.port)).size !== profiles.length) fail('profile ports must be unique');

// --- Deterministic zip writer (store method, fixed timestamps) --------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980 = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME_MIDNIGHT = 0;

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store method
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal attrs, external attrs already zero
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

// --- Content helpers --------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const stampedConfig = (port, name) =>
  `/**\n * Per-profile deployment configuration. Stamped by scripts/package-extension.mjs;\n * locked fleet routes cannot be overridden through chrome.storage.local.\n */\nexport default Object.freeze(${JSON.stringify({ port, profile: name, locked: true })});\n`;

async function loadEntries(configOverride) {
  const entries = [];
  for (const name of EXTENSION_FILES) {
    const data = name === 'config.js' && configOverride !== null
      ? Buffer.from(configOverride, 'utf8')
      : await readFile(join(root, 'extension', name));
    entries.push({ name, data });
  }
  return entries;
}

const dirHash = (entries) =>
  sha256(entries.map((entry) => `${entry.name}  ${sha256(entry.data)}\n`).join(''));

async function emit(entries, zipName) {
  const zip = buildZip(entries);
  const second = buildZip(entries);
  if (!zip.equals(second)) fail(`zip build for ${zipName} is not deterministic`);
  const zipPath = join(distDir, zipName);
  await writeFile(zipPath, zip);
  const digest = sha256(zip);
  await writeFile(`${zipPath}.sha256`, `${digest}  ${zipName}\n`);
  return { zip: zipName, sha256: digest, dirHash: dirHash(entries) };
}

// --- Build ------------------------------------------------------------------

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const baseEntries = await loadEntries(null);
const base = await emit(baseEntries, `local-browser-extension-${version}.zip`);
console.log(`base      ${base.zip}  sha256=${base.sha256.slice(0, 16)}…  dirHash=${base.dirHash.slice(0, 16)}…`);

const artifactProfiles = [];
for (const profile of profiles) {
  const entries = await loadEntries(stampedConfig(profile.port, profile.name));
  const profileDir = join(distDir, 'profiles', profile.name);
  await mkdir(profileDir, { recursive: true });
  for (const entry of entries) await writeFile(join(profileDir, entry.name), entry.data);
  const emitted = await emit(entries, `local-browser-extension-${version}-${profile.name}.zip`);
  artifactProfiles.push({
    name: profile.name,
    port: profile.port,
    dir: relative(root, profileDir),
    ...emitted,
  });
  console.log(`profile   ${profile.name} (port ${profile.port})  ${emitted.zip}  sha256=${emitted.sha256.slice(0, 16)}…`);
}

const artifacts = {
  version,
  files: EXTENSION_FILES,
  base,
  profiles: artifactProfiles,
};
await writeFile(join(distDir, 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
console.log(`wrote dist/artifacts.json (version ${version}, ${artifactProfiles.length} profile(s))`);
console.log('verify an installed copy with: npm run doctor -- --extension-dir <path>');
