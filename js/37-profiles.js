'use strict';
/* voxiCraft — local profiles + the split-screen roster UI

   ================================================================================================
   A PROFILE is a person who plays on this machine: a name and an id, stored in localStorage and
   nothing more. It is not an account and there is no login — it exists so that a save knows WHO
   was playing, which is what makes split screen worth having. Player one plays as the selected
   profile; players two upward are picked from the same list.

   A world remembers its roster BY PROFILE ID, so the people who were in it last time come back
   with their own inventories, positions and experience the next time it is opened. That is why
   the saved player records are matched on profile rather than on slot number: player three
   yesterday and player two today is still the same person.

   First run has no profiles, and a nameless player cannot own a save, so the profile screen is
   the entire menu until one exists — refreshMenu enforces that, not just the boot path.
   ================================================================================================ */

let PROFILES = (() => {
  try { const a = JSON.parse(localStorage.getItem('vc_profiles')); return Array.isArray(a) ? a : []; }
  catch { return []; }
})();
let activeProfileId = localStorage.getItem('vc_profile') || null;

const persistProfiles = () => localStorage.setItem('vc_profiles', JSON.stringify(PROFILES));
const profileById = (id) => PROFILES.find(p => p.id === id) || null;
const needsFirstProfile = () => PROFILES.length === 0;

function activeProfile() {
  let p = profileById(activeProfileId);
  if (!p && PROFILES.length) { p = PROFILES[0]; setActiveProfile(p.id); }
  return p;
}
const activeProfileName = () => { const p = activeProfile(); return p ? p.name : 'Player 1'; };

function setActiveProfile(id) {
  if (!profileById(id)) return;
  activeProfileId = id;
  localStorage.setItem('vc_profile', id);
  const p = profileById(id);
  p.lastUsed = Date.now();
  persistProfiles();
  // player one IS the active profile, so the name follows immediately
  if (typeof setPlayerName === 'function' && PSTATE.length) {
    PSTATE[0].player.profileId = id;
    setPlayerName(0, p.name);
  }
}

// names are deduplicated the same way world names are, so a roster is never ambiguous
function uniqueProfileName(raw) {
  const base = String(raw || '').trim().slice(0, 16) || 'Player';
  if (!PROFILES.some(p => p.name === base)) return base;
  let n = 1;
  while (PROFILES.some(p => p.name === base + n)) n++;
  return base + n;
}

function createProfile(rawName) {
  if (PROFILES.length >= 16) { toast('too many profiles'); return null; }
  const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              name: uniqueProfileName(rawName), created: Date.now(), lastUsed: Date.now() };
  PROFILES.push(p);
  persistProfiles();
  if (!activeProfileId) setActiveProfile(p.id);
  return p;
}

/* Deleting a profile does NOT touch any world: their saved player record simply stops matching
   and is ignored on load. Nothing that was built disappears, and re-creating a profile with the
   same name does not silently inherit the old one's pockets (ids, not names, are the key). */
function deleteProfile(id) {
  const i = PROFILES.findIndex(p => p.id === id);
  if (i < 0) return;
  // a profile currently holding a viewport has to leave the game first
  const slot = PSTATE.findIndex(s => s.player.profileId === id);
  if (slot === 0) { toast('that profile is playing — switch to another first'); return; }
  if (slot > 0) removePlayerSlot(slot);
  PROFILES.splice(i, 1);
  persistProfiles();
  if (activeProfileId === id) {
    activeProfileId = null;
    localStorage.removeItem('vc_profile');
    const next = activeProfile();                 // falls through to the first remaining profile
    if (next) setActiveProfile(next.id);
  }
}

/* ================================================================================================
   PROFILE SCREEN
   ================================================================================================ */
const profileListEl   = document.getElementById('profileList');
const profileNameIn   = document.getElementById('profileNameIn');
const profileAddBtn   = document.getElementById('profileAddBtn');
const profilesBackBtn = document.getElementById('profilesBackBtn');
const profilesBtn     = document.getElementById('profilesBtn');
const profileNameLbl  = document.getElementById('profileNameLbl');
const profileFirstNote = document.getElementById('profileFirstNote');

function renderProfiles() {
  const first = needsFirstProfile();
  profileFirstNote.style.display = first ? 'block' : 'none';
  // there is nowhere to go back TO until a profile exists
  profilesBackBtn.style.display = first ? 'none' : '';
  profileListEl.innerHTML = '';
  const act = activeProfile();
  for (const p of PROFILES) {
    const row = document.createElement('div');
    row.className = 'srow' + (act && p.id === act.id ? ' sel' : '');
    const label = document.createElement('div');
    label.className = 'sname';
    label.textContent = p.name;
    const sub = document.createElement('span');
    sub.className = 'ssub';
    sub.textContent = (act && p.id === act.id) ? 'playing as' : '';
    label.appendChild(sub);
    const btns = document.createElement('div');
    btns.className = 'sbtns';
    if (!act || p.id !== act.id) {
      const use = document.createElement('button');
      use.textContent = 'Select';
      use.onclick = () => { setActiveProfile(p.id); renderProfiles(); paintProfileLabel(); };
      btns.appendChild(use);
    }
    /* No delete button on the profile currently in seat one: deleteProfile refuses it anyway, and
       a button that always says no is worse than no button. Switch to someone else first. */
    if (!PSTATE.length || PSTATE[0].player.profileId !== p.id) {
      const del = document.createElement('button');
      del.className = 'wdel';
      del.textContent = '✕';
      del.title = 'delete profile';
      del.onclick = () => {
        if (confirm(`Delete profile "${p.name}"? Worlds and builds are kept.`)) {
          deleteProfile(p.id); renderProfiles(); paintProfileLabel(); renderSplitPanel();
        }
      };
      btns.appendChild(del);
    }
    row.append(label, btns);
    profileListEl.appendChild(row);
  }
}
function paintProfileLabel() {
  profileNameLbl.textContent = needsFirstProfile() ? '—' : activeProfileName();
}
profilesBtn.addEventListener('click', () => refreshMenu('profiles'));
profilesBackBtn.addEventListener('click', () => refreshMenu(currentWorld ? 'pause' : 'home'));
profileAddBtn.addEventListener('click', () => {
  const p = createProfile(profileNameIn.value);
  if (!p) return;
  profileNameIn.value = '';
  renderProfiles();
  paintProfileLabel();
  renderSplitPanel();
});
profileNameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') profileAddBtn.click(); });

