const $ = (s) => document.querySelector(s);
const state = { favs: [], playlists: [], prefs: { quality: 'ask' }, current: null };
const FRESH_MS = 10 * 60 * 1000; // cached Home/channel lists newer than this are not re-fetched automatically

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
}

// Inline SVG icons: no dependency on the host's symbol/emoji fonts, so the AppImage looks identical everywhere.
const ICONS = {
  home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z',
  back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  sync: 'M12 4V1L8 5l4 4V6a6 6 0 016 6c0 1-.25 1.97-.7 2.8l1.46 1.46A8 8 0 0012 4zm0 14a6 6 0 01-6-6c0-1 .25-1.97.7-2.8L5.24 7.74A8 8 0 0012 20v3l4-4-4-4z',
  copy: 'M16 1H4a2 2 0 00-2 2v14h2V3h12zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11z',
  external: 'M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3zM5 5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-6h-2v6H5V7h6V5z',
  play: 'M8 5v14l11-7z',
  download: 'M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z',
  chevron: 'M6 9l6 6 6-6z',
  bookmark: 'M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z',
  list: 'M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm13-5v6.2a2.5 2.5 0 101.5 2.3V13H21v-2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  close: 'M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
};
function icon(name, { sm = false, outline = false } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic' + (sm ? ' sm' : '') + (outline ? ' stroke' : ''));
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  if (name === 'info') p.setAttribute('fill-rule', 'evenodd');
  svg.append(p);
  return svg;
}
const withIcon = (name, text, opts) => [icon(name, opts), text ? ' ' + text : null].filter(Boolean);

const fmtDur = (s) => {
  if (!s) return '';
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(Math.floor(s % 60)).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};
const fmtViews = (n) => n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M views' : n >= 1e3 ? Math.round(n / 1e3) + 'K views' : n + ' views';
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, sec] of units) if (s >= sec) { const n = Math.floor(s / sec); return `${n} ${name}${n > 1 ? 's' : ''} ago`; }
  return 'just now';
}
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
// Description text with clickable links (built with DOM nodes, never innerHTML); links open in the default browser.
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    out.push(text.slice(last, m.index), h('a', { class: 'dlink', title: url, onclick: () => api.openExternal(url) }, url));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

function avatar(name, url) {
  const a = h('div', { class: 'avatar' });
  if (url) a.append(h('img', { src: url })); else a.textContent = (name || '?')[0].toUpperCase();
  return a;
}

// ---------- favorites ----------
const isFav = (url) => !!url && state.favs.some((f) => f.url === url);
async function saveFavs() { await api.setFavorites(state.favs); renderFavs(); refreshStars(); }
async function toggleFav(ch) {
  if (!ch?.url) return;
  const adding = !isFav(ch.url);
  if (adding) state.favs.push({ name: ch.name, url: ch.url, avatar: ch.avatar || null, id: ch.id });
  else state.favs = state.favs.filter((f) => f.url !== ch.url);
  await saveFavs();
  if (state.current && state.current.url === ch.url) renderChanHead(state.current);
  if (adding && !ch.avatar) fillAvatar(ch.url);
}
// Favorited from a search result / dialog: fetch the channel's avatar (1 video) in the background.
async function fillAvatar(url) {
  try {
    const r = await api.channel(url, 1);
    const fav = state.favs.find((f) => f.url === url);
    if (!fav) return;
    Object.assign(fav, { name: r.channel.name || fav.name, avatar: r.channel.avatar, id: r.channel.id || fav.id });
    await saveFavs();
  } catch {}
}
function refreshStars() {
  for (const b of document.querySelectorAll('.favstar')) {
    const on = isFav(b.dataset.url);
    b.classList.toggle('on', on);
    b.title = on ? 'Remove channel from favorites' : 'Add channel to favorites';
    b.replaceChildren(icon('star', { sm: true, outline: !on }));
  }
}
function favStar(name, url) {
  if (!url) return null;
  const b = h('button', { class: 'favstar', 'data-url': url, onclick: (e) => { e.stopPropagation(); toggleFav({ name, url }); } });
  return b;
}

function renderFavs() {
  const ul = $('#favs');
  ul.replaceChildren(...state.favs.map((f) => h('li', { class: state.current?.url === f.url ? 'active' : '', onclick: () => navigate({ type: 'channel', url: f.url }) },
    avatar(f.name, f.avatar),
    h('span', { class: 'name', title: f.name }, f.name),
    h('button', { class: 'rm', title: 'Remove', onclick: (e) => { e.stopPropagation(); toggleFav(f); } }, icon('close', { sm: true })))));
  $('#nofavs').hidden = state.favs.length > 0;
  $('#sidehome').classList.toggle('active', view.type === 'home');
}

