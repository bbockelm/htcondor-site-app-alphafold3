// Integration with the access point that serves this app.
//
// Everything here is about one question: where am I, and who is looking
// at me? Both answers come from the server at page load, and neither
// should be guessed at.

/** What the access point injects into the page before serving it. */
export interface HTCondorApp {
  /** The app id, which is the bundle's file name without .zip. */
  id: string;
  /** Where this app is mounted, with a trailing slash: "/site/cryoem/". */
  base: string;
  /** The name from app.yaml. */
  name: string;
}

declare global {
  interface Window {
    __HTCONDOR_APP__?: HTCondorApp;
  }
}

// In development there is no access point injecting anything, so fall
// back to the root. Do NOT infer the base from location.pathname: a
// route like /site/cryoem/jobs/12 is indistinguishable from a deeper
// mount point, and the guess is wrong exactly when a user has navigated
// somewhere before reloading.
const DEV_FALLBACK: HTCondorApp = { id: 'dev', base: '/', name: 'Development' };

export const app: HTCondorApp = window.__HTCONDOR_APP__ ?? DEV_FALLBACK;

/**
 * Build an in-app URL. Use this for anything that goes into history or
 * an href; `app.base` already carries the trailing slash.
 */
export function appUrl(path = ''): string {
  return app.base + path.replace(/^\//, '');
}

/** Who is logged in. The shape the server returns from /api/v1/auth/me. */
export interface Identity {
  authenticated: boolean;
  username?: string;
  groups?: string[];
  is_admin?: boolean;
}

/**
 * Send the browser to the login page, returning here afterwards.
 *
 * The session cookie is the only credential this app has or needs; when
 * it expires the API answers 401 and there is nothing to refresh. The
 * API client calls this for you on a 401.
 */
export function redirectToLogin(): void {
  const returnTo = window.location.pathname + window.location.search;
  window.location.href = `/login?return_to=${encodeURIComponent(returnTo)}`;
}
