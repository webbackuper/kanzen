// Documents du wiki : format ProseMirror (JSON produit par l'éditeur TipTap).
// Le serveur reconstruit chaque document à partir d'une liste blanche de nœuds, de marques et d'attributs :
// rien d'autre n'est stocké, en particulier aucun HTML brut, aucun lien javascript: et aucune image externe.
import { badRequest } from './errors.js';

const MAX_DEPTH = 40;
const MAX_NODES = 50_000;
const MAX_TEXT = 1_000_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Seules les images stockées dans KanZen sont autorisées (pas de requête vers l'extérieur ni de pistage). */
export const WIKI_FILE_SRC = new RegExp(`^/api/wiki/files/(${UUID})$`);

export const CALLOUTS = ['info', 'tip', 'warning', 'danger'];
const str = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** Lien autorisé : http(s), mailto, chemin interne (« /… », sauf « //… ») ou ancre. */
export function safeHref(href) {
  if (typeof href !== 'string' || href.length > 2048) return null;
  const h = href.trim();
  // eslint-disable-next-line no-control-regex -- refus des caractères de contrôle et des espaces
  if (/[\u0000- \u007f]/.test(h)) return null;
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
  if (/^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h)) return h;
  return null;
}

// Nœuds autorisés et leurs attributs (validateur -> valeur nettoyée ou undefined)
const NODES = {
  doc: {},
  paragraph: { textAlign: (v) => (['left', 'center', 'right', 'justify'].includes(v) ? v : undefined) },
  text: {},
  heading: { level: int(1, 4) },
  bulletList: {},
  orderedList: { start: int(0, 100000), type: (v) => (v === null ? undefined : str(4)(v)) },
  listItem: {},
  taskList: {},
  taskItem: { checked: bool },
  blockquote: {},
  codeBlock: { language: (v) => (typeof v === 'string' && /^[\w+#-]{1,30}$/.test(v) ? v : undefined) },
  horizontalRule: {},
  hardBreak: {},
  image: { src: (v) => (typeof v === 'string' && WIKI_FILE_SRC.test(v) ? v : undefined), alt: str(300), title: str(300) },
  /** Fichier joint (PDF, Office…) : carte de téléchargement, toujours un fichier stocké dans KanZen. */
  fileAttachment: {
    src: (v) => (typeof v === 'string' && WIKI_FILE_SRC.test(v) ? v : undefined),
    filename: str(200), size: int(0, 10 * 1024 ** 3), mimetype: (v) => (typeof v === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(v) ? v.slice(0, 100) : undefined),
  },
  /** Encadré : information, conseil, attention, danger. */
  callout: { variant: (v) => (CALLOUTS.includes(v) ? v : undefined) },
  /** Bloc dépliable : résumé toujours visible, contenu replié par défaut. */
  details: { open: bool },
  detailsSummary: {},
  detailsContent: {},
  table: {},
  tableRow: {},
  tableHeader: { colspan: int(1, 50), rowspan: int(1, 50), colwidth: (v) => (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0 && n < 5000) ? v.slice(0, 50) : undefined) },
  tableCell: { colspan: int(1, 50), rowspan: int(1, 50), colwidth: (v) => (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0 && n < 5000) ? v.slice(0, 50) : undefined) },
};
const MARKS = {
  bold: {}, italic: {}, strike: {}, underline: {}, code: {}, highlight: {},
  link: { href: (v) => safeHref(v) ?? undefined },
};

function cleanAttrs(spec, attrs) {
  if (!attrs || typeof attrs !== 'object') return undefined;
  const out = {};
  for (const [k, check] of Object.entries(spec)) {
    const v = check(attrs[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Valide et nettoie un document. Lève une erreur 400 sur un type de nœud inconnu ou une structure invalide.
 * Les attributs non prévus sont retirés, les liens et images non conformes sont neutralisés.
 */
export function sanitizeDoc(input) {
  let nodes = 0;
  let textLen = 0;
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw badRequest('Document invalide');
    if (depth > MAX_DEPTH) throw badRequest('Document trop imbriqué');
    if (++nodes > MAX_NODES) throw badRequest('Document trop volumineux');
    const spec = NODES[n.type];
    if (!spec) throw badRequest(`Élément de document non autorisé : ${String(n.type).slice(0, 40)}`);
    const out = { type: n.type };
    if (n.type === 'text') {
      if (typeof n.text !== 'string' || !n.text) throw badRequest('Texte invalide');
      textLen += n.text.length;
      if (textLen > MAX_TEXT) throw badRequest('Document trop volumineux');
      out.text = n.text;
      if (Array.isArray(n.marks)) {
        const marks = [];
        for (const m of n.marks.slice(0, 10)) {
          const mspec = MARKS[m?.type];
          if (!mspec) continue; // marque inconnue : ignorée
          const attrs = cleanAttrs(mspec, m.attrs);
          if (m.type === 'link' && !attrs?.href) continue; // lien refusé : le texte reste, sans lien
          marks.push(attrs ? { type: m.type, attrs } : { type: m.type });
        }
        if (marks.length) out.marks = marks;
      }
      return out;
    }
    const attrs = cleanAttrs(spec, n.attrs);
    if ((n.type === 'image' || n.type === 'fileAttachment') && !attrs?.src) return null; // fichier externe ou invalide : retiré
    if (attrs) out.attrs = attrs;
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) throw badRequest('Document invalide');
      const content = n.content.map((c) => walk(c, depth + 1)).filter(Boolean);
      if (content.length) out.content = content;
    }
    return out;
  };
  if (input?.type !== 'doc') throw badRequest('Document invalide : racine « doc » attendue');
  const doc = walk(input, 0);
  if (!doc.content) doc.content = [{ type: 'paragraph' }];
  return doc;
}

export const emptyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock', 'tableRow', 'horizontalRule', 'fileAttachment', 'callout', 'detailsSummary']);

/** Texte brut du document, pour la recherche plein texte et les extraits. */
export function docText(doc) {
  const parts = [];
  const walk = (n) => {
    if (n.type === 'text') parts.push(n.text);
    else if (n.type === 'hardBreak') parts.push('\n');
    else if (n.type === 'image' && n.attrs?.alt) parts.push(n.attrs.alt);
    else if (n.type === 'fileAttachment' && n.attrs?.filename) parts.push(n.attrs.filename);
    for (const c of n.content ?? []) walk(c);
    if (BLOCKS.has(n.type) || n.type === 'tableCell' || n.type === 'tableHeader') parts.push(n.type === 'tableCell' || n.type === 'tableHeader' ? ' ' : '\n');
  };
  walk(doc);
  // eslint-disable-next-line no-control-regex -- les caractères de contrôle servent de balises d'extrait (recherche)
  return parts.join('').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Identifiants des fichiers du wiki référencés par le document. */
export function docFileIds(doc) {
  const ids = new Set();
  const walk = (n) => {
    if (n.type === 'image' || n.type === 'fileAttachment') { const m = WIKI_FILE_SRC.exec(n.attrs?.src ?? ''); if (m) ids.add(m[1]); }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return ids;
}

// --- Export Markdown (sauvegarde lisible, échange hors KanZen) ---

const escapeMd = (s) => s.replace(/([\\`*_[\]#<>|])/g, '\\$1');

// Adresse des fichiers dans l'export (chemin relatif dans une archive, par exemple)
let fileUrl = (src) => src;

function inline(nodes = []) {
  return nodes.map((n) => {
    if (n.type === 'hardBreak') return '  \n';
    if (n.type === 'image') return `![${escapeMd(n.attrs?.alt ?? '')}](${fileUrl(n.attrs.src)})`;
    if (n.type !== 'text') return inline(n.content);
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    let t = marks.has('code') ? `\`${n.text.replace(/`/g, 'ˋ')}\`` : escapeMd(n.text);
    if (marks.has('bold')) t = `**${t}**`;
    if (marks.has('italic')) t = `*${t}*`;
    if (marks.has('strike')) t = `~~${t}~~`;
    const link = n.marks?.find((m) => m.type === 'link');
    if (link) t = `[${t}](${link.attrs.href})`;
    return t;
  }).join('');
}

function block(n, indent = '') {
  const c = n.content ?? [];
  switch (n.type) {
    case 'paragraph': return indent + inline(c);
    case 'heading': return `${'#'.repeat(n.attrs?.level ?? 1)} ${inline(c)}`;
    case 'blockquote': return c.map((x) => block(x)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': return `\`\`\`${n.attrs?.language ?? ''}\n${c.map((x) => x.text).join('')}\n\`\`\``;
    case 'horizontalRule': return '---';
    case 'image': return inline([n]);
    case 'fileAttachment': return `${indent}📎 [${escapeMd(n.attrs?.filename ?? 'fichier')}](${fileUrl(n.attrs.src)})`;
    case 'callout': {
      const label = { info: 'Information', tip: 'Conseil', warning: 'Attention', danger: 'Danger' }[n.attrs?.variant ?? 'info'] ?? 'Information';
      const body = c.map((x) => block(x)).join('\n\n');
      return [`**${label}**`, ...body.split('\n')].map((l) => `> ${l}`).join('\n');
    }
    case 'details': {
      const summary = c.find((x) => x.type === 'detailsSummary');
      const content = c.find((x) => x.type === 'detailsContent');
      return `<details>\n<summary>${inline(summary?.content).replace(/</g, '&lt;')}</summary>\n\n${(content?.content ?? []).map((x) => block(x)).join('\n\n')}\n\n</details>`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return c.map((li, i) => {
        const bullet = n.type === 'orderedList' ? `${(n.attrs?.start ?? 1) + i}.` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}]` : '-';
        const [first, ...rest] = li.content ?? [];
        const head = `${indent}${bullet} ${first ? block(first).trimStart() : ''}`;
        const tail = rest.map((x) => block(x, `${indent}  `)).join('\n');
        return tail ? `${head}\n${tail}` : head;
      }).join('\n');
    case 'table': {
      const rows = c.map((r) => (r.content ?? []).map((cell) => (cell.content ?? []).map((p) => inline(p.content)).join(' ').replace(/\n/g, ' ')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
    }
    default: return c.map((x) => block(x, indent)).join('\n\n');
  }
}

/** Export Markdown. `options.fileUrl(src)` réécrit l'adresse des images et fichiers joints. */
export function docToMarkdown(title, doc, options = {}) {
  fileUrl = options.fileUrl ?? ((src) => src);
  try {
    return `# ${title}\n\n${(doc.content ?? []).map((n) => block(n)).join('\n\n').trim()}\n`;
  } finally {
    fileUrl = (src) => src;
  }
}

/**
 * Copie du document où les fichiers du wiki sont renvoyés vers d'autres identifiants (`map` : ancien → nouveau).
 * Un fichier absent de `map` est retiré du document (modèle de page, copie dont le fichier a disparu).
 */
export function remapFiles(doc, map) {
  const walk = (n) => {
    if (n.type === 'image' || n.type === 'fileAttachment') {
      const m = WIKI_FILE_SRC.exec(n.attrs?.src ?? '');
      if (!m || !map.has(m[1])) return null;
      return { ...n, attrs: { ...n.attrs, src: `/api/wiki/files/${map.get(m[1])}` } };
    }
    if (!n.content) return n;
    const content = n.content.map(walk).filter(Boolean);
    // Un bloc vidé de son unique fichier garde un paragraphe pour rester valide
    if (!content.length && n.content.length && n.type !== 'paragraph') return { ...n, content: [{ type: 'paragraph' }] };
    return { ...n, content };
  };
  return walk(doc);
}
