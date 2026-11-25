import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  // Chemins absolus : le build est lancé depuis la racine du projet (vite build src/client)
  content: [path.join(here, 'index.html'), path.join(here, 'src/**/*.{js,jsx}')],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [],
};
