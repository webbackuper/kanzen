// Liste déroulante des menus de suggestion (« / » et « [[ »), pilotée au clavier.
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

export const SuggestionList = forwardRef(function SuggestionList({ items, command }, ref) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [items]);
  const pick = (i) => { const item = items[i]; if (item) command(item); };
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') { setIndex((i) => (i + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setIndex((i) => (i + items.length - 1) % items.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { pick(index); return true; }
      return false;
    },
  }), [items, index]);

  return (
    <div role="listbox" aria-label="Suggestions" className="w-72 max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1">
      {items.length === 0 ? <p className="text-sm text-gray-500 px-3 py-2">Aucun résultat</p> : items.map((item, i) => (
        <button
          key={item.id ?? item.title} type="button" role="option" aria-selected={i === index}
          onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setIndex(i)}
          className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-sm ${i === index ? 'bg-indigo-50 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-200'}`}
        >
          {item.icon && <span className="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-gray-200 dark:border-slate-700 text-gray-500">{item.icon}</span>}
          <span className="min-w-0">
            <span className="block truncate">{item.title}</span>
            {item.hint && <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{item.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
});