function renderChanHead(ch) {
  const head = $('#chanhead');
  head.hidden = !ch;
  if (!ch) return;
  const on = isFav(ch.url);
  head.replaceChildren(avatar(ch.name, ch.avatar), h('h2', {}, ch.name),
    h('button', { class: 'btn' + (on ? ' on' : ''), onclick: () => toggleFav(ch) }, withIcon('star', on ? 'Favorited' : 'Favorite', { outline: !on })));
}

// ---------- playlists ----------
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const savePlaylists = async () => { await api.setPlaylists(state.playlists); renderPls(); markSaved(); };
const inAnyPlaylist = (id) => state.playlists.some((p) => p.videos.some((v) => v.id === id));
const slim = (v) => ({ id: v.id, title: v.title, thumb: v.thumb, duration: v.duration || null, views: v.views ?? null,
  channel: v.channel || '', channelUrl: v.channelUrl || '', published: v.published || v.uploaded || 0 });
// Cards in grids show a filled bookmark when the video is in any playlist.
function markSaved() {
  for (const b of document.querySelectorAll('.cbtn[data-vid]')) b.classList.toggle('on', inAnyPlaylist(b.dataset.vid));
}
function renderPls() {
  const ul = $('#pls');
  ul.replaceChildren(...state.playlists.map((p) => h('li', { class: view.type === 'playlist' && view.url === p.id ? 'active' : '', onclick: () => navigate({ type: 'playlist', url: p.id }) },
    icon('list', { sm: true }), h('span', { class: 'name', title: p.name }, p.name), h('span', { class: 'cnt' }, String(p.videos.length)))));
  if (!state.playlists.length) ul.append(h('li', { class: 'nopls muted' }, 'No playlists yet. Press + to create one.'));
}
async function removeFromPlaylist(pl, id) {
  pl.videos = pl.videos.filter((v) => v.id !== id);
  await savePlaylists();
  if (view.type === 'playlist' && view.url === pl.id) renderPlaylistView(pl);
}
// Small name prompt (window.prompt is not available in Electron). Resolves to the trimmed name or null.
function askName(title, initial = '', okText = 'Save') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'txt', type: 'text', value: initial, maxlength: '80', placeholder: 'Playlist name' });
    let close;
    const finish = (v) => { close(); resolve(v); };
    const ok = () => { const n = input.value.trim(); if (n) finish(n); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') finish(null); });
    close = modalShell(h('h2', {}, title), input, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, okText)));
    $('#modal').onclick = (e) => { if (e.target === $('#modal')) finish(null); };
    input.focus(); input.select();
  });
}
async function createPlaylist(v) {
  const name = await askName('New playlist', '', 'Create');
  if (!name) return null;
  const pl = { id: newId(), name, videos: v ? [slim(v)] : [] };
  state.playlists.push(pl);
  await savePlaylists();
  return pl;
}
// "Add to playlist": pick one (click again to remove) or create a new one.
function openPlaylistPicker(v) {
  const list = h('div', { class: 'pllist' });
  const draw = () => list.replaceChildren(...(state.playlists.length ? state.playlists.map((p) => {
    const has = p.videos.some((x) => x.id === v.id);
    return h('button', { class: 'btn plrow' + (has ? ' sel' : ''), onclick: async () => {
      if (has) p.videos = p.videos.filter((x) => x.id !== v.id); else p.videos.unshift(slim(v));
      await savePlaylists(); draw();
    } }, icon(has ? 'check' : 'list', { sm: true }), p.name, h('span', { class: 'cnt' }, `${p.videos.length} video${p.videos.length === 1 ? '' : 's'}`));
  }) : [h('p', { class: 'muted' }, 'You have no playlists yet.')]));
  draw();
  const close = modalShell(h('h2', {}, 'Add to playlist'), h('div', { class: 'muted' }, v.title), list,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { close(); const pl = await createPlaylist(v); if (pl) openPlaylistPicker(v); } }, withIcon('plus', 'New playlist')),
      h('button', { class: 'btn primary', onclick: () => close() }, 'Done')));
}
function renderPlaylistView(pl) {
  state.current = null; renderFavs(); renderChanHead(null); renderPls();
  $('#toolbar').hidden = false;
  $('#toolbar').replaceChildren(h('h2', {}, pl.name), h('span', { class: 'muted' }, `${pl.videos.length} video${pl.videos.length === 1 ? '' : 's'}`),
    h('button', { class: 'btn small primary', onclick: () => openPlayAll(pl) }, withIcon('play', 'Play all', { sm: true })),
    h('button', { class: 'btn small', onclick: async () => { const n = await askName('Rename playlist', pl.name); if (n) { pl.name = n; await savePlaylists(); renderPlaylistView(pl); } } }, 'Rename'),
    h('button', { class: 'btn small', onclick: async () => {
      if (!confirm(`Delete playlist "${pl.name}"? The videos themselves are not affected.`)) return;
      state.playlists = state.playlists.filter((x) => x.id !== pl.id); await savePlaylists(); goBackOrHome();
    } }, 'Delete'));
  setStatus(pl.videos.length ? '' : 'This playlist is empty. Use the bookmark button on any video to add it.');
  $('#grid').replaceChildren(...pl.videos.map((v) => cardEl(v, pl)));
}
// Play all: MPV queues the whole playlist. Videos differ in available resolutions, so the choice is a CAP: each video plays
// at the best quality up to it (a 720p cap plays a 480p-only video at 480p). Audio-only streams just audio with each thumbnail.
function openPlayAll(pl) {
  if (!pl.videos.length) return;
  const caps = [[2160, '2160p'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p'], [240, '240p'], [0, 'Best']];
  let sel = Number(state.prefs.quality) > 0 ? Number(state.prefs.quality) : (state.prefs.quality === '0' ? 0 : 720);
  const chips = caps.map(([hh, t]) => [hh, h('button', { class: 'btn', onclick: () => { sel = hh; refresh(); } }, t)]);
  const playBtn = h('button', { class: 'btn primary' });
  const refresh = () => { chips.forEach(([hh, el]) => el.classList.toggle('sel', hh === sel)); playBtn.replaceChildren(...withIcon('play', `Play all ${sel ? 'up to ' + sel + 'p' : 'Best'}`)); };
  const close = modalShell(h('h2', {}, `Play all: ${pl.name}`), h('div', { class: 'muted' }, `${pl.videos.length} videos, queued in MPV (use < and > in MPV to skip).`),
    h('div', { class: 'sect' }, 'Quality cap'), h('div', { class: 'qgrid' }, chips.map((c) => c[1])),
    h('div', { class: 'note' }, 'Videos that do not have the chosen resolution play at the closest lower one.'),
    h('div', { class: 'actions' }, playBtn, h('button', { class: 'btn', title: 'Streams only the best audio and shows each video\'s thumbnail', onclick: () => { close(); openInMpv(null, 0, true, pl.videos.map((v) => v.id)); } }, withIcon('play', 'Play all audio only'))),
    h('div', { class: 'row' }, h('span'), h('button', { class: 'btn', onclick: () => close() }, 'Close')));
  playBtn.addEventListener('click', () => { close(); openInMpv(null, sel, false, pl.videos.map((v) => v.id)); });
  refresh();
}
function goBackOrHome() { if (hist.length) goBack(); else goHome(); }

// ---------- grid ----------
const cardEl = (v, pl = null) => h('div', { class: 'card', onclick: () => openQualityDialog(v.id, v) },
    h('div', { class: 'th' }, h('img', { src: v.thumb, loading: 'lazy' }),
      pl ? h('button', { class: 'cbtn left', title: 'Remove from this playlist', onclick: (e) => { e.stopPropagation(); removeFromPlaylist(pl, v.id); } }, icon('close', { sm: true }))
         : h('button', { class: 'cbtn left' + (inAnyPlaylist(v.id) ? ' on' : ''), 'data-vid': v.id, title: 'Add to playlist', onclick: (e) => { e.stopPropagation(); openPlaylistPicker(v); } }, icon('bookmark', { sm: true })),
      h('button', { class: 'cbtn', title: 'Info', onclick: (e) => { e.stopPropagation(); openInfoDialog(v); } }, icon('info')),
      v.duration ? h('span', { class: 'dur' }, fmtDur(v.duration)) : null),
    h('div', { class: 'ti' }, v.title),
    h('div', { class: 'meta' },
      v.channel ? h('a', { onclick: (e) => { e.stopPropagation(); if (v.channelUrl) navigate({ type: 'channel', url: v.channelUrl }); } }, v.channel) : null,
      favStar(v.channel, v.channelUrl),
      h('span', {}, [v.views != null ? fmtViews(v.views) : '', v.published ? ago(v.published) : ''].filter(Boolean).join(' · '))));
function renderGrid(videos) {
  $('#grid').replaceChildren(...videos.map((v) => cardEl(v)));
  refreshStars();
}

// Infinite scroll (channel and Home): when the bottom marker scrolls into view, fetch(), which returns {videos, done}, adds cards.
const more = { obs: null, fetch: null, busy: false, token: 0 };
function setupMore(fetch, done) {
  more.obs?.disconnect();
  more.fetch = fetch; more.busy = false; more.token++;
  const el = $('#more');
  el.hidden = done;
  el.textContent = done ? '' : 'Loading more…';
  if (done) return;
  more.obs = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) loadMore(); }, { root: $('main'), rootMargin: '400px' });
  more.obs.observe(el);
}
async function loadMore() {
  if (more.busy) return;
  more.busy = true;
  const tok = more.token, el = $('#more');
  try {
    const r = await more.fetch();
    if (tok !== more.token) return;
    $('#grid').append(...r.videos.map((v) => cardEl(v))); refreshStars();
    if (r.done) { more.obs?.disconnect(); el.hidden = true; return; }
    // the marker may still be on screen (tall window): re-observe so the next page is requested right away
    more.obs.unobserve(el); more.obs.observe(el);
  } catch (e) {
    if (tok !== more.token) return;
    more.obs?.disconnect();
    el.replaceChildren('Could not load more: ' + e.message + ' ', h('button', { class: 'btn small', onclick: () => { el.textContent = 'Loading more…'; more.obs.observe(el); } }, 'Retry'));
  } finally { if (tok === more.token) more.busy = false; }
}

