// Test E2E de bout en bout : serveur réel + navigateur (Chromium headless).
// Prérequis : base migrée et seedée (npm run prisma:seed), UI buildée (npm run build).
// Usage : DATABASE_URL=... node test/e2e/smoke.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['src/server/index.js'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), STATIC_DIR: 'dist', LOG_LEVEL: 'warn', PUBLIC_URL: BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const errors = [];
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* démarrage */ } await sleep(200); }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE);
  await page.getByLabel('Identifiant').fill('alice');
  await page.getByLabel('Mot de passe').fill('mauvais');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('alert').waitFor();

  await page.getByLabel('Mot de passe').fill('KanZen-Dev-2026!');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('heading', { name: 'Espaces de travail' }).waitFor();

  await page.getByText('Équipe Infra').click();
  await page.getByText('Migration datacenter').click();
  await page.getByText('Inventaire des VM').waitFor();

  // Création d'une tâche dans la première colonne
  await page.getByRole('button', { name: 'Ajouter une tâche' }).first().click();
  await page.getByPlaceholder('Titre de la tâche').fill('Tâche E2E');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByText('Tâche E2E').waitFor();

  // Détail : sous-tâche + commentaire
  await page.getByText('Tâche E2E').click();
  await page.getByPlaceholder('Ajouter une sous-tâche').fill('Vérifier');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByText('Vérifier').waitFor();
  await page.getByPlaceholder('Écrire un commentaire').fill('RAS');
  await page.getByRole('button', { name: 'Commenter' }).click();
  await page.getByText('RAS').waitFor();
  await page.getByLabel('Fermer').click();
  await page.getByText('0/1').waitFor();

  // Agenda et statistiques
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('button', { name: 'Mois suivant' }).waitFor();
  await page.goBack();
  await page.getByRole('link', { name: 'Statistiques' }).click();
  await page.getByText('Répartition par colonne').waitFor();

  // Déconnexion
  await page.getByLabel('Se déconnecter').click();
  await page.getByRole('button', { name: 'Se connecter' }).waitFor();

  assert.deepEqual(errors.filter((e) => !/401/.test(e)), [], 'erreurs navigateur (CSP, JS)');
  console.log('E2E OK');
} catch (err) {
  console.error('E2E KO :', err.message, errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
