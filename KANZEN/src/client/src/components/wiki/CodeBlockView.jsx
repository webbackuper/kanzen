// Bloc de code : choix du langage (édition), étiquette et bouton « Copier » (lecture et édition).
import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { Check, Copy } from 'lucide-react';
import { LANGUAGES } from './extensions';

/** Copie dans le presse-papiers, y compris hors contexte sécurisé (HTTP sur l'intranet). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* repli ci-dessous */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function CodeBlockView({ node, updateAttributes, editor }) {
  const [copied, setCopied] = useState(false);
  const language = node.attrs.language ?? '';
  const label = LANGUAGES.find(([k]) => k === language)?.[1] ?? (language || 'Texte brut');
  const copy = async () => {
    if (await copyText(node.textContent)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return (
    <NodeViewWrapper className="kz-code relative group">
      <div contentEditable={false} className="kz-code-bar absolute right-2 top-1.5 flex items-center gap-1 text-xs select-none">
        {editor.isEditable ? (
          <select
            aria-label="Langage du bloc de code" value={language} onChange={(e) => updateAttributes({ language: e.target.value || null })}
            className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-1 py-0.5 text-xs"
          >
            <option value="">Texte brut</option>
            {LANGUAGES.filter(([k]) => k !== 'plaintext').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        ) : <span className="text-slate-400 px-1">{label}</span>}
        <button type="button" onClick={copy} title="Copier le code" aria-label="Copier le code"
          className="p-1 rounded text-slate-300 hover:bg-slate-700 opacity-70 group-hover:opacity-100 focus:opacity-100">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="hljs"><NodeViewContent as="code" className={language ? `language-${language}` : undefined} /></pre>
    </NodeViewWrapper>
  );
}
