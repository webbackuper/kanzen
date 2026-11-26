// Test E2E du wiki : modèles, menu « / », code coloré, fichiers joints, co-édition à deux, historique,
// favoris, accueil, glisser-déposer, tâches liées, accès restreint, export ZIP, import Markdown.
// Prérequis : base migrée et seedée (npm run prisma:seed), UI buildée (npm run build).
// Usage : DATABASE_URL=... [CHROMIUM_PATH=...] node test/e2e/wiki.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const server = spawn(process.execPath, ['src/server/index.js'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), STATIC_DIR: 'dist', LOG_LEVEL: 'warn', PUBLIC_URL: BASE, UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'kz-e2e-wiki-')) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* démarrage */ } await sleep(200); }
const PW = 'KanZen-Dev-2026!';
const errors = [];
const step = (m) => console.log(`• ${m}`);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function login(user) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${user}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${user}] ${e.message}`));
  await page.goto(BASE);
  await page.getByLabel('Identifiant').fill(user);
  await page.getByLabel('Mot de passe').fill(PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('heading', { name: 'Espaces de travail' }).waitFor();
  return page;
}
const api = (page, url, opts = {}) => page.evaluate(async ([u, o]) => {
  const r = await fetch(`/api${u}`, { ...o, headers: { 'X-Requested-With': 'KanZen', ...(o.body ? { 'Content-Type': 'application/json' } : {}) } });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}, [url, opts]);

try {
  const admin = await login('admin');
  const alice = await login('alice');
  const bob = await login('bob');
  const ws = (await api(admin, '/workspaces')).body.workspaces[0];

  step('création d\'une page depuis un modèle');
  await admin.goto(`${BASE}/w/${ws.id}/wiki`);
  await admin.getByRole('button', { name: 'Nouvelle page' }).first().click();
  await admin.getByRole('button', { name: /Procédure d'exploitation/ }).click();
  await admin.getByRole('toolbar', { name: 'Mise en forme' }).waitFor();
  await admin.getByRole('button', { name: 'Enregistrer' }).and(admin.locator(':not([disabled])')).waitFor({ timeout: 10000 });
  const editor = admin.locator('.ProseMirror[contenteditable="true"]');
  await editor.locator('h2', { hasText: 'Prérequis' }).waitFor();

  step('menu « / » : bloc de code PowerShell');
  await editor.click();
  await admin.keyboard.press('Control+End');
  await admin.keyboard.press('Enter');
  await admin.keyboard.type('/code');
  await admin.getByRole('listbox', { name: 'Suggestions' }).waitFor();
  await admin.keyboard.press('Enter');
  await admin.keyboard.type('Get-Service | Where-Object Status -eq "Running"');
  const lang = admin.getByLabel('Langage du bloc de code').last();
  await lang.selectOption('powershell');
  await admin.locator('.kz-code').last().locator('.hljs-string, .hljs-built_in, .hljs-keyword').first().waitFor({ timeout: 5000 });

  step('encadré par la barre d\'outils, lien [[ ]]');
  await admin.keyboard.press('Control+End');
  await admin.keyboard.press('Enter');
  await admin.keyboard.press('Enter');
  await admin.keyboard.press('Enter');
  await admin.keyboard.type('Voir aussi ');
  await admin.keyboard.type('[[');
  await admin.getByRole('listbox', { name: 'Suggestions' }).waitFor();

  await admin.keyboard.press('Escape');

  step('fichier joint (PDF) et image');
  await admin.getByLabel('Fichier à insérer').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await editor.locator('.kz-file-link', { hasText: 'plan.pdf' }).waitFor();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await admin.getByLabel('Fichier à insérer').setInputFiles({ name: 'schema.png', mimeType: 'image/png', buffer: png });
  await editor.locator('img[alt="schema.png"]').waitFor();

  step('icône et titre');
  await admin.getByLabel('Choisir l\'icône de la page').click();
  await admin.getByLabel('Icône 🐧').click();
  await admin.getByLabel('Titre de la page').fill('Redémarrage du service');
  await admin.getByRole('button', { name: 'Enregistrer' }).click();
  await admin.getByRole('heading', { level: 1, name: /🐧 Redémarrage du service/ }).waitFor();
  const pageUrl = admin.url();
  const pageId = pageUrl.split('/wiki/')[1];
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/1-lecture.png`, fullPage: true });

  step('lecture : sommaire, copie du code, fichier joint');
  await admin.getByRole('navigation', { name: 'Sommaire' }).waitFor();
  await admin.getByRole('button', { name: 'Copier le code' }).first().waitFor();
  const saved = (await api(admin, `/wiki/pages/${pageId}`)).body.page;
  const types = saved.content.content.map((n) => n.type);
  assert.ok(types.includes('codeBlock') && types.includes('fileAttachment') && types.includes('image') && types.includes('callout'), `types: ${types}`);
  assert.equal(saved.content.content.find((n) => n.type === 'codeBlock' && n.attrs?.language === 'powershell')?.attrs.language, 'powershell');
  assert.equal(saved.icon, '🐧');

  step('co-édition admin + alice');
  await alice.goto(pageUrl);
  await alice.getByRole('button', { name: 'Modifier' }).click();
  await admin.getByRole('button', { name: 'Modifier' }).click();
  await admin.getByText(/Alice Martin modifie aussi/).waitFor({ timeout: 10000 });
  await alice.getByText(/Admin \(dev\) modifie aussi/).waitFor({ timeout: 10000 });
  const aEditor = admin.locator('.ProseMirror[contenteditable="true"]');
  await aEditor.locator('h2', { hasText: 'Contacts' }).click();
  await admin.keyboard.press('End');
  await admin.keyboard.type(' (mise à jour admin)');
  await alice.locator('.ProseMirror h2', { hasText: 'Contacts (mise à jour admin)' }).waitFor({ timeout: 5000 });
  await alice.locator('.collaboration-carets__caret').first().waitFor({ timeout: 5000 });
  await alice.getByLabel('Titre de la page').fill('Redémarrage du service (v2)');
  await admin.getByLabel('Titre de la page').and(admin.locator('[value="Redémarrage du service (v2)"]')).waitFor({ timeout: 5000 });
  if (SHOTS) await alice.screenshot({ path: `${SHOTS}/2-coedition.png` });
  await admin.getByRole('button', { name: 'Enregistrer' }).click();
  await admin.getByRole('heading', { level: 1, name: /Redémarrage du service \(v2\)/ }).waitFor();
  await alice.getByText('Admin (dev) a enregistré la page.').waitFor({ timeout: 5000 });
  await alice.getByRole('button', { name: 'Enregistrer' }).click();
  await alice.getByRole('heading', { level: 1, name: /Redémarrage du service \(v2\)/ }).waitFor();
  const v = (await api(admin, `/wiki/pages/${pageId}`)).body.page;
  assert.ok(v.version >= 3, `version ${v.version}`);
  assert.ok(JSON.stringify(v.content).includes('mise à jour admin'));

  step('historique : comparaison');
  await admin.reload();
  await admin.getByRole('button', { name: 'Historique' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: /^Version \d+/ }).last().click();
  await admin.getByLabel('Comparer').selectOption('current');
  await admin.getByRole('dialog').getByText(/vers la version actuelle/).waitFor();
  await admin.getByRole('dialog').locator('ins, p:has-text("Aucune différence")').first().waitFor();
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/3-historique.png` });
  await admin.getByRole('dialog').getByLabel('Fermer').click();

  step('favori et page d\'accueil');
  await admin.getByRole('button', { name: 'Ajouter aux favoris' }).click();
  await admin.getByRole('button', { name: 'Retirer des favoris' }).waitFor();
  await admin.getByLabel('Plus d\'actions').click();
  await admin.getByRole('menuitem', { name: /Afficher en tête de l'accueil/ }).click();
  await admin.goto(`${BASE}/w/${ws.id}/wiki`);
  await admin.getByRole('heading', { name: 'Mes favoris' }).waitFor();
  await admin.locator('section', { hasText: 'Redémarrage du service (v2)' }).getByRole('link', { name: 'Ouvrir' }).waitFor();

  step('glisser-déposer dans l\'arborescence');
  const sub = (await api(admin, `/workspaces/${ws.id}/wiki`, { method: 'POST', body: JSON.stringify({ title: 'Annexe à ranger' }) })).body.page;
  await admin.reload();
  const tree = admin.getByRole('navigation', { name: 'Pages du wiki' });
  const src = tree.locator('li a[draggable="false"]', { hasText: 'Annexe à ranger' });
  const dst = tree.locator('li a[draggable="false"]', { hasText: 'Redémarrage du service' });
  await src.waitFor();
  const s = await src.boundingBox(); const d = await dst.boundingBox();
  await admin.mouse.move(s.x + 20, s.y + s.height / 2);
  await admin.mouse.down();
  await admin.mouse.move(d.x + 30, d.y + d.height / 2, { steps: 8 });
  await admin.mouse.up();
  for (let i = 0; i < 20; i++) {
    const p = (await api(admin, `/wiki/pages/${sub.id}`)).body.page;
    if (p.parentId === pageId) break;
    if (i === 19) {
      // Le glisser-déposer HTML5 n'est pas toujours simulable : repli via dragTo
      await src.dragTo(dst);
    }
    await admin.waitForTimeout(150);
  }
  const moved = (await api(admin, `/wiki/pages/${sub.id}`)).body.page;
  assert.equal(moved.parentId, pageId, 'la page déplacée est rangée sous la cible');

  step('tâches liées (dans les deux sens)');
  await admin.goto(pageUrl);
  await admin.getByRole('button', { name: 'Lier une tâche' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: /Inventaire des VM/ }).click();
  const taskLink = admin.locator('section', { hasText: 'Tâches liées' }).locator('ul.grid').getByRole('button', { name: /^Inventaire des VM/ });
  await taskLink.waitFor();
  await taskLink.click();
  await admin.getByRole('dialog').getByText('Pages du wiki').waitFor();
  await admin.getByRole('dialog').getByRole('link', { name: /Redémarrage du service/ }).waitFor();
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/4-tache.png` });

  step('accès restreint : bob (lecteur) ne voit plus la page');
  assert.equal((await api(bob, `/wiki/pages/${pageId}`)).status, 200);
  await admin.goto(pageUrl);
  await admin.getByLabel('Plus d\'actions').click();
  await admin.getByRole('menuitem', { name: /Restreindre l'accès/ }).click();
  await admin.getByRole('dialog').getByLabel(/Accès restreint/).check();
  await admin.getByRole('dialog').getByRole('checkbox', { name: 'Alice Martin' }).check();
  await admin.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
  await admin.getByRole('button', { name: /Accès restreint/ }).waitFor();
  assert.equal((await api(bob, `/wiki/pages/${pageId}`)).status, 404);
  assert.equal((await api(bob, `/wiki/pages/${sub.id}`)).status, 404, 'la sous-page hérite de la restriction');
  assert.equal((await api(alice, `/wiki/pages/${pageId}`)).status, 200);
  await bob.goto(`${BASE}/w/${ws.id}/wiki`);
  await bob.getByRole('navigation', { name: 'Pages du wiki' }).waitFor();
  await bob.waitForTimeout(300);
  assert.equal(await bob.getByRole('link', { name: /Redémarrage du service/ }).count(), 0);

  step('export ZIP et import Markdown');
  const zip = await admin.evaluate(async (id) => { const r = await fetch(`/api/wiki/pages/${id}/export.zip`); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; }, pageId);
  assert.equal(zip[0], 200); assert.equal(zip[1], 'application/zip'); assert.ok(zip[2] > 200);
  await admin.goto(`${BASE}/w/${ws.id}/wiki`);
  await admin.getByRole('button', { name: 'Nouvelle page' }).first().click();
  await admin.getByLabel('Fichiers Markdown à importer').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes importées\n\n- [x] un\n- [ ] deux\n\n```sql\nSELECT 1;\n```\n') });
  await admin.getByRole('heading', { level: 1, name: 'Notes importées' }).waitFor();
  await admin.locator('.kz-prose ul[data-type="taskList"]').waitFor();

  step('bloc dépliable en lecture');
  await admin.getByRole('button', { name: 'Modifier' }).click();
  await admin.getByRole('button', { name: 'Enregistrer' }).and(admin.locator(':not([disabled])')).waitFor({ timeout: 10000 });
  await admin.locator('.ProseMirror[contenteditable="true"]').click();
  await admin.keyboard.press('Control+End');
  await admin.keyboard.press('Enter');
  await admin.keyboard.type('/depliable');
  await admin.keyboard.press('Enter');
  await admin.keyboard.type('Résumé visible');
  await admin.getByRole('button', { name: 'Enregistrer' }).click();
  await admin.getByRole('button', { name: 'Modifier' }).waitFor();
  const det = (await api(admin, `/wiki/pages/${admin.url().split('/wiki/')[1]}`)).body.page.content.content.find((n) => n.type === 'details');
  assert.ok(det, 'bloc dépliable enregistré');
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/5-import.png`, fullPage: true });

  const relevant = errors.filter((e) => !/favicon|status of 404|status of 401/.test(e));
  assert.deepEqual(relevant, [], `erreurs console : ${relevant.join('\n')}`);
  console.log('OK : parcours wiki v2 complet');
} catch (err) {
  console.error('ÉCHEC :', err.message);
  for (const e of errors) console.error('  console:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