function setStatus(t) { $('#status').textContent = t || ''; }
function showFailure(msg, retry) {
  $('#grid').replaceChildren();
  $('#status').replaceChildren(`Error: ${msg} `, h('button', { class: 'btn small', onclick: retry }, 'Retry'));
}

// ---------- navigation ----------
// Every navigation gets a token; slow responses from an earlier view are dropped instead of overwriting the current one.
let navId = 0;
let view = { type: 'home' };
const hist = [];
const sameView = (a, b) => a.type === b.type && a.url === b.url && a.q === b.q;

function updateNav() {
  $('#back').disabled = hist.length === 0;
  $('#sidehome').classList.toggle('active', view.type === 'home');
}
function navigate(v) {
  if (!sameView(view, v)) { hist.push(view); if (hist.length > 50) hist.shift(); }
  view = v;
  load(false);
}
function goBack() {
  if (!hist.length) return;
  view = hist.pop();
  load(false);
}
const goHome = () => navigate({ type: 'home' });

function renderToolbar(title, at, onSync, syncing) {
  const bar = $('#toolbar');
  bar.hidden = false;
  bar.replaceChildren(...[h('h2', {}, title),
    at ? h('span', { class: 'muted' }, `Updated ${ago(at)}`) : null,
    h('button', { class: 'btn small' + (syncing ? ' spin' : ''), title: 'Refresh from YouTube', onclick: syncing ? null : onSync }, withIcon('sync', syncing ? 'Syncing…' : 'Sync', { sm: true }))].filter(Boolean));
}

