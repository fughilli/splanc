// Splanc Bridge Flasher — the window. Pi -> WiFi -> SD card -> write -> done.
// Talks to the Python sidecar through window.flasher (preload.js); every check
// that matters (disk safety, settings validation, checksums) lives there.
'use strict';

(() => {
  const api = window.flasher;
  const $ = (id) => document.getElementById(id);
  const GUIDE = 'https://github.com/fughilli/splanc/blob/main/docs/guides/cloud-agent.md';
  const HELP = 'https://github.com/fughilli/splanc/blob/main/docs/pi-bridge.md';
  const ORDER = ['board', 'wifi', 'card', 'write'];

  const state = {
    release: null, // the selected release
    releases: [],
    latestTag: null, // the default (newest final) release
    board: null,
    localImage: null,
    disks: [],
    disk: null,
    hostname: 'splanc-bridge',
    validating: null,
    diskTimer: null,
    writing: false,
    stage: null,
  };

  // ------------------------------------------------------------------ panes --
  function show(name) {
    for (const p of document.querySelectorAll('.pane')) p.classList.add('hidden');
    $(`pane-${name}`).classList.remove('hidden');
    const idx = ORDER.indexOf(name === 'done' || name === 'error' ? 'write' : name);
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('active', i === idx && name !== 'done');
      li.classList.toggle('done', i < idx || name === 'done');
    });
    clearInterval(state.diskTimer);
    if (name === 'card') {
      $('card-summary').textContent = summary();
      api.send({ cmd: 'list_disks' });
      state.diskTimer = setInterval(() => api.send({ cmd: 'list_disks' }), 2500);
    }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const fmtDate = (iso) => (iso ? iso.slice(0, 10) : '');

  // What will be written, e.g. "Splanc bridge 1.1.0 · Raspberry Pi 3 (B, B+, A+)".
  function summary() {
    if (state.localImage) return `Image file · ${state.localImage}`;
    const rel = state.release;
    if (!rel) return '';
    const b = rel.boards.find((x) => x.board === state.board);
    return `Splanc bridge ${rel.version}${b ? ` · ${b.board_name}` : ''}`;
  }

  const fmtSize = (bytes) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

  // ------------------------------------------------------------------ board --
  function renderBoards() {
    const box = $('boards');
    box.textContent = '';
    if (!state.release && !state.localImage) {
      for (let i = 0; i < 4; i++) box.append(el('div', 'skeleton'));
      return;
    }
    const boards = state.localImage
      ? [{ board: 'local', board_name: 'Image file', size: 0 }]
      : state.release.boards;
    for (const b of boards) {
      const c = el('button', 'card');
      c.type = 'button';
      c.append(el('div', 'name', b.board_name));
      c.append(
        el('div', 'meta', b.size ? `v${state.release.version} · ${fmtSize(b.size)} download` : state.localImage),
      );
      if (state.board === b.board) c.classList.add('selected');
      c.addEventListener('click', () => {
        state.board = b.board;
        renderBoards();
        $('board-next').disabled = false;
      });
      box.append(c);
    }
    if (boards.length === 1 && !state.board) {
      state.board = boards[0].board;
      renderBoards();
    }
    $('board-next').disabled = !state.board;
  }

  function versionLabel(r) {
    if (r.tag === state.latestTag) return `${r.version} (latest)`;
    return r.prerelease ? `${r.version} (pre-release)` : r.version;
  }

  function selectRelease(tag) {
    const rel = state.releases.find((r) => r.tag === tag);
    if (!rel) return;
    state.release = rel;
    $('version').value = tag;
    $('version-date').textContent = rel.published_at ? `Published ${fmtDate(rel.published_at)}` : '';
    const note = $('version-note');
    const older = tag !== state.latestTag;
    note.classList.toggle('hidden', !older);
    note.textContent = older
      ? rel.prerelease
        ? 'A pre-release: newer than the latest release, but less tested.'
        : 'An older version. Once online, the bridge updates itself daily to the latest release.'
      : '';
    // Older releases may not have been built for every board.
    if (state.board && state.board !== 'local' && !rel.boards.some((b) => b.board === state.board)) {
      state.board = null;
    }
    renderBoards();
  }

  function onRelease(evt) {
    if (evt.release) {
      state.releases = evt.releases && evt.releases.length ? evt.releases : [evt.release];
      state.latestTag = evt.release.tag;
      const sel = $('version');
      sel.textContent = '';
      for (const r of state.releases) {
        const o = document.createElement('option');
        o.value = r.tag;
        o.textContent = versionLabel(r);
        sel.append(o);
      }
      $('release-line').classList.add('hidden');
      $('version-row').classList.remove('hidden');
      $('release-error').classList.add('hidden');
      selectRelease(evt.release.tag);
      return;
    } else {
      $('release-line').textContent = '';
      $('release-line').classList.remove('hidden');
      $('version-row').classList.add('hidden');
      $('release-error-text').textContent =
        evt.error || 'No Splanc bridge image has been published yet. Check back soon.';
      $('release-error').classList.remove('hidden');
      $('boards').textContent = '';
      return;
    }
    renderBoards();
  }

  // ------------------------------------------------------------------- wifi --
  function form() {
    const country = ($('country').value || '').trim().slice(0, 2).toUpperCase();
    return {
      ssid: $('ssid').value,
      psk: $('psk').value,
      hidden: $('hidden').checked,
      ethernet_only: $('ethernet-only').checked,
      country,
      device_name: $('device-name').value,
      relay: $('relay').value.trim(),
      ssh_key: $('ssh-key').value,
    };
  }

  function showErrors(errors) {
    for (const f of document.querySelectorAll('#wifi-form .field')) {
      const msg = errors[f.dataset.field] || '';
      f.classList.toggle('bad', !!msg);
      const p = f.querySelector('.err-text');
      if (p) p.textContent = msg;
    }
  }

  function validate(strict) {
    return new Promise((resolve) => {
      state.validating = { resolve, strict };
      api.send({ cmd: 'validate', form: form() });
    });
  }

  function onValidation(evt) {
    state.hostname = evt.hostname;
    $('hostname-preview').innerHTML = '';
    $('hostname-preview').append('On your network as ', el('b', null, `${evt.hostname}.local`));
    const v = state.validating;
    state.validating = null;
    // While typing, only show errors for fields the user has touched.
    const shown = v && v.strict ? evt.errors : touchedOnly(evt.errors);
    showErrors(shown);
    if (v) v.resolve(evt.errors);
  }

  const touched = new Set();
  function touchedOnly(errors) {
    const out = {};
    for (const [k, msg] of Object.entries(errors)) if (touched.has(k)) out[k] = msg;
    return out;
  }

  function wireWifi() {
    for (const input of document.querySelectorAll('#wifi-form input, #wifi-form textarea')) {
      input.addEventListener('blur', () => {
        if (input.name) touched.add(input.name);
        validate(false);
      });
      input.addEventListener('input', () => validate(false));
    }
    $('ethernet-only').addEventListener('change', () => {
      const off = $('ethernet-only').checked;
      for (const id of ['ssid', 'psk', 'hidden', 'show-psk']) $(id).disabled = off;
      validate(false);
    });
    // Eye toggle (same behaviour as the phone app's kit PasswordReveal): the
    // press never takes focus from the field, and the caret survives the swap.
    const showPsk = $('show-psk');
    for (const ev of ['pointerdown', 'mousedown']) showPsk.addEventListener(ev, (e) => e.preventDefault());
    showPsk.addEventListener('click', () => {
      const p = $('psk');
      const { selectionStart: a, selectionEnd: b } = p;
      const shown = p.type === 'password';
      p.type = shown ? 'text' : 'password';
      if (typeof a === 'number' && typeof b === 'number') p.setSelectionRange(a, b);
      const label = shown ? 'Hide password' : 'Show password';
      showPsk.setAttribute('aria-label', label);
      showPsk.title = label;
      showPsk.setAttribute('aria-pressed', String(shown));
      showPsk.classList.toggle('on', shown);
    });
    const list = $('countries');
    for (const [code, name] of window.COUNTRIES || []) {
      const o = document.createElement('option');
      o.value = `${code} — ${name}`;
      list.append(o);
    }
    // Best guess from the system locale (en-US -> US); the user can change it.
    const guess = (navigator.language || '').split('-')[1];
    const hit = (window.COUNTRIES || []).find(([c]) => c === (guess || '').toUpperCase());
    if (hit) $('country').value = `${hit[0]} — ${hit[1]}`;
  }

  // ------------------------------------------------------------------- card --
  function renderDisks() {
    const box = $('disks');
    box.textContent = '';
    if (!state.disks.length) {
      box.append(el('div', 'empty', 'No SD card found yet. Insert one — it will appear here.'));
      state.disk = null;
    }
    if (state.disk && !state.disks.find((d) => d.id === state.disk.id)) state.disk = null;
    for (const d of state.disks) {
      const c = el('button', 'card disk');
      c.type = 'button';
      c.append(el('div', 'icon'));
      const t = el('div');
      t.append(el('div', 'name', d.name || d.id));
      t.append(el('div', 'meta', `${d.size_gb.toFixed(1)} GB${d.bus ? ' · ' + d.bus : ''} · ${d.id}`));
      c.append(t);
      if (d.large) c.append(el('span', 'tag warn', 'Large disk'));
      if (state.disk && state.disk.id === d.id) c.classList.add('selected');
      c.addEventListener('click', () => {
        state.disk = d;
        renderDisks();
      });
      box.append(c);
    }
    $('card-write').disabled = !state.disk;
  }

  async function startWrite() {
    const d = state.disk;
    if (!d) return;
    const size = `${d.size_gb.toFixed(1)} GB`;
    if (d.large && !(await api.confirmLarge({ name: d.name, size }))) return;
    if (!(await api.confirmErase({ name: d.name, size }))) return;
    state.writing = true;
    for (const li of document.querySelectorAll('#stages li')) {
      li.className = '';
      if (state.localImage && ['download', 'verify'].includes(li.dataset.stage)) li.className = 'skipped';
    }
    $('bar-fill').style.width = '0%';
    $('write-title').textContent = 'Writing the card…';
    $('write-summary').textContent = summary();
    $('stage-download').textContent =
      state.release && !state.localImage ? `Download Splanc bridge ${state.release.version}` : 'Download the image';
    $('write-message').textContent = 'Starting…';
    $('cancel').disabled = false;
    show('write');
    api.send({
      cmd: 'flash',
      board: state.board,
      tag: state.localImage || !state.release ? null : state.release.tag,
      disk_id: d.id,
      local_image: state.localImage,
      form: form(),
    });
  }

  // --------------------------------------------------------------- progress --
  function onProgress(evt) {
    $('bar-fill').style.width = `${Math.round(evt.overall * 100)}%`;
    $('write-message').textContent = evt.message;
    const stages = [...document.querySelectorAll('#stages li')];
    const idx = stages.findIndex((li) => li.dataset.stage === evt.stage);
    stages.forEach((li, i) => {
      if (li.classList.contains('skipped')) return;
      li.classList.toggle('done', i < idx);
      li.classList.toggle('active', i === idx);
    });
    // Once the card is being written, stopping halfway would leave it unbootable.
    if (['write', 'check', 'configure'].includes(evt.stage)) $('cancel').disabled = true;
  }

  function onDone(evt) {
    state.writing = false;
    $('done-title').textContent = evt.version
      ? `Your Splanc bridge ${evt.version} card is ready`
      : 'Your Splanc bridge card is ready';
    $('done-host').textContent = `It will be on your network as ${evt.hostname}.local.`;
    $('done-win-note').textContent =
      api.platform === 'win32'
        ? 'If Windows offers to format a drive on the card, choose Cancel — that is the Pi’s system partition.'
        : '';
    show('done');
  }

  function onError(evt) {
    state.writing = false;
    if (evt.cancelled) {
      show('card');
      return;
    }
    $('error-text').textContent = evt.message;
    show('error');
  }

  // ----------------------------------------------------------------- wiring --
  api.onEvent((evt) => {
    switch (evt.type) {
      case 'ready':
        if (evt.version && evt.version !== 'dev') $('subtitle').textContent += ` · v${evt.version}`;
        api.send({ cmd: 'release' });
        break;
      case 'release':
        onRelease(evt);
        break;
      case 'validation':
        onValidation(evt);
        break;
      case 'disks':
        state.disks = evt.disks || [];
        renderDisks();
        break;
      case 'progress':
        onProgress(evt);
        break;
      case 'flash_done':
        onDone(evt);
        break;
      case 'flash_error':
        onError(evt);
        break;
      case 'fatal':
        $('error-text').textContent = evt.message;
        show('error');
        break;
      case 'log':
        console.log(evt.line);
        break;
      default:
        break;
    }
  });

  $('board-next').addEventListener('click', () => show('wifi'));
  $('version').addEventListener('change', (e) => selectRelease(e.target.value));
  $('retry-release').addEventListener('click', () => {
    $('release-error').classList.add('hidden');
    $('release-line').textContent = 'Looking for the latest Splanc bridge image…';
    $('release-line').classList.remove('hidden');
    state.release = null;
    renderBoards();
    api.send({ cmd: 'release' });
  });
  $('use-file').addEventListener('click', async () => {
    const p = await api.pickImage();
    if (!p) return;
    state.localImage = p;
    state.board = 'local';
    $('release-error').classList.add('hidden');
    $('local-image').textContent = `Using ${p}`;
    renderBoards();
  });
  $('wifi-next').addEventListener('click', async () => {
    for (const f of ['ssid', 'psk', 'country', 'device_name', 'relay', 'ssh_key']) touched.add(f);
    const errors = await validate(true);
    if (Object.keys(errors).length === 0) show('card');
  });
  $('card-write').addEventListener('click', startWrite);
  $('cancel').addEventListener('click', () => api.send({ cmd: 'cancel' }));
  $('again').addEventListener('click', () => {
    state.disk = null;
    show('card');
  });
  $('open-guide').addEventListener('click', () => api.openLink(GUIDE));
  $('error-help').addEventListener('click', () => api.openLink(HELP));
  $('error-back').addEventListener('click', () => show(state.board ? 'card' : 'board'));
  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => show(b.dataset.back));
  }

  wireWifi();
  renderBoards();
  show('board');
})();
