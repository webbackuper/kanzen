// Petits composants partagés
import { useEffect, useRef, useState } from 'react';

export const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50';
export const btnPrimary = `${btn} bg-indigo-600 text-white hover:bg-indigo-700`;
export const btnGhost = `${btn} text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800`;
export const btnDanger = `${btn} text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30`;
export const input = 'w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none';
export const card = 'bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl';

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div role="alert" className="p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-200 text-sm">{String(error.message ?? error)}</div>;
}

export function Loading() {
  return <div className="p-10 text-center text-gray-500 dark:text-gray-400">Chargement…</div>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Accessibilité (RGAA 7.1 / 12.8) : focus placé dans la fenêtre, piégé tant qu'elle est ouverte, rendu à l'élément
    // d'origine à la fermeture ; Échap ferme.
    const opener = document.activeElement;
    const box = ref.current;
    const first = box?.querySelector('[autofocus]') ?? box?.querySelector(FOCUSABLE);
    (first ?? box)?.focus();
    const k = (e) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const [a, z] = [items[0], items.at(-1)];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`${card} w-full ${wide ? 'max-w-3xl' : 'max-w-md'} mt-12 p-6 shadow-xl focus:outline-none`}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button onClick={onClose} className={btnGhost} aria-label="Fermer">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Message temporaire avec action (ex. « Annuler »), annoncé aux lecteurs d'écran. */
export function Toast({ message, action, onAction, onClose }) {
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-lg bg-slate-900 text-white text-sm dark:bg-slate-100 dark:text-slate-900">
      <span>{message}</span>
      {action && <button type="button" className="font-semibold underline underline-offset-2" onClick={onAction}>{action}</button>}
      {onClose && <button type="button" aria-label="Fermer" onClick={onClose}>✕</button>}
    </div>
  );
}

/** Élément actif = zone de saisie : les raccourcis clavier globaux ne doivent pas s'y déclencher. */
export const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/** Charge une ressource API et expose { data, error, reload }. */
export function useApi(loader, deps) {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loader().then((data) => alive && setState({ data, error: null }), (error) => alive && setState({ data: null, error }));
    return () => { alive = false; };
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export const ROLE_LABEL = { OWNER: 'Propriétaire', EDITOR: 'Éditeur', VIEWER: 'Lecteur' };