// Show cached data instantly, then refresh in the background when stale (or when forced by the Sync button).
async function cachedLoad(my, { title, getCached, fetchFresh, apply, force }) {
  const cached = force ? null : await getCached();
  if (my !== navId) return;
  const resync = () => load(true);
  if (cached) { apply(cached.value, cached.at); renderToolbar(title, cached.at, resync, false); setStatus(''); }
  else { $('#grid').replaceChildren(); renderToolbar(title, 0, resync, true); setStatus('Loading…'); }
  if (cached && Date.now() - cached.at <= FRESH_MS) return;
  if (cached) renderToolbar(title, cached.at, resync, true);
  try {
    const value = await fetchFresh();
    if (my !== navId) return;
    apply(value, Date.now()); renderToolbar(title, Date.now(), resync, false); setStatus('');
  } catch (e) {
    if (my !== navId) return;
    if (cached) { renderToolbar(title, cached.at, resync, false); setStatus('Could not refresh (showing saved results): ' + e.message); }
    else { $('#toolbar').hidden = true; showFailure(e.message, resync); }
  }
}

async function load(force) {
  const my = ++navId;
  const v = view;
  $('#modal').hidden = true;
  updateNav();
  $('#toolbar').hidden = true;
  setStatus('');
  more.obs?.disconnect(); more.token++; $('#more').hidden = true;
  renderPls();
  if (v.type === 'playlist') {
    const pl = state.playlists.find((x) => x.id === v.url);
    if (!pl) { goHome(); return; }
    $('#grid').replaceChildren(); return renderPlaylistView(pl);
  }
  if (v.type === 'home') {
    state.current = null; renderFavs(); renderChanHead(null);
    if (!state.favs.length) { $('#grid').replaceChildren(); setStatus('Add favorite channels to see their latest videos here.'); return; }
    return cachedLoad(my, {
      title: 'Latest from your favorites', force,
      getCached: async () => { const c = await api.feedCached(state.favs); return c && { at: c.at, value: c }; },
      fetchFresh: async () => api.feed(state.favs),
      apply: (r) => { renderGrid(r.videos); setupMore(() => api.feedMore(state.favs), !!r.done); },
    });
  }
  if (v.type === 'channel') {
    state.current = state.favs.find((f) => f.url === v.url) || { url: v.url, name: '' };
    renderFavs(); renderChanHead(state.current.name ? state.current : null);
    return cachedLoad(my, {
      title: 'Latest uploads', force,
      getCached: async () => api.channelCached(v.url),
      fetchFresh: () => api.channel(v.url),
      apply: (r) => {
        state.current = r.channel;
        const fav = state.favs.find((f) => f.url === r.channel.url);
        if (fav && (fav.avatar !== r.channel.avatar || fav.name !== r.channel.name)) { Object.assign(fav, { avatar: r.channel.avatar, name: r.channel.name }); saveFavs(); }
        renderFavs(); renderChanHead(r.channel); renderGrid(r.videos);
        let n = r.videos.length;
        setupMore(async () => { const m = await api.channelMore(v.url, n); n += m.videos.length; return m; }, !!r.done);
      },
    });
  }
  if (v.type === 'search') {
    state.current = null; renderFavs(); renderChanHead(null);
    $('#grid').replaceChildren(); setStatus('Searching…');
    try {
      const r = await api.search(v.q, 0);
      if (my !== navId) return;
      setStatus(r.videos.length ? '' : 'No results.'); renderGrid(r.videos);
      let n = r.videos.length;
      const seen = new Set(r.videos.map((x) => x.id)); // later pages can repeat a result; offsets count the raw results
      setupMore(async () => { const m = await api.search(v.q, n); n += m.videos.length; return { ...m, videos: m.videos.filter((x) => !seen.has(x.id) && seen.add(x.id)) }; }, !!r.done);
    } catch (e) { if (my === navId) showFailure(e.message, () => load(true)); }
  }
}

