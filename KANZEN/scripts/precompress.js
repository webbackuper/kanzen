// Précompression gzip (niveau 9) des fichiers du build : servis tels quels par nginx (gzip_static)
// ou par @fastify/static (preCompressed). Aucune dépendance : zlib de Node.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(process.argv[2] ?? 'dist');
const EXT = /\.(js|css|html|svg|json|txt|map)$/;
let n = 0; let before = 0; let after = 0;
for (const f of fs.readdirSync(root, { recursive: true })) {
  const p = path.join(root, f);
  if (!EXT.test(p) || !fs.statSync(p).isFile()) continue;
  const raw = fs.readFileSync(p);
  if (raw.length < 1024) continue;
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (gz.length >= raw.length) continue;
  fs.writeFileSync(`${p}.gz`, gz);
  // même date que l'original : nginx (gzip_static) et les ETag restent cohérents
  const { atime, mtime } = fs.statSync(p);
  fs.utimesSync(`${p}.gz`, atime, mtime);
  n += 1; before += raw.length; after += gz.length;
}
console.log(`Précompression : ${n} fichier(s), ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB`);
