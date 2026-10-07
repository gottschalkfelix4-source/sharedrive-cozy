import { mountShell } from './sr-shell.js';

(async () => {
  let branding = { name: 'sharedrive', tagline: 'Rechtliches' };
  try {
    const config = await fetch('/api/config', { credentials: 'same-origin' }).then((r) => r.json());
    if (config?.branding) branding = { ...config.branding, tagline: 'Rechtliches' };
  } catch {
    /* Standardwerte genuegen */
  }
  mountShell({ branding, active: 'legal' });
})();
