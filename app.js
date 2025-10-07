/* Team VIBE – front-end logic (full file) */
(function () {
  'use strict';

  // =========================
  // Admin gate
  // =========================
  const qp = new URLSearchParams(location.search);
  const adminFlag = qp.get('admin') === '1';
  const savedOK = localStorage.getItem('tv_admin_ok') === '1';
  const ADMIN_CODE = window.ADMIN_CODE || 'CHANGE-ME';
  let isAdmin = false;
  if (adminFlag) {
    isAdmin = savedOK || prompt('Enter admin code') === ADMIN_CODE;
    if (isAdmin) localStorage.setItem('tv_admin_ok', '1');
  }

  // =========================
  // Firebase
  // =========================
  const config = window.firebaseConfig;
  firebase.initializeApp(config);
  const db = firebase.firestore();
  const auth = firebase.auth();
  auth.signInAnonymously().catch(() => {});

  // =========================
  // Firestore refs
  // =========================
  const gamesCol  = () => db.collection('TeamVibe_games'); // NOTE: case-sensitive
  const votesCol  = (gameId) => gamesCol().doc(gameId).collection('votes');
  const votersLog = () => db.collection('voters_log');

  // =========================
  // Elements
  // =========================
  const topStats   = document.getElementById('topStats');
  const grid       = document.getElementById('reelsGrid');
  const adminPanel = document.getElementById('adminPanel');
  const feedBody   = document.getElementById('feedBodyInline');

  // =========================
  // Colors for vote bars
  // =========================
  const palette = [
    ['#7cf7ff', '#95ff87'],
    ['#ffd166', '#7cf7ff'],
    ['#ff7eb6', '#ffd166'],
    ['#95ff87', '#c4b5fd'],
  ];

  // =========================
  // Helpers
  // =========================
  const DID_KEY = 'teamvibe_device_id';
  function getDeviceId() {
    let id = localStorage.getItem(DID_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DID_KEY, id);
    }
    return id;
  }

  // Parse YouTube / Instagram URLs for embedding
  function parseUrl(u) {
    try {
      const url = new URL(u);
      const host = url.hostname.replace('www.', '');

      // YouTube
      if (host.includes('youtube.com') || host === 'youtu.be') {
        if (host === 'youtu.be') {
          const id = url.pathname.slice(1);
          if (id) return { type: 'yt', id, open: url.toString() };
        }
        const v = url.searchParams.get('v');
        if (v) return { type: 'yt', id: v, open: url.toString() };
        const m = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
        if (m && m[1]) return { type: 'yt', id: m[1], open: url.toString() };
        return { type: 'unknown', open: url.toString() };
      }

      // Instagram
      if (host.includes('instagram.com')) {
        return { type: 'ig', open: url.toString(), embed: url.toString() };
      }

      return { type: 'unknown', open: url.toString() };
    } catch (e) {
      return { type: 'invalid' };
    }
  }

  // =========================
  // UI builders
  // =========================
  function reelCard(it, idx) {
    const meta = parseUrl(it.url || '');
    const embed =
      meta.type === 'yt'
        ? `<iframe allow="autoplay; encrypted-media" src="https://www.youtube.com/embed/${meta.id}?rel=0" frameborder="0" allowfullscreen></iframe>`
        : meta.type === 'ig'
          ? `<blockquote class="instagram-media" data-instgrm-permalink="${it.url}" style="margin:0; height:100%; overflow:auto; background:#0a0f24;"></blockquote>`
          : `<div class="subtle" style="padding:8px">Unsupported link</div>`;

    return `
      <article class="card" id="card_${it.id}">
        <h3>${it.name}</h3>
        <div class="reel">${embed}</div>
        <div class="row">
          <input placeholder="Your name" id="name_${it.id}" />
          <button class="btn" data-act="vote" data-id="${it.id}" data-name="${encodeURIComponent(it.name)}">+1 Vote</button>
          <button class="btn ghost" data-act="open" data-url="${meta.open || ''}">Open</button>
        </div>
      </article>`;
  }

  function renderTopBars(items) {
    const max = Math.max(...items.map(x => x.count || 0), 1);
    topStats.innerHTML = items
      .map((it, i) => {
        const pct = (it.count || 0) / max;
        const [c1, c2] = palette[i % palette.length];
        return `
        <div class="hlRow">
          <span class="nameHL" style="--p:${pct}; --c1:${c1}; --c2:${c2}">
            <span class="fill"></span>${it.name}
          </span>
          <span class="count">${it.count || 0}</span>
        </div>`;
      })
      .join('');
  }

  // =========================
  // Reset helper functions
  // (defined OUTSIDE renderAdmin so handlers can call them)
  // =========================

  // Reset SELECTED (votes + their live log)
  async function clearVotesForGames(ids) {
    for (const id of ids) {
      // delete votes subcollection
      let snap = await votesCol(id).limit(400).get();
      while (!snap.empty) {
        const batch = db.batch();
        snap.forEach(doc => batch.delete(votesCol(id).doc(doc.id)));
        await batch.commit();
        snap = await votesCol(id).limit(400).get();
      }
      // reset count
      await gamesCol().doc(id).update({ count: 0 });

      // delete related voters_log entries for this game
      let q = await votersLog().where('gameId', '==', id).limit(400).get();
      while (!q.empty) {
        const batch = db.batch();
        q.forEach(doc => batch.delete(votersLog().doc(doc.id)));
        await batch.commit();
        q = await votersLog().where('gameId', '==', id).limit(400).get();
      }
    }
  }

  // Reset ALL votes (counts + votes subcollections) — keeps live log intact
  async function clearAllVotes() {
    const allGames = await gamesCol().get();
    for (const d of allGames.docs) {
      let snap = await votesCol(d.id).limit(400).get();
      while (!snap.empty) {
        const batch = db.batch();
        snap.forEach(doc => batch.delete(votesCol(d.id).doc(doc.id)));
        await batch.commit();
        snap = await votesCol(d.id).limit(400).get();
      }
      await gamesCol().doc(d.id).update({ count: 0 });
    }
  }

  // Reset ONLY live votes (clear entire voters_log)
  async function clearLiveVotes() {
    let snap = await votersLog().limit(400).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.forEach(doc => batch.delete(votersLog().doc(doc.id)));
      await batch.commit();
      snap = await votersLog().limit(400).get();
    }
  }

  // =========================
  // Admin panel
  // =========================
  function renderAdmin(items) {
    if (!isAdmin) { adminPanel.style.display = 'none'; return; }
    adminPanel.style.display = 'block';

    adminPanel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap">
        <div><b>Admin</b> — You can select any number of games. Users only see selected ones.</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <input id="newName" placeholder="Game name" style="padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#0d1330; color:#e7ecff; min-width:220px" />
          <input id="newUrl"  placeholder="Game URL (IG/YouTube)" style="padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#0d1330; color:#e7ecff; min-width:320px" />
          <button class="btn"      id="addGameBtn">Add game</button>
          <button class="btn"      id="saveSelected">Save Selected</button>
          <button class="btn warn" id="resetSelected">Reset Selected</button>
          <button class="btn warn" id="resetVotes">Reset Votes</button>
          <button class="btn warn" id="resetLive">Reset Live Votes</button>
          <button class="btn ghost" id="importGames">Import games (add missing)</button>
        </div>
      </div>
      <input id="adminSearch" placeholder="Search admin list..." style="margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0d1330;color:#e7ecff;width:100%">
      <div class="admGrid" style="margin-top:10px">
        ${items.map(it => `
          <div class="admRow">
            <div style="display:flex; align-items:center; gap:10px">
              <input type="checkbox" class="featChk" data-id="${it.id}" ${it.featured ? 'checked' : ''} />
              <span>${it.name}</span>
            </div>
            <span class="subtle">${it.count || 0} votes</span>
          </div>`).join('')}
      </div>
      <div id="votersBox" class="subtle" style="margin-top:10px"></div>
    `;

    // Admin search filter
    const s = document.getElementById('adminSearch');
    s.oninput = () => {
      const val = s.value.toLowerCase();
      adminPanel.querySelectorAll('.admRow').forEach(row => {
        const name = row.querySelector('span').textContent.toLowerCase();
        row.style.display = name.includes(val) ? '' : 'none';
      });
    };

    // Add game
    document.getElementById('addGameBtn').onclick = async () => {
      const name = (document.getElementById('newName').value || '').trim();
      const url  = (document.getElementById('newUrl').value || '').trim();
      if (!name || !url) return alert('Enter both name and URL.');
      try {
        const q = await gamesCol().where('name', '==', name).limit(1).get();
        if (!q.empty) { alert('A game with this name already exists.'); return; }
        await gamesCol().add({
          name, url, count: 0, featured: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        document.getElementById('newName').value = '';
        document.getElementById('newUrl').value  = '';
        alert('Game added.');
      } catch (e) { console.error(e); alert('Add failed. Check Firestore rules allow create.'); }
    };

    // Save Selected
    document.getElementById('saveSelected').onclick = async () => {
      const chks = [...adminPanel.querySelectorAll('.featChk')];
      const selected = chks.filter(c => c.checked).map(c => c.getAttribute('data-id'));
      try {
        const batch = db.batch();
        items.forEach(it => { batch.update(gamesCol().doc(it.id), { featured: selected.includes(it.id) }); });
        await batch.commit();
        alert('Selected saved.');
      } catch (e) { console.error(e); alert('Saving failed.'); }
    };

    // Import (optional placeholder – reads JSON array from prompt)
    document.getElementById('importGames').onclick = async () => {
      const raw = prompt('Paste JSON like: [{"name":"Title","url":"https://..."}]');
      if (!raw) return;
      try {
        const arr = JSON.parse(raw);
        const batch = db.batch();
        for (const it of arr) {
          const ref = gamesCol().doc();
          batch.set(ref, {
            name: it.name || it.title || 'Untitled',
            url: it.url || '',
            count: 0,
            featured: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
        await batch.commit();
        alert('Import queued. Refresh to see new items.');
      } catch (e) { console.error(e); alert('Invalid JSON or permission denied.'); }
    };

    // ========== Reset buttons ==========
    // Reset Selected (votes + live log for checked items)
    document.getElementById('resetSelected').onclick = async () => {
      const chks = [...adminPanel.querySelectorAll('.featChk')];
      const ids = chks.filter(c => c.checked).map(c => c.getAttribute('data-id'));
      if (ids.length === 0) return alert('Select at least one item.');
      if (!confirm('Reset votes and live comments for SELECTED games?')) return;
      await clearVotesForGames(ids);
      alert('Selected reset complete.');
    };

    // Reset Votes (all games, keep live log)
    document.getElementById('resetVotes').onclick = async () => {
      if (!confirm('Reset ALL votes for ALL games (keeps the live log)?')) return;
      await clearAllVotes();
      alert('All vote counts reset.');
    };

    // Reset Live Votes (clear entire voters_log)
    document.getElementById('resetLive').onclick = async () => {
      if (!confirm('Clear ALL entries from Live votes log?')) return;
      await clearLiveVotes();
      alert('Live votes log cleared.');
    };

    // Tip area
    document.getElementById('votersBox').innerHTML =
      'Tip: use the buttons above to manage rounds.';
  }

  // =========================
  // Render list (cards + meters)
  // =========================
  function renderList(snap) {
    const items = [];
    snap.forEach(d => {
      const raw = d.data();
      items.push({
        id: d.id,
        name: raw?.name ?? raw?.Name ?? 'Untitled',
        url:  raw?.url  ?? raw?.URL  ?? '',
        count: raw?.count ?? raw?.Count ?? 0,
        featured: !!(raw?.featured),
        createdAt: raw?.createdAt ?? raw?.Createdat ?? null
      });
    });

    const visible = isAdmin ? items : items.filter(x => x.featured);
    if (visible.length === 0) {
      topStats.innerHTML = '';
      grid.innerHTML = '<div class="subtle">No items are selected right now. Check back later.</div>';
    } else {
      visible.sort((a, b) => (b.count || 0) - (a.count || 0));
      renderTopBars(visible);
      grid.innerHTML = visible.map((it, i) => reelCard(it, i)).join('');
      if (window.instgrm && instgrm.Embeds) instgrm.Embeds.process();

      // Buttons
      grid.querySelectorAll('button[data-act="open"]').forEach(b => b.onclick = () =>
        window.open(b.getAttribute('data-url'), '_blank'));

      grid.querySelectorAll('button[data-act="vote"]').forEach(b => {
        b.onclick = function () {
          const id    = b.getAttribute('data-id');
          const gname = decodeURIComponent(b.getAttribute('data-name'));
          const name  = (document.getElementById('name_' + id).value || 'Anonymous').trim();
          if (!name) return alert('Please enter your name.');
          const device   = getDeviceId();
          const voterKey = device; // one vote per reel per device

          votesCol(id).where('voterKey', '==', voterKey).limit(1).get().then(q => {
            if (!q.empty) return alert('You already voted for this one from this device. You can vote others.');
            return votesCol(id).add({ voterName: name, voterKey, ts: firebase.firestore.FieldValue.serverTimestamp() })
              .then(() => votersLog().add({ voterName: name, gameId: id, gameName: gname, device, ts: firebase.firestore.FieldValue.serverTimestamp() }))
              .then(() => gamesCol().doc(id).update({ count: firebase.firestore.FieldValue.increment(1) }))
              .catch(e => { console.error(e); alert('Vote failed.'); });
          });
        };
      });
    }

    renderAdmin(items);
  }

  // =========================
  // Live feed (top 10)
  // =========================
  function votesLive() {
    try {
      votersLog().orderBy('ts', 'desc').limit(10).onSnapshot(snap => {
        const arr = [];
        snap.forEach(d => arr.push(d.data()));
        if (arr.length === 0) { feedBody.textContent = 'No votes yet.'; return; }
        feedBody.innerHTML = arr.map(v =>
          `<div class="item">• <b>${v.voterName || 'Anonymous'}</b> voted <i>${v.gameName || v.gameId}</i></div>`
        ).join('');
      }, err => { console.warn('voters_log read failed', err); });
    } catch (e) { console.warn('Live feed not available', e); }
  }

  // =========================
  // Subscribe
  // =========================
  function subscribe() {
    gamesCol().onSnapshot(renderList, err => console.error('Snapshot error', err));
    votesLive();

    // User search filter
    const userSearchInput = document.getElementById('userSearch');
    if (userSearchInput) {
      userSearchInput.addEventListener('input', () => {
        const q = userSearchInput.value.trim().toLowerCase();
        document.querySelectorAll('#reelsGrid .card').forEach(card => {
          const h3 = card.querySelector('h3')?.textContent?.toLowerCase() || '';
          card.style.display = h3.includes(q) ? '' : 'none';
        });
      });
    }
  }

  subscribe();
})();
