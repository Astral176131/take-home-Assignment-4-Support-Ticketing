import { Link, useLocation } from 'react-router-dom';
import { usePageMeta } from '../lib/usePageMeta';

/**
 * Shown for any address inside the app that does not resolve.
 *
 * This used to redirect silently to the dashboard, which is worse than it looks:
 * a stale link, a typo and a working link all ended up on the same screen, so
 * there was no way to tell that the thing you asked for was not there.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();

  usePageMeta(
    'Page not found',
    'There is no page at this address in Support Desk. Head back to the dashboard, or search the queue to find the ticket you were looking for by subject or key.'
  );

  return (
    <div className="page">
      <div className="notfound">
        <p className="notfound-code">404</p>
        <h1>There is no page at this address</h1>
        <p>
          {/* The punctuation is joined to the code span deliberately: left on its
              own line JSX inserts a space and it renders as "/nope ." */}
          Nothing is served at <code>{pathname}</code>
          {'. '}The link may be out of date, or the address may have a typo in it. Ticket
          links look like <code>/tickets/</code>
          {' followed by the ticket id.'}
        </p>
        <div className="notfound-actions">
          <Link className="btn btn-primary" to="/">
            Go to the dashboard
          </Link>
          <Link className="btn" to="/tickets">
            Search the queue
          </Link>
        </div>
      </div>
    </div>
  );
}
