// Blocs dynamiques de l'éditeur : liste des sous-pages, sommaire de la page, diagramme Mermaid.
// Ils ne stockent rien d'autre que leur type : le contenu est calculé à l'affichage (arborescence, titres, code).
import { useEffect, useId, useState } from 'react';
import { NodeViewWrapper, useEditorState } from '@tiptap/react';
import { FileText, ListTree, Network } from 'lucide-react';

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title);

function Tree({ pages, parentId, depth }) {
  const children = pages.filter((p) => p.parentId === parentId).sort(byPosition);
  if (!children.length) return null;
  return (
    <ul className={depth ? 'kz-subpages-nested' : 'kz-subpages-list'}>
      {children.map((p) => (
        <li key={p.id}>
          <a href={`/wiki/${p.id}`} className="kz-subpages-link"><FileText size={13} aria-hidden="true" /> {p.icon ? `${p.icon} ` : ''}{p.title}</a>
          {depth < 2 && <Tree pages={pages} parentId={p.id} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/** Sous-pages de la page courante (trois niveaux), limitées à ce que l'utilisateur peut voir. */
export function SubpagesView({ editor, extension, selected }) {
  // Arborescence relue à chaque transaction : l'éditeur en signale une quand la liste des pages arrive ou change
  const snapshot = useEditorState({
    editor,
    selector: () => JSON.stringify({ pageId: extension.options.pageId(), pages: (extension.options.pages() ?? []).map(({ id, parentId, title, icon, position }) => ({ id, parentId, title, icon, position })) }),
  });
  const { pageId, pages } = JSON.parse(snapshot);
  const has = pageId && pages.some((p) => p.parentId === pageId);
  return (
    <NodeViewWrapper className={`kz-block kz-subpages ${selected ? 'kz-block-selected' : ''}`} data-type="subpages" contentEditable={false}>
      <p className="kz-block-title"><ListTree size={14} aria-hidden="true" /> Sous-pages</p>
      {has ? <Tree pages={pages} parentId={pageId} depth={0} /> : <p className="kz-block-empty">{pageId ? 'Aucune sous-page pour l\'instant.' : 'Liste des sous-pages (affichée sur la page).'}</p>}
    </NodeViewWrapper>
  );
}

/** Sommaire construit à partir des titres du document, mis à jour pendant la saisie. */
export function TocView({ editor, selected }) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const out = [];
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && n.textContent.trim()) out.push({ pos, level: n.attrs.level, text: n.textContent.trim() });
      });
      return JSON.stringify(out);
    },
  });
  const list = JSON.parse(headings);
  const go = (e, pos) => {
    e.preventDefault();
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) { dom.scrollIntoView({ behavior: 'smooth', block: 'start' }); dom.setAttribute('tabindex', '-1'); dom.focus({ preventScroll: true }); }
  };
  const min = Math.min(...list.map((h) => h.level));
  return (
    <NodeViewWrapper as="nav" aria-label="Sommaire" className={`kz-block kz-toc ${selected ? 'kz-block-selected' : ''}`} data-type="toc" contentEditable={false}>
      <p className="kz-block-title"><ListTree size={14} aria-hidden="true" /> Sommaire</p>
      {list.length === 0 ? <p className="kz-block-empty">Ajoutez des titres pour construire le sommaire.</p> : (
        <ol className="kz-toc-list">
          {list.map((h) => (
            <li key={h.pos} style={{ paddingLeft: `${(h.level - min) * 1}rem` }}>
              <a href={`#h-${h.pos}`} onClick={(e) => go(e, h.pos)}>{h.text}</a>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
}

// --- Mermaid : bibliothèque embarquée dans le paquet, chargée à la première utilisation (aucun CDN) ---
let mermaidPromise = null;
function loadMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict', // pas de HTML ni de clic JavaScript dans les diagrammes, rendu assaini
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
      fontFamily: 'inherit',
      flowchart: { htmlLabels: false },
    });
    return m;
  });
  return mermaidPromise;
}
let renderQueue = Promise.resolve(); // Mermaid ne supporte pas les rendus simultanés

/** Rendu d'un diagramme Mermaid à partir de son code ; message clair si la syntaxe est invalide. */
export function MermaidDiagram({ code }) {
  const rid = useId().replace(/[^\w]/g, '');
  const [state, setState] = useState({ svg: '', error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const src = code.trim();
    if (!src) { setState({ svg: '', error: null, loading: false }); return undefined; }
    const t = setTimeout(() => {
      renderQueue = renderQueue.then(async () => {
        const id = `kz-mmd-${rid}-${Date.now()}`;
        try {
          const m = await loadMermaid();
          const { svg } = await m.render(id, src);
          if (alive) setState({ svg, error: null, loading: false });
        } catch (e) {
          if (alive) setState({ svg: '', error: String(e?.message ?? e).split('\n').slice(0, 3).join(' '), loading: false });
        } finally {
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
        }
      });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [code, rid]);
  if (state.error) return <p role="alert" className="kz-mermaid-error">Diagramme invalide : {state.error}</p>;
  if (state.loading && !state.svg) return <p className="kz-block-empty"><Network size={13} className="inline" aria-hidden="true" /> Rendu du diagramme…</p>;
  // SVG produit par Mermaid en mode strict (assaini par DOMPurify), jamais du HTML saisi par l'utilisateur
  return <div className="kz-mermaid" role="img" aria-label="Diagramme" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
