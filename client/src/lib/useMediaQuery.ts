import { useEffect, useState } from 'react';

/**
 * Tracks a media query so a component can change what it renders, not just how
 * it looks.
 *
 * Most responsive work belongs in CSS. This is for the cases where the markup
 * itself has to differ: a ten-column table cannot be made readable on a 320px
 * screen by styling alone, and rendering both shapes at once would duplicate
 * every ticket in the accessibility tree.
 *
 * Returns false where `matchMedia` is unavailable (jsdom, older engines), which
 * keeps the wider layout as the fallback rather than the narrow one.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);

    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