// ---------- playing ----------
let opening = false;
async function openInMpv(id, height, audio = false, ids = null) {
  if (opening) return;
  opening = true;
  $('#opening').hidden = false;
  try {
    const r = await api.play({ id, ids, height, audio });
    if (!r.ok) showError(r);
  } catch (e) {
    showError({ code: 'LAUNCH_FAILED', message: e.message });
  } finally {
    $('#opening').hidden = true;
    opening = false;
  }
}

function modalShell(...body) {
  const modal = $('#modal');
  const close = () => { modal.hidden = true; };
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.replaceChildren(h('div', { class: 'dialog wide' }, ...body));
  modal.hidden = false;
  return close;
}

function showError(r) {
  const body = r.code === 'MPV_MISSING'
    ? [h('h2', {}, 'MPV was not detected'),
       h('p', {}, 'SLYTP plays videos with MPV, but neither the MPV Flatpak nor a native mpv install was found. Install one of them and try again:'),
       h('p', { class: 'muted' }, 'Flatpak:  flatpak install flathub io.mpv.Mpv'),
       h('p', { class: 'muted' }, 'Native:  sudo apt install mpv  ·  sudo pacman -S mpv  ·  sudo dnf install mpv')]
    : [h('h2', {}, 'Could not open the video in MPV'), h('pre', { class: 'muted err' }, r.message || 'Unknown error')];
  const close = modalShell(...body, h('div', { class: 'row' }, h('span'), h('button', { class: 'btn', onclick: () => close() }, 'Close')));
}

// Copy / open-in-browser buttons shared by both dialogs.
function linkButtons(url) {
  const copy = h('button', { class: 'btn', onclick: async () => {
    await api.copyText(url);
    copy.replaceChildren(...withIcon('copy', 'Copied!'));
    setTimeout(() => copy.replaceChildren(...withIcon('copy', 'Copy link')), 1500);
  } }, withIcon('copy', 'Copy link'));
  const open = h('button', { class: 'btn', onclick: () => api.openExternal(url) }, withIcon('external', 'Open in browser'));
  return [copy, open];
}

