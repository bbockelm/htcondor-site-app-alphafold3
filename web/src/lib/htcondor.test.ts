import { describe, it, expect, afterEach } from 'vitest';
import { siteProvidesNavigation } from './htcondor';

describe('whether the access point gave this page a way back', () => {
  afterEach(() => {
    document.head.querySelectorAll('script').forEach((s) => s.remove());
  });

  it('sees the script the server injects', () => {
    const s = document.createElement('script');
    s.src = '/site/_shell.js';
    document.head.append(s);
    expect(siteProvidesNavigation()).toBe(true);
  });

  it('reports none when the server injected nothing', () => {
    // An access point from before the bar existed. The app then has to
    // offer its own link, or there is no way out of the page.
    expect(siteProvidesNavigation()).toBe(false);
  });

  it('is not fooled by some other script', () => {
    const s = document.createElement('script');
    s.src = '/site/myapp/assets/index-abc123.js';
    document.head.append(s);
    expect(siteProvidesNavigation()).toBe(false);
  });

  it('asks about the TAG, not the bar the script later draws', () => {
    // The bar is rendered after the script loads and fetches
    // /api/v1/auth/me. Looking for the bar would be a race whose
    // usual outcome is two ways back on the same page; the tag is in
    // the HTML the server sent, before anything runs.
    const bar = document.createElement('div');
    bar.className = 'bar';
    document.body.append(bar);
    expect(siteProvidesNavigation()).toBe(false);
    bar.remove();
  });
});
