// Éditeur riche du wiki (TipTap / ProseMirror). Le document est échangé en JSON avec le serveur,
// qui le revalide : l'éditeur ne produit jamais de HTML stocké.
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import { Placeholder } from '@tiptap/extensions';
import {
  Bold, Italic, Strikethrough, Underline, Code, Highlighter, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, SquareCode, Minus, Link2, ImagePlus, Table as TableIcon, Undo2, Redo2, Columns3, Rows3, Trash2, Paperclip,
  MessageSquareWarning, ChevronsDownUp, Pilcrow, FileText,
} from 'lucide-react';
import { CALLOUTS, Callout, CodeBlock, FileAttachment, SlashCommands, WikiLinks } from './extensions';

/** Même règle que le serveur : http(s), mailto, chemin interne ou ancre. */
export const isSafeHref = (h) => typeof h === 'string' && (/^(https?:\/\/|mailto:)/i.test(h.trim()) || /^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h));

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Commandes du menu « / ». `pick(kind)` ouvre le sélecteur de fichier (image ou fichier joint). */
function slashItems(pick) {
  const items = [
    ['Texte', 'paragraphe', Pilcrow, (e) => e.chain().focus().setParagraph().run()],
    ['Titre 1', 'h1 titre', Heading1, (e) => e.chain().focus().setHeading({ level: 1 }).run()],
    ['Titre 2', 'h2 titre section', Heading2, (e) => e.chain().focus().setHeading({ level: 2 }).run()],
    ['Titre 3', 'h3 titre sous-section', Heading3, (e) => e.chain().focus().setHeading({ level: 3 }).run()],
    ['Liste à puces', 'liste puces ul', List, (e) => e.chain().focus().toggleBulletList().run()],
    ['Liste numérotée', 'liste numero ol', ListOrdered, (e) => e.chain().focus().toggleOrderedList().run()],
    ['Liste de tâches', 'liste taches todo checklist case', ListChecks, (e) => e.chain().focus().toggleTaskList().run()],
    ['Citation', 'citation quote', Quote, (e) => e.chain().focus().toggleBlockquote().run()],
    ['Bloc de code', 'code bash sql script', SquareCode, (e) => e.chain().focus().toggleCodeBlock().run()],
    ['Tableau', 'tableau table grille', TableIcon, (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()],
    ['Séparateur', 'separateur ligne hr', Minus, (e) => e.chain().focus().setHorizontalRule().run()],
    ['Image', 'image photo capture', ImagePlus, () => pick('image')],
    ['Fichier joint', 'fichier piece jointe pdf document', Paperclip, () => pick('file')],
    ...CALLOUTS.map(([v, label, emoji]) => [`Encadré ${label.toLowerCase()}`, `encadre callout ${label} ${v}`, emoji, (e) => e.chain().focus().setCallout(v).run()]),
    ['Bloc dépliable', 'depliable details toggle accordeon', ChevronsDownUp, (e) => e.chain().focus().setDetails().run()],
    ['Lien vers une page', 'lien page wiki [[', FileText, (e) => e.chain().focus().insertContent('[[').run()],
  ];
  return items.map(([title, keys, Icon, run]) => ({ title, icon: typeof Icon === 'string' ? Icon : <Icon size={14} />, run, search: norm(`${title} ${keys}`) }));
}

function buildExtensions({ placeholder, collab, pickRef, pagesRef }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: false,
      ...(collab ? { undoRedo: false } : {}),
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['mailto'],
        isAllowedUri: (url) => isSafeHref(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    CodeBlock,
    Highlight,
    Image.configure({ inline: false, allowBase64: false }),
    FileAttachment,
    Callout,
    Details.configure({ persist: true, HTMLAttributes: { class: 'kz-details' } }),
    DetailsSummary,
    DetailsContent,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow, TableHeader, TableCell,
    Placeholder.configure({ placeholder, includeChildren: false }),
    SlashCommands.configure({ items: () => slashItems((kind) => pickRef.current?.(kind)) }),
    WikiLinks.configure({ pages: () => pagesRef.current ?? [] }),
    ...(collab ? [
      collab.extensions.Collaboration.configure({ document: collab.ydoc }),
      collab.extensions.CollaborationCaret.configure({ provider: collab.provider, user: collab.user }),
    ] : []),
  ];
}

function Tool({ on, active, disabled, label, children }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active ?? undefined} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={on}
      className={`p-1.5 rounded text-gray-600 dark:text-gray-300 disabled:opacity-30 ${active ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300' : 'hover:bg-gray-100 dark:hover:bg-slate-800'}`}>
      {children}
    </button>
  );
}

