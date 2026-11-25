// Éditeur riche du wiki (TipTap / ProseMirror). Le document est échangé en JSON avec le serveur,
// qui le revalide : l'éditeur ne produit jamais de HTML stocké.
import { useEffect, useRef } from 'react';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import {
  Bold, Italic, Strikethrough, Underline, Code, Highlighter, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, SquareCode, Minus, Link2, ImagePlus, Table as TableIcon, Undo2, Redo2, Columns3, Rows3, Trash2,
} from 'lucide-react';

/** Même règle que le serveur : http(s), mailto, chemin interne ou ancre. */
export const isSafeHref = (h) => typeof h === 'string' && (/^(https?:\/\/|mailto:)/i.test(h.trim()) || /^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h));

function extensions(placeholder) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['mailto'],
        isAllowedUri: (url) => isSafeHref(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    Highlight,
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow, TableHeader, TableCell,
    Placeholder.configure({ placeholder }),
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

function Toolbar({ editor, onUploadImage }) {
  const fileRef = useRef(null);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), underline: e.isActive('underline'),
      code: e.isActive('code'), highlight: e.isActive('highlight'), link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      quote: e.isActive('blockquote'), codeBlock: e.isActive('codeBlock'), table: e.isActive('table'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const setLink = () => {
    const prev = editor.getAttributes('link').href ?? '';
    const href = window.prompt('Adresse du lien (https://…, mailto:… ou /wiki/…). Vide pour retirer le lien.', prev);
    if (href === null) return;
    if (!href.trim()) return c().extendMarkRange('link').unsetLink().run();
    if (!isSafeHref(href)) return window.alert('Adresse refusée : seuls http(s), mailto et les liens internes sont autorisés.');
    c().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };
  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = await onUploadImage(file);
    if (url) c().setImage({ src: url, alt: file.name }).run();
  };
  const sep = <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />;
  return (
    <div role="toolbar" aria-label="Mise en forme" className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 px-2 py-1 border-b border-gray-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95">
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
      <Tool label="Code" active={s.code} on={() => c().toggleCode().run()}><Code size={16} /></Tool>
      <Tool label="Lien" active={s.link} on={setLink}><Link2 size={16} /></Tool>
      {sep}
      <Tool label="Liste à puces" active={s.bullet} on={() => c().toggleBulletList().run()}><List size={16} /></Tool>
      <Tool label="Liste numérotée" active={s.ordered} on={() => c().toggleOrderedList().run()}><ListOrdered size={16} /></Tool>
      <Tool label="Liste de tâches" active={s.task} on={() => c().toggleTaskList().run()}><ListChecks size={16} /></Tool>
      <Tool label="Citation" active={s.quote} on={() => c().toggleBlockquote().run()}><Quote size={16} /></Tool>
      <Tool label="Bloc de code" active={s.codeBlock} on={() => c().toggleCodeBlock().run()}><SquareCode size={16} /></Tool>
      <Tool label="Séparateur" on={() => c().setHorizontalRule().run()}><Minus size={16} /></Tool>
      {sep}
      <Tool label="Insérer une image" on={() => fileRef.current?.click()}><ImagePlus size={16} /></Tool>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={pickImage} aria-label="Image à insérer" />
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

/**
 * editable=false : rendu en lecture (mêmes règles d'affichage que l'édition).
 * onNavigate : liens internes (/…) suivis dans l'application, sans recharger la page.
 */
export function WikiEditor({ content, editable = false, onChange, onUploadImage, onNavigate, placeholder = 'Commencez à écrire…' }) {
  const editor = useEditor({
    extensions: extensions(placeholder),
    content,
    editable,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'kz-prose focus:outline-none', 'aria-label': 'Contenu de la page', ...(editable ? {} : { 'aria-readonly': 'true' }) } },
    onUpdate: ({ editor: e }) => onChange?.(e.getJSON()),
  });

  // Nouveau contenu reçu (autre page, rechargement après modification d'un tiers) en lecture seule
  useEffect(() => {
    if (editor && !editable && content) editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, content, editable]);
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
      {editable && <Toolbar editor={editor} onUploadImage={onUploadImage} />}
      <div onClick={onClick} className={editable ? 'px-4 py-3 min-h-[50vh]' : ''}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