const channelFavButton = (info) => {
  if (!info.channelUrl) return null;
  const label = () => withIcon('star', isFav(info.channelUrl) ? 'Channel favorited' : `Favorite ${info.channel || 'channel'}`, { outline: !isFav(info.channelUrl) });
  const b = h('button', { class: 'btn', onclick: async () => { await toggleFav({ name: info.channel, url: info.channelUrl }); b.replaceChildren(...label()); } }, label());
  return b;
};

// Picks the dialog's default quality from the top-bar preference, with a fallback when the video lacks it.
function defaultQuality(qualities) {
  const pref = state.prefs.quality;
  if (pref === 'ask' || !Number(pref) || !qualities.length) return { sel: null, note: '' };
  const want = Number(pref);
  const exact = qualities.find((q) => q.height === want);
  if (exact) return { sel: exact, note: '' };
  const lower = qualities.find((q) => q.height < want) || qualities[qualities.length - 1];
  return { sel: lower, note: `${want}p isn't available for this video, so ${lower.label} is preselected.` };
}

async function openQualityDialog(idOrUrl, seed = {}) {
  const loading = h('div', { class: 'muted' }, 'Fetching available qualities…');
  let close = modalShell(seed.thumb ? h('img', { src: seed.thumb }) : null, h('h2', {}, seed.title || 'Loading…'), loading);
  let info;
  try { info = await api.videoInfo(idOrUrl); }
  catch (e) { close = modalShell(h('h2', {}, 'Error'), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: () => close() }, 'Close')); return; }
  renderQualityDialog(info);
}

function renderQualityDialog(info) {
  const qs = info.qualities;
  const { sel: first, note } = defaultQuality(qs);
  let selected = first ? first.height : 0; // 0 = best
  const chips = [];
  const playBtn = h('button', { class: 'btn primary' });
  const audioBtn = h('button', { class: 'btn', title: 'Streams only the best audio (no video data) and shows the thumbnail in MPV' }, withIcon('play', 'Play audio only'));
  const labelFor = () => (selected ? (qs.find((q) => q.height === selected)?.label || selected + 'p') : 'Best');
  const refresh = () => {
    chips.forEach(([height, el]) => el.classList.toggle('sel', height === selected));
    playBtn.replaceChildren(...withIcon('play', `Play ${labelFor()}`));
  };
  const addChip = (height, text) => { const el = h('button', { class: 'btn', onclick: () => { selected = height; refresh(); } }, text); chips.push([height, el]); return el; };
  // one chip per distinct height (highest fps variant) keeps selection unambiguous
  const seen = new Set();
  const qChips = qs.filter((q) => !seen.has(q.height) && seen.add(q.height)).map((q) => addChip(q.height, q.label));

  const vsel = h('select', {}, [...seen].map((hh) => h('option', { value: hh }, hh + 'p')));
  if (selected && seen.has(selected)) vsel.value = String(selected);
  const opts = (list) => list.map(([v, t]) => h('option', { value: v }, t));
  const asel = h('select', {}, opts([['best', 'Original (best quality, no conversion)'], ['mp3', 'MP3'], ['vorbis', 'OGG (Vorbis)'], ['opus', 'Opus'], ['m4a', 'M4A (AAC)'], ['flac', 'FLAC'], ['wav', 'WAV']]));
  const vfsel = h('select', {}, opts([['mp4', 'MP4 (most compatible)'], ['mkv', 'MKV'], ['webm', 'WebM']]));
  const close = modalShell(
    h('img', { src: info.thumb }),
    h('h2', {}, info.title),
    h('div', { class: 'muted' }, [info.channel, fmtDur(info.duration), info.uploaded ? `Uploaded ${ago(info.uploaded)}` : '', fmtViews(info.views)].filter(Boolean).join(' · ')),
    h('div', { class: 'sect' }, 'Play'),
    h('div', { class: 'qgrid' }, addChip(0, 'Best'), qChips),
    note ? h('div', { class: 'note' }, note) : null,
    h('div', { class: 'actions' }, playBtn, audioBtn),
    h('div', { class: 'sect' }, 'Download'),
    h('div', { class: 'dlrow' }, h('span', { class: 'lbl' }, 'Audio'),
      asel, h('button', { class: 'btn', onclick: () => { close(); startDownload(info, 'audio', 0, asel.value); } }, withIcon('download', 'Audio'))),
    h('div', { class: 'dlrow' }, h('span', { class: 'lbl' }, 'Video'), vsel, vfsel,
      h('button', { class: 'btn', onclick: () => { close(); startDownload(info, 'video', Number(vsel.value), vfsel.value); } }, withIcon('download', 'Video'))),
    h('div', { class: 'sect' }, 'Link'),
    h('div', { class: 'actions' }, linkButtons(info.url)),
    h('div', { class: 'row' }, h('span', { class: 'actions' }, channelFavButton(info), h('button', { class: 'btn', onclick: () => { close(); openPlaylistPicker({ ...info, channelUrl: info.channelUrl || info.channel_url || '' }); } }, withIcon('bookmark', 'Add to playlist'))), h('button', { class: 'btn', onclick: () => close() }, 'Close')));
  playBtn.addEventListener('click', () => { close(); openInMpv(info.id, selected); });
  audioBtn.addEventListener('click', () => { close(); openInMpv(info.id, 0, true); });
  refresh();
}

