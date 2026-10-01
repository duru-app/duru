const saved = JSON.parse(localStorage.getItem('FAKE_AUTH') ?? 'null');
const headers = saved ? { authorization: `Bearer ${saved.accessToken}` } : {};
document.getElementById('path').textContent = location.pathname;
if (saved) {
  fetch('/api/v1/me', { headers })
    .then((res) => (res.ok ? res.json() : null))
    .then((me) => {
      if (me) document.getElementById('who').textContent = me.name;
    });
}
document.getElementById('press').addEventListener('click', () =>
  fetch('/api/v1/press', { method: 'POST', headers })
    .then((res) => res.text())
    .then((text) => {
      document.getElementById('pressed').textContent = text;
    }));
