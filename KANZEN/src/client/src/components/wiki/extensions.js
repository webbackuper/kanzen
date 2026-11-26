// Extensions TipTap propres à KanZen : fichier joint, encadré, coloration syntaxique, menus « / » et « [[ ».
// Les nœuds produits ici sont ceux que le serveur accepte (src/server/lib/wikidoc.js).
import { Node, Extension, mergeAttributes, ReactNodeViewRenderer, ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import powershell from 'highlight.js/lib/languages/powershell';
import dos from 'highlight.js/lib/languages/dos';
import sql from 'highlight.js/lib/languages/sql';
import pgsql from 'highlight.js/lib/languages/pgsql';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import ini from 'highlight.js/lib/languages/ini';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import apache from 'highlight.js/lib/languages/apache';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { CodeBlockView } from './CodeBlockView';
import { SuggestionList } from './SuggestionList';

// --- Coloration syntaxique (langages embarqués : aucun téléchargement à l'exécution) ---
export const LANGUAGES = [
  ['plaintext', 'Texte brut', plaintext], ['bash', 'Bash', bash], ['shell', 'Console (shell)', shell],
  ['powershell', 'PowerShell', powershell], ['dos', 'Batch Windows', dos], ['sql', 'SQL', sql], ['pgsql', 'PostgreSQL', pgsql],
  ['yaml', 'YAML', yaml], ['json', 'JSON', json], ['ini', 'INI / TOML', ini], ['xml', 'XML / HTML', xml],
  ['python', 'Python', python], ['javascript', 'JavaScript', javascript], ['typescript', 'TypeScript', typescript],
  ['css', 'CSS', css], ['dockerfile', 'Dockerfile', dockerfile], ['nginx', 'Nginx', nginx], ['apache', 'Apache', apache],
  ['go', 'Go', go], ['java', 'Java', java], ['csharp', 'C#', csharp], ['perl', 'Perl', perl], ['php', 'PHP', php],
  ['ruby', 'Ruby', ruby], ['diff', 'Diff', diff], ['markdown', 'Markdown', markdown],
];
const lowlight = createLowlight();
for (const [name, , def] of LANGUAGES) lowlight.register(name, def);
lowlight.registerAlias({ bash: ['sh', 'zsh'], powershell: ['ps1', 'ps'], yaml: ['yml'], xml: ['html'], javascript: ['js'], typescript: ['ts'], python: ['py'] });

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
}).configure({ lowlight, defaultLanguage: null, HTMLAttributes: { class: 'hljs' } });

