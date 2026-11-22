// Copy products.json from a local data-branch checkout (default ../../../asc-data/latest) into public/data for `pnpm dev`.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? resolve(here, '../../../../asc-data/latest/products.json'));
const dest = resolve(here, '../public/data/products.json');
await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied ${src} -> ${dest}`);
