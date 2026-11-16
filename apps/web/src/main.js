const app = document.querySelector('#app');
app.textContent = 'HomeyVibe';

fetch('/api/health')
  .then((r) => r.json())
  .then((s) => { app.textContent = `HomeyVibe (server ok: ${s.ok})`; })
  .catch(() => { app.textContent = 'HomeyVibe (server offline)'; });
