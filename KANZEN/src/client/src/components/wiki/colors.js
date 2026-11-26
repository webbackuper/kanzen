// Couleur stable par utilisateur (curseurs et pastilles de co-édition). Module léger, sans Yjs.
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];
export const colorOf = (id) => COLORS[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
