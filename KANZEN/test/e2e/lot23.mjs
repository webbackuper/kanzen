/* global document, getComputedStyle */
// E2E lots 2 et 3 « Kanban et Wiki » : champs personnalisés, estimation, dépendances, vues Liste et Chronologie ;
// wiki : blocs sous-pages et sommaire, diagramme Mermaid embarqué, impression / PDF.
// Prérequis : base migrée et seedée, UI buildée. Usage : DATABASE_URL=... node test/e2e/lot23.mjs
// SCREENSHOTS=<dossier> enregistre des captures des écrans principaux et un PDF d'exemple.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SCREENSHOTS;
const server = spawn(process.execPath, ['src/server/index.js'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), STATIC_DIR: 'dist', LOG_LEVEL: 'warn', PUBLIC_URL: BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const errors = [];
const httpErrors = [];
let browser;
let page;
const step = (s) => console.log(`• ${s}`);
const iso = (d) => d.toISOString().slice(0, 10);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* démarrage */ } await sleep(200); }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  await ctx.addInitScript((v) => { try { localStorage.setItem('kz-seen-version', v); } catch { /* */ } }, version);
  page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on('dialog', (d) => d.accept());
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

  await page.goto(BASE);
  await page.getByLabel('Identifiant').fill('admin');
  await page.getByLabel('Mot de passe').fill('KanZen-Dev-2026!');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Équipe Infra').click();
  await page.getByText('Migration datacenter').click();
  await page.getByText('Plan d\'adressage IP').waitFor();

  // --- Champs personnalisés ---
  await page.getByRole('button', { name: 'Champs' }).click();
  const fdlg = page.getByRole('dialog');
  await fdlg.getByLabel('Nom du nouveau champ').fill('Environnement');
  await fdlg.getByLabel('Type du champ').selectOption('SELECT');
  await fdlg.getByLabel('Options (séparées par des virgules)').fill('Prod, Recette');
  await fdlg.getByRole('button', { name: 'Ajouter le champ' }).click();
  await fdlg.getByText('Liste de choix : Prod, Recette').waitFor();
  await fdlg.getByLabel('Nom du nouveau champ').fill('Validé CAB');
  await fdlg.getByLabel('Type du champ').selectOption('CHECKBOX');
  await fdlg.getByRole('button', { name: 'Ajouter le champ' }).click();
  await fdlg.getByText('Validé CAB', { exact: true }).waitFor();
  await page.getByLabel('Fermer').click();
  step('champs personnalisés du tableau');

  // --- Carte : dates, estimation, champs, dépendance ---
  const today = new Date();
  await page.getByText('Plan d\'adressage IP').click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Début').fill(iso(new Date(today.getTime() + 2 * 86400_000)));
  await dlg.getByLabel('Échéance').fill(iso(new Date(today.getTime() + 9 * 86400_000)));
  await dlg.getByLabel('Estimation').fill('3');
  await dlg.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await dlg.getByLabel('Environnement').selectOption('Prod');
  await dlg.getByLabel('Validé CAB').check();
  await dlg.getByRole('button', { name: /Ajouter « bloquée par »/ }).click();
  await dlg.getByLabel('Rechercher la carte bloquante').fill('Inventaire');
  await dlg.getByRole('list', { name: 'Cartes trouvées' }).getByRole('button', { name: /^Inventaire des VM ·/ }).click();
  await dlg.getByText('Bloquée par', { exact: true }).waitFor();
  await dlg.getByText('Bloquée', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /Activité/ }).click();
  await page.getByText(/a indiqué que la carte est bloquée par « Inventaire des VM »/).waitFor();
  await page.getByText(/a modifié le champ « Environnement » \(vide → « Prod »\)/).waitFor();
  await shot('kanban-dependances-champs');
  await page.getByLabel('Fermer').first().click();
  const card = page.locator('[aria-roledescription="sortable"]', { hasText: 'Plan d\'adressage IP' });
  await card.getByText('Bloquée').waitFor();
  step('estimation, champs, dépendance « bloquée par », badge sur la carte');

  // --- Vue Liste ---
  await page.getByRole('button', { name: 'Liste', exact: true }).click();
  const table = page.getByRole('table');
  await table.getByRole('columnheader', { name: 'Environnement' }).waitFor();
  const row = table.getByRole('row', { name: /Plan d'adressage IP/ });
  await row.getByText('Prod').waitFor();
  await row.getByText('Oui').waitFor();
  await table.getByRole('button', { name: 'Estim.' }).click();
  await page.waitForFunction(() => document.querySelector('tbody tr td button')?.innerText === 'Plan d\'adressage IP');
  assert.match(page.url(), /view=list/);
  await shot('kanban-liste');
  step('vue Liste : champs, tri par estimation, vue dans l\'URL');

  // --- Vue Chronologie ---
  await page.getByRole('button', { name: 'Chronologie' }).click();
  await page.getByRole('group', { name: 'Vue' }).getByRole('button', { name: 'Chronologie', pressed: true }).waitFor();
  await page.getByRole('region', { name: 'Chronologie des cartes' }).getByRole('button', { name: /Plan d'adressage IP.*bloquée/ }).waitFor();
  await shot('kanban-chronologie');
  await page.getByRole('region', { name: 'Chronologie des cartes' }).getByRole('button', { name: /Plan d'adressage IP/ }).click();
  await page.getByRole('dialog').getByText('Bloquée par', { exact: true }).waitFor();
  await page.getByLabel('Fermer').first().click();
  await page.getByRole('button', { name: 'Tableau', exact: true }).click();
  await page.locator('h3.uppercase').first().waitFor();
  step('vue Chronologie : barre, ouverture de la carte, retour au tableau');

  // --- Wiki : sous-pages, sommaire, diagramme ---
  await page.goto(`${BASE}/`);
  await page.getByText('Équipe Infra').click();
  await page.getByRole('link', { name: 'Wiki' }).last().click();
  await page.getByRole('link', { name: /Accueil de l'équipe Infra/ }).first().click();
  await page.getByRole('heading', { name: /Accueil de l'équipe Infra/ }).waitFor();
  await page.getByRole('button', { name: 'Modifier' }).click();
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  for (const cmd of ['sommaire', 'sous-pages', 'diagramme']) {
    await page.keyboard.type(`/${cmd}`);
    await page.locator('[role="listbox"], [role="menu"]').first().waitFor();
    await page.keyboard.press('Enter');
    await sleep(150);
  }
  await page.locator('.kz-mermaid svg').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Enregistrer' }).first().click();
  await page.getByRole('button', { name: 'Modifier' }).waitFor();
  await page.reload();
  const article = page.locator('article');
  await article.locator('.kz-subpages-link', { hasText: 'Procédure de sauvegarde' }).waitFor();
  await article.getByRole('navigation', { name: 'Sommaire' }).getByRole('link', { name: 'Contacts' }).waitFor();
  await article.locator('.kz-mermaid svg').waitFor({ timeout: 15000 });
  assert.equal(await article.locator('pre.kz-hidden').count(), 1, 'code Mermaid masqué en lecture');
  await article.getByRole('button', { name: 'Voir le code' }).click();
  assert.equal(await article.locator('pre.kz-hidden').count(), 0, 'code Mermaid affiché à la demande');
  await shot('wiki-blocs-mermaid');
  step('wiki : sommaire, sous-pages et diagramme Mermaid rendu hors ligne');

  // --- Impression ---
  await page.emulateMedia({ media: 'print' });
  const print = await page.evaluate(() => ({
    main: getComputedStyle(document.querySelector('main')).overflow,
    header: getComputedStyle(document.querySelector('.kz-print-only')).display,
    comments: [...document.querySelectorAll('.kz-noprint')].every((e) => getComputedStyle(e).display === 'none'),
  }));
  assert.deepEqual(print, { main: 'visible', header: 'block', comments: true });
  if (SHOTS) await page.pdf({ path: path.join(SHOTS, 'wiki-impression.pdf'), format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  step('impression : contenu non tronqué, en-tête de provenance, interface masquée');

  // 410 : images des pages créées par wiki.mjs, dont le stockage temporaire n'existe plus pour ce serveur
  const unexpected = errors.filter((e) => !/401|409|410/.test(e));
  assert.deepEqual(unexpected, [], 'erreurs navigateur (CSP, JS)');
  console.log('OK : parcours lots 2 et 3 complet');
} catch (err) {
  console.error('E2E lots 2 et 3 KO :', err.message, errors, httpErrors);
  if (SHOTS) await page?.screenshot({ path: path.join(SHOTS, 'echec.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
