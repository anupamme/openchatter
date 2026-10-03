// E2E: archived channels never render in the active sidebar, but member-owned
// archived channels remain discoverable (with a clear mark) in Browse and
// global channel search, and both entry points still open their read-only
// history. Uses #byoa and #slack, the production examples from Pres.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/archivedchannels-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const BROWSER_SERVER = process.env.BROWSER_SERVER || SERVER;

const launchBrowser = () => process.env.BROWSER_WS_ENDPOINT
  ? puppeteer.connect({ browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT })
  : puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const sidebarNames = (page) => page.$$eval('#channel-list .chan-name', (els) => els.map((el) => el.textContent));
const openBrowseChannel = (page, name) => page.evaluate((wanted) => {
  const row = [...document.querySelectorAll('.browse-row')].find((el) => el.querySelector('.browse-name')?.textContent === wanted);
  const button = row && row.querySelector('.browse-open');
  if (!button) throw new Error('no Open button for #' + wanted);
  button.click();
}, name);

(async () => {
  const created = await newRoom(SERVER, 'archived channel discovery');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', {
    method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true },
  });
  const made = {};
  for (const [name, body] of [['byoa', 'saved BYOA history'], ['slack', 'saved Slack history']]) {
    made[name] = await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name, topic: 'archived test' } });
    await api('/api/v1/channels/' + name + '/messages', { method: 'POST', token: alice.token, body: { body } });
    await api('/api/v1/channels/' + name, { method: 'PATCH', token: alice.token, body: { archived: true } });
  }
  for (const name of ['active-one', 'active-two', 'moved']) {
    made[name] = await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name, topic: 'ordering test' } });
  }
  const allChannels = (await api('/api/v1/channels', { token: alice.token })).channels;
  made.general = allChannels.find((ch) => ch.name === 'general');
  const holding = await api('/api/v1/channel-groups', {
    method: 'POST', token: alice.token, body: { name: 'Holding' },
  });
  for (const [position, name] of ['byoa', 'active-one', 'active-two', 'slack', 'general', 'moved'].entries()) {
    await api('/api/v1/channels/' + made[name].id + '/group', {
      method: 'PUT', token: alice.token, body: { group_id: null, position },
    });
  }
  await api('/api/v1/channels/' + made.moved.id + '/group', {
    method: 'PUT', token: alice.token, body: { group_id: holding.id, position: 0 },
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await openAsHuman(page, SERVER, slug, alice, { pageBase: BROWSER_SERVER });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // 1. Neither archived member channel is an active navigation leaf.
  let names = await sidebarNames(page);
  assert(!names.includes('byoa') && !names.includes('slack'), 'archived channel leaked into sidebar: ' + JSON.stringify(names));

  // Header-drop append uses the complete stored default order, including its
  // hidden archived ids. With a visible-count index, #moved lands above a
  // visible channel instead of at the end after [archived, active, active].
  await page.evaluate(() => {
    const source = [...document.querySelectorAll('#channel-list li[data-chid]')]
      .find((el) => el.querySelector('.chan-name')?.textContent === 'moved');
    const target = document.querySelector('#channel-list .default-section');
    if (!source || !target) throw new Error('ordering regression fixture did not render');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  });
  let ordered;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    ordered = (await api('/api/v1/channel-groups', { token: alice.token })).ungrouped;
    if (ordered.at(-1) === made.moved.id) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ordered.at(-1) === made.moved.id, 'default header drop did not append after archived ids: ' + JSON.stringify(ordered));
  names = await sidebarNames(page);
  assert(names.at(-1) === 'moved', 'default header drop did not append visibly: ' + JSON.stringify(names));

  // 2. Browse puts the archived channels in their own section below active
  // channels. Both rows are marked and, because alice is a member, openable.
  await page.click('#browse-channels');
  await page.waitForSelector('#browse-modal:not(.hidden) .browse-section[data-kind="archived"]', { timeout: 5000 });
  const browse = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('.browse-section')].map((s) => s.dataset.kind),
    archived: [...document.querySelectorAll('.browse-section[data-kind="archived"] .browse-row')].map((r) => ({
      name: r.querySelector('.browse-name').textContent,
      mark: r.querySelector('.archived-mark')?.textContent,
      open: r.querySelector('.browse-open')?.textContent,
    })),
  }));
  assert(browse.sections.at(-1) === 'archived', 'archived section is not last: ' + JSON.stringify(browse.sections));
  for (const name of ['byoa', 'slack']) {
    const row = browse.archived.find((r) => r.name === name);
    assert(row && row.mark === 'archived' && row.open === 'Open', 'bad archived Browse row for #' + name + ': ' + JSON.stringify(row));
  }
  await openBrowseChannel(page, 'byoa');
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('byoa')
    && document.querySelector('#messages').textContent.includes('saved BYOA history'), { timeout: 8000 });
  names = await sidebarNames(page);
  assert(!names.includes('byoa'), '#byoa reappeared in sidebar after Browse opened it');

  // 3. Global search matches a channel name independently of message text,
  // carries the same archived mark, and opens its history.
  await page.click('#open-search');
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await page.type('#search-input', 'slack');
  await page.waitForFunction(() => [...document.querySelectorAll('.search-channel-row')]
    .some((r) => r.querySelector('.sc-name')?.textContent === '#slack' && r.querySelector('.archived-mark')?.textContent === 'archived'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.search-channel-row')]
    .find((r) => r.querySelector('.sc-name')?.textContent === '#slack').click());
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('slack')
    && document.querySelector('#messages').textContent.includes('saved Slack history'), { timeout: 8000 });
  names = await sidebarNames(page);
  assert(!names.includes('slack'), '#slack reappeared in sidebar after Search opened it');

  await browser.close();
  if (!process.exitCode) console.log('ARCHIVEDCHANNELS_CHECK_OK');
})().catch((e) => { console.error('ARCHIVEDCHANNELS_CHECK_FAIL:', e.stack || e.message); process.exit(1); });
