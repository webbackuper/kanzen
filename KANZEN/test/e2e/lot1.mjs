/* global document */
// E2E lot 1 « Kanban et Wiki » : étiquettes, priorité, archivage, journal, duplication, colonnes déplaçables ;
// wiki : commentaires, vérification, modèle d'équipe, duplication.
// Prérequis : base migrée et seedée, UI buildée. Usage : DATABASE_URL=... node test/e2e/lot1.mjs
// SCREENSHOTS=<dossier> enregistre des captures des écrans principaux.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SCREENSHOTS;
const server = spawn(process.execPath, ['src/server/index.js'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), STATIC_DIR: 'dist', LOG_LEVEL: 'warn', PUBLIC_URL: BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const errors = [];
const httpErrors = [];
let browser;
const step = (s) => console.log(`• ${s}`);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* démarrage */ } await sleep(200); }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // « Quoi de neuf » déjà vu (testé dans smoke.mjs)
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  await ctx.addInitScript((v) => { try { localStorage.setItem('kz-seen-version', v); } catch { /* */ } }, version);
  const page = await ctx.newPage();
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
  await page.getByText('Inventaire des VM').waitFor();

  // --- Étiquettes ---
  await page.getByRole('button', { name: 'Étiquettes' }).click();
  for (const [name, color] of [['Sécurité', 'Rouge'], ['Réseau', 'Bleu']]) {
    await page.getByLabel('Nom de la nouvelle étiquette').fill(name);
    await page.getByRole('radio', { name: color }).click();
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await page.getByRole('dialog').getByText(name, { exact: true }).waitFor();
  }
  await page.getByLabel('Fermer').click();
  step('étiquettes du tableau');

  // --- Détail : étiquette, priorité, dates ---
  await page.getByText('Inventaire des VM').click();
  await page.getByRole('group', { name: 'Étiquettes' }).getByRole('button', { name: 'Sécurité' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Priorité').selectOption('HIGH');
  await dlg.getByLabel('Début').fill('2026-12-01');
  await dlg.getByLabel('Échéance').fill('2026-12-15');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('tab', { name: /Activité/ }).click();
  await page.getByText(/a modifié .*la priorité \(Aucune → Haute\)/).waitFor();
  await shot('kanban-detail-activite');
  await page.getByLabel('Fermer').first().click();
  const card = page.locator('[aria-roledescription="sortable"]', { hasText: 'Inventaire des VM' });
  await card.getByText('Sécurité').waitFor();
  await card.getByText('Priorité Haute').waitFor();
  step('étiquette, priorité et dates sur la carte, journal d\'activité');

  // --- Duplication ---
  await page.getByText('Inventaire des VM').click();
  await page.getByRole('button', { name: 'Dupliquer' }).click();
  await page.waitForFunction(() => document.querySelector('[role=dialog] input[aria-label="Titre"]')?.value === 'Inventaire des VM (copie)');
  await page.getByLabel('Fermer').first().click();
  await page.getByText('Inventaire des VM (copie)').waitFor();
  step('duplication d\'une carte');

  // --- Archivage puis restauration ---
  await page.getByText('Inventaire des VM (copie)').click();
  await page.getByRole('button', { name: 'Archiver' }).click();
  await page.getByText('Inventaire des VM (copie)').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Archives (1)' }).click();
  await shot('kanban-archives');
  await page.getByRole('button', { name: 'Restaurer' }).click();
  await page.getByText('Aucune carte archivée.').waitFor();
  await page.getByLabel('Fermer').click();
  await page.getByText('Inventaire des VM (copie)').waitFor();
  step('archivage et restauration');

  // --- Réordonner les colonnes au clavier ---
  const headings = () => page.locator('h3.uppercase').allInnerTexts();
  const before = await headings();
  await page.getByRole('button', { name: `Déplacer la colonne ${before[0]}` }).focus();
  await page.keyboard.press('Space');
  await sleep(150);
  await page.keyboard.press('ArrowRight');
  await sleep(150);
  await page.keyboard.press('Space');
  await page.waitForFunction((first) => document.querySelectorAll('h3.uppercase')[1]?.innerText === first, before[0]);
  await page.reload();
  await page.getByText('Inventaire des VM').first().waitFor();
  const after = await headings();
  assert.equal(after[1], before[0], 'colonne déplacée et enregistrée');
  await shot('kanban-tableau');
  step('colonnes réordonnées au clavier, ordre conservé après rechargement');

  // --- Wiki : commentaires ---
  await page.goto(`${BASE}/`);
  await page.getByText('Équipe Infra').click();
  await page.getByRole('link', { name: 'Wiki' }).last().click();
  await page.getByRole('button', { name: 'Nouvelle page' }).last().click();
  await page.getByRole('button', { name: /Procédure d'exploitation/ }).click();
  await page.getByLabel('Titre de la page').fill('Renouvellement des certificats');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('heading', { name: /Renouvellement des certificats/ }).waitFor();
  await page.getByLabel('Nouveau commentaire').fill('L\'étape 2 doit mentionner la CRL.');
  await page.getByRole('button', { name: 'Commenter' }).click();
  await page.getByText('L\'étape 2 doit mentionner la CRL.').waitFor();
  await page.getByRole('button', { name: 'Répondre' }).click();
  await page.getByLabel('Réponse').fill('Ajouté, merci.');
  await page.getByRole('button', { name: 'Répondre' }).last().click();
  await page.getByText('Ajouté, merci.').waitFor();
  await shot('wiki-commentaires');
  await page.getByRole('button', { name: 'Résoudre' }).click();
  await page.getByRole('button', { name: /Afficher les 1 discussion/ }).waitFor();
  step('commentaires de page : fil, réponse, résolution');

  // --- Vérification ---
  await page.getByLabel('Plus d\'actions').click();
  await page.getByRole('menuitem', { name: 'Vérification…' }).click();
  await page.getByLabel('Revue périodique').selectOption('90');
  await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
  await page.getByRole('button', { name: /Je confirme que la page est à jour/ }).click();
  await page.getByRole('dialog').getByText(/prochaine revue avant le/).waitFor();
  await page.getByLabel('Fermer').click();
  await page.getByRole('button', { name: /Vérifiée le .* par Administrateur|Vérifiée le/ }).waitFor();
  step('page vérifiée avec revue tous les 3 mois');

  // --- Modèle d'équipe ---
  await page.getByLabel('Plus d\'actions').click();
  await page.getByRole('menuitem', { name: 'Enregistrer comme modèle…' }).click();
  await page.getByLabel('Nom du modèle').fill('Procédure PKI');
  await page.getByLabel('Description').fill('Gabarit des procédures de la PKI interne');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByText(/Modèle « Procédure PKI » enregistré/).waitFor();
  await page.getByRole('button', { name: 'Fermer', exact: true }).last().click();
  step('enregistrement comme modèle');

  // --- Duplication ---
  await page.getByLabel('Plus d\'actions').click();
  await page.getByRole('menuitem', { name: 'Dupliquer', exact: true }).click();
  await page.getByRole('heading', { name: /Renouvellement des certificats \(copie\)/ }).waitFor();
  step('duplication de page');

  // --- Nouvelle page depuis le modèle d'équipe ---
  await page.getByRole('link', { name: 'Wiki', exact: true }).first().click();
  await page.getByRole('button', { name: 'Nouvelle page' }).last().click();
  await page.getByText('Modèles de l\'équipe').waitFor();
  await shot('wiki-modeles');
  await page.getByRole('button', { name: /Procédure PKI/ }).filter({ hasText: 'Procédure PKI' }).click();
  await page.getByLabel('Titre de la page').waitFor();
  assert.equal(await page.getByLabel('Titre de la page').inputValue(), 'Procédure PKI');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  step('nouvelle page depuis un modèle d\'équipe');

  // 410 : images des pages créées par wiki.mjs, dont le stockage temporaire n'existe plus pour ce serveur
  const unexpected = errors.filter((e) => !/401|409|410/.test(e));
  assert.deepEqual(unexpected, [], 'erreurs navigateur (CSP, JS)');
  console.log('OK : parcours lot 1 complet');
} catch (err) {
  console.error('E2E lot 1 KO :', err.message, errors, httpErrors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
