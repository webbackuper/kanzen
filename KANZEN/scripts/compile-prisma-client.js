#!/usr/bin/env node
// Transpile le client Prisma généré (TypeScript) en JavaScript ESM, à côté des sources.
// Nécessaire car certains Node (ex. paquet Ubuntu/Debian) n'ont pas le « type stripping » natif.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/generated/prisma');
let n = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      const out = ts.transpileModule(fs.readFileSync(p, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: true },
        fileName: e.name,
      });
      fs.writeFileSync(p.replace(/\.ts$/, '.js'), out.outputText);
      n++;
    }
  }
};
if (!fs.existsSync(dir)) { console.error(`Client Prisma absent : ${dir} (lancer prisma generate)`); process.exit(1); }
walk(dir);
console.log(`Client Prisma transpilé en JavaScript (${n} fichiers)`);
