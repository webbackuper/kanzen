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
  // Diagnostic en cas d'échec : réponses HTTP en erreur
  const httpErrors = [];
  page.on('response', async (r) => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} ${(await r.text().catch(() => '')).slice(0, 200)}`); });
  const writes = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/tasks/')) writes.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ''}`); });
  globalThis.dumpState = async () => {
    console.error('Écritures tâches :', writes);
    console.error('Boutons pressés :', await page.locator('[role=group][aria-label="Assignés"] button').evaluateAll((bs) => bs.map((b) => `${b.textContent}=${b.getAttribute('aria-pressed')}`)).catch(() => '?'));
    console.error('Réponses en erreur :', httpErrors);
    console.error('URL :', page.url());
    console.error('Dialogue :', await page.locator('[role=dialog]').innerText({ timeout: 1000 }).catch(() => '(aucun)'));
  };

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
  await page.locator('li span', { hasText: 'Vérifier' }).waitFor();
  await page.getByPlaceholder('Écrire un commentaire').fill('RAS');
  await page.getByRole('button', { name: 'Commenter' }).click();
  // Le commentaire publié (et non le texte encore présent dans la zone de saisie)
  await page.locator('li p', { hasText: 'RAS' }).waitFor();
  // Affectation à plusieurs personnes
  const group = page.getByRole('group', { name: 'Assignés' });
  await group.getByRole('button', { name: /Alice Martin/ }).click();
  await group.getByRole('button', { name: /Bob Durand/ }).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Assignés (2)').waitFor();
  await page.getByLabel('Fermer').click();
  await page.getByText('0/1').waitFor();
  await page.locator('[title="Alice Martin, Bob Durand"]').waitFor();

  // Agenda et statistiques
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('button', { name: 'Mois suivant' }).waitFor();
  await page.goBack();
  await page.getByRole('link', { name: 'Statistiques' }).click();
  await page.getByText('Répartition par colonne').waitFor();

  // Wiki : lecture, création d'une page avec mise en forme, recherche plein texte, historique
  await page.goto(`${BASE}/`);
  await page.getByText('Équipe Infra').click();
  await page.getByRole('link', { name: 'Wiki', exact: true }).click();
  await page.getByRole('heading', { name: /Wiki · Équipe Infra/ }).waitFor();
  await page.getByRole('navigation', { name: 'Pages du wiki' }).getByRole('link', { name: "Accueil de l'équipe Infra" }).click();
  await page.getByRole('link', { name: 'Procédure de sauvegarde' }).last().click();
  await page.getByText('Test de restauration trimestriel', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nouvelle sous-page de Accueil' }).click({ force: true });
  const titleBox = page.getByLabel('Titre de la page');
  await titleBox.fill('Runbook E2E');
  const editor = page.getByLabel('Contenu de la page');
  await editor.click();
  await page.keyboard.type('Redémarrer le ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('reverse proxy');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' après rotation des certificats.');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('button', { name: 'Modifier' }).waitFor();
  await page.locator('.kz-prose strong', { hasText: 'reverse proxy' }).waitFor();
  await page.getByRole('navigation', { name: 'Pages du wiki' }).getByRole('link', { name: 'Runbook E2E' }).waitFor();
  await page.getByPlaceholder('Rechercher dans le wiki').fill('certificat');
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Runbook E2E' }).first().waitFor();
  await page.locator('mark', { hasText: /certificat/i }).first().waitFor();
  await page.getByRole('link', { name: 'Runbook E2E' }).first().click();
  await page.getByRole('button', { name: 'Historique' }).click();
  await page.getByRole('button', { name: /Version 2 \(actuelle\)/ }).waitFor();
  await page.getByLabel('Fermer').click();

  // Déconnexion
  await page.getByLabel('Se déconnecter').click();
  await page.getByRole('button', { name: 'Se connecter' }).waitFor();

  assert.deepEqual(errors.filter((e) => !/401/.test(e)), [], 'erreurs navigateur (CSP, JS)');
  console.log('E2E OK');
} catch (err) {
  console.error('E2E KO :', err.message, errors);
  await globalThis.dumpState?.();
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