// Description starts collapsed; the button expands/collapses it.
function descriptionToggle(text) {
  const box = h('div', { class: 'desc', hidden: true }, linkify(text));
  const btn = h('button', { class: 'btn small desctoggle', 'aria-expanded': 'false' });
  const render = () => {
    const open = !box.hidden;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('open', open);
    btn.replaceChildren(...withIcon('chevron', open ? 'Hide description' : 'Show description'));
  };
  btn.addEventListener('click', () => { box.hidden = !box.hidden; render(); });
  render();
  return h('div', { class: 'descwrap' }, btn, box);
}

async function openInfoDialog(seed) {
  let close = modalShell(h('img', { src: seed.thumb }), h('h2', {}, seed.title), h('div', { class: 'muted' }, 'Loading details…'));
  let info;
  try { info = await api.videoInfo(seed.id); }
  catch (e) {
    // Offline details: still show what the card knows, plus the link actions.
    const url = watchUrl(seed.id);
    close = modalShell(h('img', { src: seed.thumb }), h('h2', {}, seed.title), h('p', { class: 'muted' }, `Could not load more details: ${e.message}`),
      h('div', { class: 'actions' }, linkButtons(url)), h('button', { class: 'btn', onclick: () => close() }, 'Close'));
    return;
  }
  const row = (k, v) => v ? [h('dt', {}, k), h('dd', {}, v)] : [];
  close = modalShell(
    h('img', { src: info.thumb }),
    h('h2', {}, info.title),
    h('dl', { class: 'facts' },
      row('Channel', info.channel),
      row('Uploaded', info.uploaded ? `${fmtDate(info.uploaded)} (${ago(info.uploaded)})` : ''),
      row('Views', info.views != null ? info.views.toLocaleString() : ''),
      row('Likes', info.likes != null ? info.likes.toLocaleString() : ''),
      row('Duration', info.isLive ? 'Live' : fmtDur(info.duration)),
      row('Best quality', info.qualities[0]?.label || ''),
      row('Link', info.url)),
    info.description ? descriptionToggle(info.description) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => openQualityDialog(info.id, info) }, withIcon('play', 'Play / Download…')),
      linkButtons(info.url)),
    h('div', { class: 'row' }, channelFavButton(info), h('button', { class: 'btn', onclick: () => close() }, 'Close')));
}

// ---------- helper status (yt-dlp) / ffmpeg install ----------
function renderDepStatus(st) {
  const b = $('#depstatus');
  b.className = 'depstatus ' + st.state;
  const v = st.version ? ` ${st.version}` : '';
  const text = st.state === 'ok' ? `yt-dlp${v} · ${st.message}` : st.state === 'error' ? `yt-dlp${v} · ${st.message}` : `yt-dlp${v} · ${st.message}`;
  b.replaceChildren(h('span', { class: 'dot' }), h('span', {}, text));
  b.title = st.message + ' — click to check for an update now';
}
$('#depstatus').addEventListener('click', () => { if (!/checking|updating/.test($('#depstatus').className)) api.ytdlpCheck(); });
api.onYtdlpStatus(renderDepStatus);
api.ytdlpStatus().then(renderDepStatus);

// Needed only for video downloads / audio conversion; fetched on request into config/bin.
function offerFfmpegInstall(retry) {
  const msg = h('p', {}, 'Merging video with audio and converting audio need ffmpeg, which is not installed. SLYTP can download a static copy (about 42 MB download, 160 MB on disk) into its config folder. It is not used for playback.');
  const status = h('div', { class: 'muted' });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; cancel.hidden = true;
    ffmpegProgress = (p) => { status.textContent = p < 0 ? 'Unpacking…' : `Downloading… ${Math.round(p * 100)}%`; };
    status.textContent = 'Downloading…';
    const r = await api.installFfmpeg();
    ffmpegProgress = () => {};
    if (r.ok) { $('#modal').hidden = true; retry(); }
    else { status.textContent = `Could not install ffmpeg: ${r.message}`; go.disabled = false; cancel.hidden = false; }
  } }, withIcon('download', 'Download ffmpeg'));
  const cancel = h('button', { class: 'btn', onclick: () => close() }, 'Cancel');
  const close = modalShell(h('h2', {}, 'ffmpeg is needed'), msg, status, h('div', { class: 'row' }, go, cancel));
}
let ffmpegProgress = () => {};
api.onFfmpegProgress((p) => ffmpegProgress(p));

