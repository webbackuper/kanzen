import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dépendances lourdes propres au wiki isolées dans leur propre chunk (toujours chargé à la demande) :
// leur empreinte change rarement d'une version à l'autre, le cache navigateur est conservé.
// Ne pas y mettre de module partagé avec l'écran principal, sinon le chunk devient préchargé.
const VENDOR_CHUNKS = [
  ['vendor-highlight', /node_modules\/(highlight\.js|lowlight)\//],
];

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../dist', // Build vers KANZEN/dist (copié en ./public par le Dockerfile)
    emptyOutDir: true,
    // Le chunk du wiki embarque l'éditeur TipTap/ProseMirror (~600 kB, ~200 kB gzip), chargé à la demande :
    // seuil relevé en conséquence pour que l'avertissement signale une VRAIE régression (cf. docs/06).
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, re] of VENDOR_CHUNKS) if (re.test(id)) return name;
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000', // Proxy pour le dev local
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    }
  }
});
