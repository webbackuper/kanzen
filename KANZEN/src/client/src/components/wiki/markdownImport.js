// Import Markdown -> document ProseMirror du wiki (mêmes nœuds que l'éditeur ; le serveur revalide tout).
// Les images distantes ou relatives ne sont pas importées (le wiki n'affiche que les fichiers stockés dans KanZen) :
// elles deviennent un lien texte.
import { marked } from 'marked';

const text = (t, marks) => (t ? [{ type: 'text', text: t, ...(marks?.length ? { marks } : {}) }] : []);
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const safeHref = (h) => (/^(https?:\/\/|mailto:)/i.test(h) || /^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h) ? h : null);

function inline(tokens = [], marks = []) {
  const out = [];
  for (const tk of tokens) {
    switch (tk.type) {
      case 'text':
      case 'escape':
        if (tk.tokens?.length) out.push(...inline(tk.tokens, marks));
        else out.push(...text(decode(tk.text), marks));
        break;
      case 'strong': out.push(...inline(tk.tokens, [...marks, { type: 'bold' }])); break;
      case 'em': out.push(...inline(tk.tokens, [...marks, { type: 'italic' }])); break;
      case 'del': out.push(...inline(tk.tokens, [...marks, { type: 'strike' }])); break;
      case 'codespan': out.push(...text(decode(tk.text), [...marks, { type: 'code' }])); break;
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'link': {
        const href = safeHref(tk.href ?? '');
        out.push(...inline(tk.tokens, href ? [...marks, { type: 'link', attrs: { href } }] : marks));
        break;
      }
      case 'image': out.push(...text(`[image : ${tk.text || tk.href}]`, marks)); break;
      case 'html': out.push(...text(decode(tk.text.replace(/<[^>]*>/g, '')), marks)); break;
      default: if (tk.text) out.push(...text(decode(tk.text), marks));
    }
  }
  return out;
}

const para = (tokens) => { const c = inline(tokens); return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' }; };

function blocks(tokens = []) {
  const out = [];
  for (const tk of tokens) {
    switch (tk.type) {
      case 'heading': out.push({ type: 'heading', attrs: { level: Math.min(tk.depth, 4) }, content: inline(tk.tokens) }); break;
      case 'paragraph': out.push(para(tk.tokens)); break;
      case 'text': out.push(para(tk.tokens ?? [{ type: 'text', text: tk.text }])); break;
      case 'code': out.push({ type: 'codeBlock', ...(tk.lang && /^[\w+#-]{1,30}$/.test(tk.lang) ? { attrs: { language: tk.lang.toLowerCase() } } : {}), ...(tk.text ? { content: [{ type: 'text', text: tk.text }] } : {}) }); break;
      case 'blockquote': out.push({ type: 'blockquote', content: blocks(tk.tokens).length ? blocks(tk.tokens) : [{ type: 'paragraph' }] }); break;
      case 'hr': out.push({ type: 'horizontalRule' }); break;
      case 'list': {
        const isTask = tk.items.some((i) => i.task);
        const type = isTask ? 'taskList' : tk.ordered ? 'orderedList' : 'bulletList';
        out.push({
          type,
          ...(tk.ordered && !isTask ? { attrs: { start: Number(tk.start) || 1 } } : {}),
          content: tk.items.map((i) => {
            const content = blocks(i.tokens.filter((x) => x.type !== 'checkbox'));
            return { type: isTask ? 'taskItem' : 'listItem', ...(isTask ? { attrs: { checked: Boolean(i.checked) } } : {}), content: content.length ? content : [{ type: 'paragraph' }] };
          }),
        });
        break;
      }
      case 'table': {
        const row = (cells, header) => ({ type: 'tableRow', content: cells.map((c) => ({ type: header ? 'tableHeader' : 'tableCell', content: [para(c.tokens)] })) });
        out.push({ type: 'table', content: [row(tk.header, true), ...tk.rows.map((r) => row(r, false))] });
        break;
      }
      case 'html': { const s = decode(tk.text.replace(/<[^>]*>/g, '')).trim(); if (s) out.push({ type: 'paragraph', content: text(s) }); break; }
      case 'space': break;
      default: if (tk.text) out.push({ type: 'paragraph', content: text(tk.text) });
    }
  }
  return out;
}

/** Markdown -> { title, content }. Le premier titre de niveau 1 devient le titre de la page. */
export function markdownToPage(md, fallbackTitle = 'Page importée') {
  const tokens = marked.lexer(md.replace(/\r\n?/g, '\n'), { gfm: true });
  let title = fallbackTitle;
  const first = tokens.findIndex((t) => t.type !== 'space');
  if (first >= 0 && tokens[first].type === 'heading' && tokens[first].depth === 1) {
    title = tokens[first].text.trim().slice(0, 200) || fallbackTitle;
    tokens.splice(first, 1);
  }
  const content = blocks(tokens);
  return { title, content: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } };
}