// ---------- downloads ----------
async function startDownload(info, kind, height, format) {
  const bar = $('#dl');
  const label = kind === 'audio' ? 'audio' : `${height}p video`;
  const show = (...kids) => { bar.replaceChildren(...kids.filter(Boolean)); bar.hidden = false; };
  progressTarget = (p) => { if (!bar.hidden && bar.dataset.busy) show(h('div', {}, `Downloading ${label}… ${p}`)); };
  bar.dataset.busy = '1';
  show(h('div', {}, `Choose where to save the ${label}…`));
  const r = await api.download({ id: info.id, title: info.title, kind, height, audioExt: info.audioExt, format });
  delete bar.dataset.busy;
  if (r.canceled) { bar.hidden = true; return; }
  if (r.code === 'FFMPEG_MISSING') { bar.hidden = true; offerFfmpegInstall(() => startDownload(info, kind, height, format)); return; }
  const dismiss = h('button', { class: 'btn', onclick: () => { bar.hidden = true; } }, 'Dismiss');
  if (r.ok) show(h('div', {}, `Saved ${label}`), r.file ? h('button', { class: 'btn', onclick: () => api.showFile(r.file) }, 'Show in folder') : null, dismiss);
  else show(h('div', { class: 'err' }, `Download failed: ${r.message}`), dismiss);
}
let progressTarget = () => {};
api.onDownloadProgress((p) => progressTarget(p));

// ---------- playback guardrail feedback ----------
function showGuard(level) {
  const b = $('#guard');
  b.hidden = !level;
  b.replaceChildren(`Smooth playback ${level >= 2 ? '(max)' : 'on'} · reset`);
}
$('#guard').addEventListener('click', async () => { showGuard(await api.resetGuard()); });
api.onPlayReport(({ level, reason }) => {
  showGuard(level);
  const bar = $('#dl');
  if (bar.dataset.busy) return; // don't clobber a running download's progress
  bar.replaceChildren(h('div', {}, `Playback stuttered because ${reason}. SLYTP will use safer settings (H.264, lower frame rate, bigger buffer) next time.`),
    h('button', { class: 'btn', onclick: () => { bar.hidden = true; } }, 'OK'));
  bar.hidden = false;
});

// ---------- input ----------
function parseInput(s) {
  s = s.trim();
  if (/^@[\w.-]+$/.test(s)) return { type: 'channel', value: s };
  if (/^https?:\/\//.test(s) || /^(www\.)?(youtube\.com|youtu\.be)\//.test(s)) {
    const url = s.startsWith('http') ? s : 'https://' + s;
    if (/youtu\.be\/|[?&]v=|\/shorts\/|\/live\//.test(url)) return { type: 'video', value: url };
    return { type: 'channel', value: url };
  }
  return { type: 'search', value: s };
}

$('#go').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#q').value;
  if (!v.trim()) return;
  const p = parseInput(v);
  if (p.type === 'video') openQualityDialog(p.value);
  else if (p.type === 'channel') navigate({ type: 'channel', url: p.value });
  else navigate({ type: 'search', q: p.value });
});

$('#pref').addEventListener('change', async (e) => { state.prefs.quality = e.target.value; await api.setPrefs(state.prefs); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#modal').hidden = true;
  if (e.key === 'BrowserBack' || (e.altKey && e.key === 'ArrowLeft')) goBack();
});

$('#back').append(icon('back'));
$('#homebtn').append(icon('home'));
$('#sidehome').append(icon('home'), 'Home');
$('#back').addEventListener('click', goBack);
$('#homebtn').addEventListener('click', goHome);
$('#sidehome').addEventListener('click', goHome);
$('.logo').addEventListener('click', goHome);

(async function init() {
  state.favs = await api.getFavorites();
  state.playlists = await api.getPlaylists();
  $('#newpl').append(icon('plus', { sm: true }));
  $('#newpl').addEventListener('click', () => createPlaylist(null));
  state.prefs = await api.getPrefs();
  $('#pref').value = state.prefs.quality;
  showGuard(await api.getGuard());
  load(false);
})();
