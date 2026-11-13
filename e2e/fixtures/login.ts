import type { Page } from '@playwright/test';

/**
 * Log in through the real OAuth flow a user walks:
 *
 *   /login -> /idp/authorize -> /idp/login -> POST -> callback -> cookie
 *
 * There is no shortcut. `/api/v1/auth/me` resolves the browser session
 * cookie and nothing else -- not a bearer token, not a header -- so a
 * test without a real session sees a logged-out app and assertions as
 * loose as "the page rendered" pass against the redirect to /login.
 */
export async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');

  const field = page.locator('input[name="username"]');
  if (!(await field.count())) {
    // Without this, a misconfigured server produces a fill() timeout
    // and you spend an afternoon on the wrong problem.
    const body = (await page.locator('body').innerText()).slice(0, 300);
    throw new Error(`expected the IDP login form, got: ${body}`);
  }

  await field.fill(username);
  await page.locator('input[name="password"]').fill(password);

  // Watch the POST rather than only the URL. Bad credentials do not
  // re-render the form -- the IDP answers 401 with JSON and the browser
  // stays put -- so a URL-only wait reports "timeout" instead of "the
  // password was wrong", once per test.
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/idp/login') && r.request().method() === 'POST'),
    page.locator('form[action="/idp/login"] [type="submit"]').click(),
  ]);
  if (resp.status() >= 400) {
    throw new Error(`IDP rejected the login (${resp.status()}): ${(await resp.text()).slice(0, 200)}`);
  }

  await page.waitForURL((u) => !u.pathname.startsWith('/idp/'), { timeout: 30_000 });
}

/** Credentials as demo mode writes them to its credentials file. */
export interface DemoCredentials {
  version: number;
  users: { username: string; password: string; state: string }[];
}

export function passwordFor(creds: DemoCredentials, username: string): string {
  const user = creds.users.find((u) => u.username === username);
  if (!user) {
    throw new Error(
      `demo credentials have no user ${username}; found: ${creds.users.map((u) => u.username).join(', ')}`,
    );
  }
  return user.password;
}