function Toolbar({ editor, onPick }) {
  const [calloutMenu, setCalloutMenu] = useState(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), underline: e.isActive('underline'),
      code: e.isActive('code'), highlight: e.isActive('highlight'), link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      quote: e.isActive('blockquote'), codeBlock: e.isActive('codeBlock'), table: e.isActive('table'),
      callout: e.isActive('callout'), details: e.isActive('details'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const setLink = () => {
    const prev = editor.getAttributes('link').href ?? '';
    const href = window.prompt('Adresse du lien (https://…, mailto:… ou /wiki/…). Vide pour retirer le lien. Astuce : tapez [[ dans le texte pour lier une page.', prev);
    if (href === null) return;
    if (!href.trim()) return c().extendMarkRange('link').unsetLink().run();
    if (!isSafeHref(href)) return window.alert('Adresse refusée : seuls http(s), mailto et les liens internes sont autorisés.');
    c().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };
  const sep = <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />;
  return (
    <div role="toolbar" aria-label="Mise en forme" className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 px-2 py-1 border-b border-gray-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 rounded-t-lg">
      <Tool label="Annuler (Ctrl+Z)" on={() => c().undo().run()} disabled={!s.undo}><Undo2 size={16} /></Tool>
      <Tool label="Rétablir (Ctrl+Y)" on={() => c().redo().run()} disabled={!s.redo}><Redo2 size={16} /></Tool>
      {sep}
      <Tool label="Titre 1" active={s.h1} on={() => c().toggleHeading({ level: 1 }).run()}><Heading1 size={16} /></Tool>
      <Tool label="Titre 2" active={s.h2} on={() => c().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></Tool>
      <Tool label="Titre 3" active={s.h3} on={() => c().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></Tool>
      {sep}
      <Tool label="Gras (Ctrl+B)" active={s.bold} on={() => c().toggleBold().run()}><Bold size={16} /></Tool>
      <Tool label="Italique (Ctrl+I)" active={s.italic} on={() => c().toggleItalic().run()}><Italic size={16} /></Tool>
      <Tool label="Souligné (Ctrl+U)" active={s.underline} on={() => c().toggleUnderline().run()}><Underline size={16} /></Tool>
      <Tool label="Barré" active={s.strike} on={() => c().toggleStrike().run()}><Strikethrough size={16} /></Tool>
      <Tool label="Surligné" active={s.highlight} on={() => c().toggleHighlight().run()}><Highlighter size={16} /></Tool>
      <Tool label="Code en ligne" active={s.code} on={() => c().toggleCode().run()}><Code size={16} /></Tool>
      <Tool label="Lien" active={s.link} on={setLink}><Link2 size={16} /></Tool>
      {sep}
      <Tool label="Liste à puces" active={s.bullet} on={() => c().toggleBulletList().run()}><List size={16} /></Tool>
      <Tool label="Liste numérotée" active={s.ordered} on={() => c().toggleOrderedList().run()}><ListOrdered size={16} /></Tool>
      <Tool label="Liste de tâches" active={s.task} on={() => c().toggleTaskList().run()}><ListChecks size={16} /></Tool>
      <Tool label="Citation" active={s.quote} on={() => c().toggleBlockquote().run()}><Quote size={16} /></Tool>
      <Tool label="Bloc de code (langage au choix)" active={s.codeBlock} on={() => c().toggleCodeBlock().run()}><SquareCode size={16} /></Tool>
      <span className="relative">
        <Tool label="Encadré" active={s.callout} on={() => setCalloutMenu((v) => !v)}><MessageSquareWarning size={16} /></Tool>
        {calloutMenu && (
          <span role="menu" className="absolute left-0 top-8 z-20 w-44 rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-1">
            {CALLOUTS.map(([v, label, emoji]) => (
              <button key={v} type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { c().setCallout(v).run(); setCalloutMenu(false); }}
                className="w-full text-left px-2 py-1 text-sm rounded hover:bg-gray-100 dark:hover:bg-slate-800 dark:text-gray-200">{emoji} {label}</button>
            ))}
            {s.callout && (
              <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { c().unsetCallout().run(); setCalloutMenu(false); }}
                className="w-full text-left px-2 py-1 text-sm rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">Retirer l&apos;encadré</button>
            )}
          </span>
        )}
      </span>
      <Tool label="Bloc dépliable" active={s.details} on={() => (s.details ? c().unsetDetails().run() : c().setDetails().run())}><ChevronsDownUp size={16} /></Tool>
      <Tool label="Séparateur" on={() => c().setHorizontalRule().run()}><Minus size={16} /></Tool>
      {sep}
      <Tool label="Insérer une image (ou coller / glisser)" on={() => onPick('image')}><ImagePlus size={16} /></Tool>
      <Tool label="Joindre un fichier (ou glisser)" on={() => onPick('file')}><Paperclip size={16} /></Tool>
      <Tool label="Insérer un tableau" on={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={16} /></Tool>
      {s.table && <>
        <Tool label="Ajouter une colonne" on={() => c().addColumnAfter().run()}><Columns3 size={16} /></Tool>
        <Tool label="Ajouter une ligne" on={() => c().addRowAfter().run()}><Rows3 size={16} /></Tool>
        <Tool label="Supprimer la colonne" on={() => c().deleteColumn().run()}><Columns3 size={16} className="text-red-500" /></Tool>
        <Tool label="Supprimer la ligne" on={() => c().deleteRow().run()}><Rows3 size={16} className="text-red-500" /></Tool>
        <Tool label="Supprimer le tableau" on={() => c().deleteTable().run()}><Trash2 size={16} className="text-red-500" /></Tool>
      </>}
    </div>
  );
}

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

/**
 * editable=false : rendu en lecture (mêmes règles d'affichage que l'édition).
 * onUploadFile(file) -> { url, inline, filename, size, mimetype } | null : envoi d'un fichier (image affichée ou fichier joint).
 * onNavigate : liens internes (/…) suivis dans l'application, sans recharger la page.
 * pages : pages du wiki proposées par « [[ ».
 * collab : { ydoc, provider, user, seed } pour la co-édition ; le contenu vient alors du document partagé.
 */
export function WikiEditor({ content, editable = false, onChange, onUploadFile, onNavigate, onReady, pages, collab, placeholder = 'Commencez à écrire, ou tapez « / » pour insérer un bloc…' }) {
  const fileRef = useRef(null);
  const kindRef = useRef('file');
  const pickRef = useRef(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const uploadRef = useRef(onUploadFile);
  uploadRef.current = onUploadFile;
  const editorRef = useRef(null);

  // Envoi puis insertion (image affichée, ou carte de fichier joint) à la position donnée
  const insertFiles = async (files, pos) => {
    const e = editorRef.current;
    if (!e || !uploadRef.current) return;
    if (typeof pos === 'number') e.commands.setTextSelection(pos);
    for (const file of files) {
      const r = await uploadRef.current(file);
      if (!r) continue;
      const node = r.inline
        ? { type: 'image', attrs: { src: r.url, alt: r.filename } }
        : { type: 'fileAttachment', attrs: { src: r.url, filename: r.filename, size: r.size, mimetype: r.mimetype } };
      // Insertion après la sélection (jamais à la place d'un bloc sélectionné, ex. le fichier précédent)
      e.chain().focus().insertContentAt(e.state.selection.to, node).run();
    }
  };

  const editor = useEditor({
    extensions: buildExtensions({ placeholder, collab, pickRef, pagesRef }),
    ...(collab ? {} : { content }),
    editable,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'kz-prose focus:outline-none', 'aria-label': 'Contenu de la page', ...(editable ? {} : { 'aria-readonly': 'true' }) },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !view.editable || !uploadRef.current) return false;
        event.preventDefault();
        insertFiles(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (moved || !files.length || !view.editable || !uploadRef.current) return false;
        event.preventDefault();
        insertFiles(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => onChange?.(e.getJSON()),
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
      // Co-édition : le premier éditeur initialise le document partagé avec le contenu enregistré
      // (différé : l'éditeur est créé pendant le rendu, et setContent déclenche onChange chez le parent)
      if (collab?.seed && content) setTimeout(() => { if (!e.isDestroyed) e.commands.setContent(content); }, 0);
      if (onReady) setTimeout(() => onReady(e), 0);
    },
  });
  editorRef.current = editor;

  pickRef.current = (kind) => {
    kindRef.current = kind;
    if (fileRef.current) {
      fileRef.current.accept = kind === 'image' ? IMAGE_TYPES : '';
      fileRef.current.click();
    }
  };
  const onFilePicked = async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) await insertFiles(files);
  };

  // Nouveau contenu reçu (autre page, rechargement après modification d'un tiers) en lecture seule
  useEffect(() => {
    if (editor && !editable && !collab && content) editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, content, editable, collab]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);

  const onClick = (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || editable) return;
    const href = a.getAttribute('href');
    if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')) { e.preventDefault(); onNavigate?.(href); return; }
    if (/^https?:/i.test(href)) { e.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer'); }
  };

  if (!editor) return null;
  return (
    <div className={editable ? 'border border-gray-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900' : ''}>
      {editable && <Toolbar editor={editor} onPick={(k) => pickRef.current(k)} />}
      {editable && <input ref={fileRef} type="file" multiple className="hidden" onChange={onFilePicked} aria-label="Fichier à insérer" />}
      <div onClick={onClick} className={editable ? 'px-4 py-3 min-h-[50vh]' : ''}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
