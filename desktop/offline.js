/* Shown when the company server cannot be reached; retries by itself every 15 seconds. */
const params = new URLSearchParams(location.search);
document.getElementById('url').textContent = params.get('url') || '';
document.getElementById('error').textContent = params.get('error') ? `Λεπτομέρειες: ${params.get('error')}` : '';
const retry = () => window.imsDesktop?.retry();
document.getElementById('retry').addEventListener('click', retry);
document.getElementById('change').addEventListener('click', () => window.imsDesktop?.changeServer());
let left = 15;
const tick = () => {
  document.getElementById('countdown').textContent = `Νέα προσπάθεια σε ${left} δευτερόλεπτα…`;
  if (left-- <= 0) {
    left = 15;
    retry();
  }
};
tick();
setInterval(tick, 1000);
