import './style.css';
import { api } from './api.js';
import { renderSetup, renderLogin } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';

const root = document.querySelector('#app');

async function start() {
  let user;
  try {
    const status = await api.status();
    user = status.user ?? (status.needsSetup ? await renderSetup(root) : await renderLogin(root));
  } catch (err) {
    root.textContent = `Cannot reach the HomeyVibe server (${err.message}). Retrying…`;
    setTimeout(start, 3000);
    return;
  }
  renderDashboard(root, user, start);
}

start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