// --- Fichier joint : carte de téléchargement ---
export const fmtSize = (n) => (!n ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} ko`);

export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null, parseHTML: (el) => el.getAttribute('data-src') },
      filename: { default: 'fichier', parseHTML: (el) => el.getAttribute('data-filename') },
      size: { default: null, parseHTML: (el) => Number(el.getAttribute('data-size')) || null },
      mimetype: { default: null, parseHTML: (el) => el.getAttribute('data-mimetype') },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="file-attachment"]' }]; },
  renderHTML({ node }) {
    const { src, filename, size, mimetype } = node.attrs;
    return ['div', {
      'data-type': 'file-attachment', class: 'kz-file', 'data-src': src, 'data-filename': filename, 'data-size': size ?? '', 'data-mimetype': mimetype ?? '',
    }, ['a', { href: src, download: filename, class: 'kz-file-link', title: `Télécharger ${filename}` },
      ['span', { class: 'kz-file-icon', 'aria-hidden': 'true' }, '📎'],
      ['span', { class: 'kz-file-name' }, filename],
      ['span', { class: 'kz-file-size' }, fmtSize(size)]]];
  },
  addCommands() {
    return { insertFileAttachment: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});

// --- Encadré (information, conseil, attention, danger) ---
export const CALLOUTS = [
  ['info', 'Information', 'ℹ️'], ['tip', 'Conseil', '💡'], ['warning', 'Attention', '⚠️'], ['danger', 'Danger', '⛔'],
];
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { variant: { default: 'info', parseHTML: (el) => el.getAttribute('data-callout') ?? 'info', renderHTML: () => ({}) } };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const v = CALLOUTS.find(([k]) => k === node.attrs.variant) ?? CALLOUTS[0];
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': v[0], class: `kz-callout kz-callout-${v[0]}`, 'data-label': `${v[2]} ${v[1]}` }), 0];
  },
  addCommands() {
    return {
      setCallout: (variant = 'info') => ({ editor, commands }) => (editor.isActive(this.name)
        ? commands.updateAttributes(this.name, { variant })
        : commands.wrapIn(this.name, { variant })),
      unsetCallout: () => ({ commands }) => commands.lift(this.name),
    };
  },
});

// --- Menus de suggestion (« / » commandes, « [[ » liens vers des pages) ---
function suggestionRender() {
  let component;
  let el;
  const place = (rect) => {
    if (!el || !rect) return;
    const r = rect();
    if (!r) return;
    const below = r.bottom + 320 < window.innerHeight;
    el.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
    el.style.top = below ? `${r.bottom + 6}px` : `${Math.max(8, r.top - 326)}px`;
  };
  return {
    onStart: (props) => {
      component = new ReactRenderer(SuggestionList, { props, editor: props.editor });
      el = document.createElement('div');
      el.className = 'fixed z-50';
      el.appendChild(component.element);
      document.body.appendChild(el);
      place(props.clientRect);
    },
    onUpdate: (props) => { component?.updateProps(props); place(props.clientRect); },
    onKeyDown: (props) => {
      if (props.event.key === 'Escape') { el?.remove(); el = null; return true; }
      return component?.ref?.onKeyDown(props) ?? false;
    },
    onExit: () => { el?.remove(); el = null; component?.destroy(); component = null; },
  };
}

/** Commandes « / » : la liste est fournie par l'éditeur (dépend des actions disponibles : image, fichier…). */
export const SlashCommands = Extension.create({
  name: 'slashCommands',
  addOptions() { return { items: () => [] }; },
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      pluginKey: new PluginKey('kzSlash'),
      char: '/',
      allowSpaces: false,
      startOfLine: false,
      allow: ({ state, range }) => {
        // Pas dans un bloc de code ; « / » doit commencer un mot (pas dans une URL ou un chemin)
        const $from = state.doc.resolve(range.from);
        if ($from.parent.type.name === 'codeBlock') return false;
        const before = state.doc.textBetween(Math.max($from.start(), range.from - 1), range.from, '\n', ' ');
        return before === '' || /\s/.test(before);
      },
      items: ({ query }) => {
        const q = query.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
        return this.options.items().filter((i) => !q || i.search.includes(q)).slice(0, 12);
      },
      command: ({ editor, range, props }) => { editor.chain().focus().deleteRange(range).run(); props.run(editor); },
      render: suggestionRender,
    })];
  },
});

/** « [[ » : recherche d'une page du wiki et insertion d'un lien interne vers elle. */
export const WikiLinks = Extension.create({
  name: 'wikiLinks',
  addOptions() { return { pages: () => [] }; },
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      pluginKey: new PluginKey('kzWikiLink'),
      char: '[[',
      allowSpaces: true,
      items: ({ query }) => {
        const q = query.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
        return this.options.pages()
          .filter((p) => !q || p.title.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(q))
          .slice(0, 10)
          .map((p) => ({ id: p.id, title: `${p.icon ? `${p.icon} ` : ''}${p.title}`, hint: p.path, label: p.title }));
      },
      command: ({ editor, range, props }) => {
        editor.chain().focus().deleteRange(range)
          .insertContent([{ type: 'text', text: props.label, marks: [{ type: 'link', attrs: { href: `/wiki/${props.id}` } }] }, { type: 'text', text: ' ' }])
          .run();
      },
      render: suggestionRender,
    })];
  },
});