/* ================================================================================================
   SPLIT-SCREEN ROSTER (pause menu)
   Only shown for worlds created with split screen enabled — the flag is fixed at creation, the
   same way terrain and survival-mode are, because the save layout depends on it.
   ================================================================================================ */
const splitPanel      = document.getElementById('splitPanel');
const splitListEl     = document.getElementById('splitList');
const splitProfileSel = document.getElementById('splitProfileSel');
const splitAddBtn     = document.getElementById('splitAddBtn');
const splitAddRow     = document.getElementById('splitAddRow');
const splitNoteEl     = document.getElementById('splitNote');

function renderSplitPanel() {
  const on = !!(currentWorld && currentWorld.split);
  splitPanel.style.display = on ? 'block' : 'none';
  if (!on) return;

  splitListEl.innerHTML = '';
  PSTATE.forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'srow';
    const label = document.createElement('div');
    label.className = 'sname';
    label.textContent = playerLabel(st.player);
    const sub = document.createElement('span');
    sub.className = 'ssub';
    sub.textContent = inputLabelFor(i);       // names the actual device, live
    label.appendChild(sub);
    const btns = document.createElement('div');
    btns.className = 'sbtns';
    // every seat can be pointed at a different device, player one included
    const inp = document.createElement('button');
    inp.textContent = 'Change input';
    inp.title = 'press a button on the device this player should use';
    inp.onclick = () => beginInputCapture(i);
    btns.appendChild(inp);
    if (i > 0) {
      const out = document.createElement('button');
      out.className = 'wdel';
      out.textContent = '✕';
      out.title = 'remove player';
      out.onclick = () => { removePlayerSlot(i); renderSplitPanel(); };
      btns.appendChild(out);
    }
    row.append(label, btns);
    splitListEl.appendChild(row);
  });

  // profiles not already in the game are the ones that can still join
  const inGame = new Set(PSTATE.map(s => s.player.profileId));
  const free = PROFILES.filter(p => !inGame.has(p.id));
  splitProfileSel.innerHTML = '';
  for (const p of free) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    splitProfileSel.appendChild(o);
  }
  const full = PSTATE.length >= MAX_PLAYERS;
  splitAddRow.style.display = (full || !free.length) ? 'none' : '';
  /* A controller the browser has never heard from does not exist as far as the page is concerned,
     and that is the single most common reason a pad "isn't detected" — so say so here rather than
     leaving people to guess. */
  const pads = connectedPads().length;
  splitNoteEl.textContent =
    full ? `${MAX_PLAYERS} players is the maximum.`
    : !free.length ? 'Every profile is already playing — create another to add someone.'
    : pads === 0 ? 'No controller seen yet — press a button on one to wake it, then add a player.'
    : 'Each added player needs their own controller. Their items are saved with this world.';
}

splitAddBtn.addEventListener('click', () => {
  const id = splitProfileSel.value;
  const prof = profileById(id);
  if (!prof) return;
  const p = joinPlayer(prof.name);
  if (!p) return;
  p.profileId = prof.id;
  const slot = PLAYERS.indexOf(p);
  // a returning player gets their own saved pockets back; a new one just steps out beside player one
  if (!applyExtraPlayerRestoreNow(slot)) seatNewPlayer(p);
  renderSplitPanel();
  toast(`${prof.name} joined`);
});

/* Remove one player from the middle of the roster.

   Slots are a stack — only the last one can actually be popped — so taking player two out of
   three means popping both and putting player three back. Everyone involved is stashed first, so
   the rejoined player gets their own inventory, position and experience handed straight back
   rather than starting empty; leaving is a seat change, not a death. */
function removePlayerSlot(slot) {
  if (slot <= 0 || slot >= PSTATE.length) return;
  const readd = [];
  for (let i = PSTATE.length - 1; i >= slot; i--) {
    stashPlayerRecord(i);
    if (i > slot) readd.unshift(PSTATE[i].player.profileId);   // keep their order
    leavePlayer();
  }
  for (const id of readd) {
    const prof = profileById(id);
    if (!prof) continue;
    const p = joinPlayer(prof.name);
    if (!p) break;
    p.profileId = id;
    const s = PLAYERS.indexOf(p);
    if (!applyExtraPlayerRestoreNow(s)) seatNewPlayer(p);
  }
  renderSplitPanel();
}
