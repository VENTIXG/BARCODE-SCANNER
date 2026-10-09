/* Start screen: company server or this PC only (bridge: window.imsSetup from preload.cjs). */
const bridge = window.imsSetup;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const url = $('url');
const msg = $('remote-msg');

url.value = params.get('server') || '';
if (params.get('mode') === 'remote') $('remote-card').classList.add('current');
if (params.get('mode') === 'local') $('local-card').classList.add('current');
if (params.get('localData')) {
  $('local-data-note').hidden = false;
  $('move-note').hidden = false;
}
$('version').textContent = `Έκδοση εφαρμογής ${bridge.appVersion}`;
url.focus();

function show(text, tone) {
  msg.textContent = text;
  msg.className = `msg ${tone || ''}`;
}

function busy(on) {
  for (const id of ['test', 'connect', 'local']) $(id).disabled = on;
}

async function test() {
  busy(true);
  show('Σύνδεση…');
  try {
    const r = await bridge.testServer(url.value);
    if (r.ok) {
      url.value = r.url;
      show(`Εντάξει: server Warehouse IMS, έκδοση ${r.version}.`, 'ok');
    } else show(r.error, 'bad');
    return r.ok;
  } finally {
    busy(false);
  }
}

async function connect() {
  busy(true);
  show('Σύνδεση…');
  try {
    const r = await bridge.useServer(url.value);
    if (r.ok) show('Συνδέθηκε. Η εφαρμογή ανοίγει ξανά…', 'ok');
    else show(r.error, 'bad');
  } catch (e) {
    show(String(e.message || e), 'bad');
  } finally {
    busy(false);
  }
}

$('test').addEventListener('click', () => void test());
$('connect').addEventListener('click', () => void connect());
url.addEventListener('keydown', (e) => e.key === 'Enter' && void connect());
$('local').addEventListener('click', async () => {
  busy(true);
  await bridge.useLocal();
});
