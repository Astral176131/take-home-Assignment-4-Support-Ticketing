import { useEffect } from 'react';

const SITE = 'Support Desk';

/**
 * Gives each route its own title and description.
 *
 * A single-page app ships one `index.html`, so without this every screen shares
 * the shell's title. That makes browser history, pinned tabs and a pasted link
 * all say the same thing regardless of where they point.
 *
 * The description is written per page rather than reused: it describes what is
 * on that screen, which is the only version of it worth having.
 */
export function usePageMeta(title: string, description: string) {
  useEffect(() => {
    document.title = `${title} - ${SITE}`;

    const tag = document.querySelector('meta[name="description"]');
    if (tag) tag.setAttribute('content', description);

    const og = document.querySelector('meta[property="og:title"]');
    if (og) og.setAttribute('content', `${title} - ${SITE}`);

    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', description);
  }, [title, description]);
}
