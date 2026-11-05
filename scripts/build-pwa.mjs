// No runtime caching or third-party build plugin. The exact build is the cache version.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildPwa(directory = resolve(root, 'apps/web/dist')) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((file) => file.isFile() && file.name !== 'sw.js')
    .map((file) => relative(directory, resolve(file.parentPath, file.name)).replaceAll('\\', '/')).sort();
  const template = await readFile(resolve(root, 'apps/web/sw.js'), 'utf8');
  const hash = createHash('sha256').update(template);
  for (const file of files) hash.update(file).update(await readFile(resolve(directory, file)));
  const version = hash.digest('hex').slice(0, 24);
  const worker = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files.map((file) => `/${file}`)));
  await writeFile(resolve(directory, 'sw.js'), worker);
  return version;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPwa();
