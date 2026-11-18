import { h, toast } from './ui.js';

let prompt;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  prompt = event;
});
window.addEventListener('appinstalled', () => { prompt = null; });

/** Offer installation from the signed-in dashboard menu. */
export function installButton() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return null;
  return h('button', { type: 'button', onclick: async () => {
    if (prompt) {
      const request = prompt;
      prompt = null;
      try { await request.prompt(); } catch (err) { toast(err.message); }
    } else {
      toast(isSecureContext ? 'Use your browser’s Install app or Add to Home Screen menu.'
        : 'Open the HTTPS address to install HomeyVibe.');
    }
  } }, 'Install app');
}
