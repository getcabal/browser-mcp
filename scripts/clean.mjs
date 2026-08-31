import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await rm(resolve(root, 'server/dist'), { recursive: true, force: true });
await rm(resolve(root, 'dist'), { recursive: true, force: true });
console.log('Removed server/dist and dist');
