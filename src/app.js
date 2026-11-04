/* VScalc – gränssnitt. Beräkningar finns i calc.js (window.VSCalc). */
(function () {
  'use strict';
  const C = window.VSCalc;
  const $ = s => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const STORE_KEY = 'vscalc-project-v1';

  // ---------- Tillstånd ----------
  const DEFAULT_SETTINGS = {
    dvut: -18, tIn: 21, height: 2.5,
    uWall: 0.6, uWindow: 2.8, uDoor: 2.0, uRoof: 0.3, uFloor: 0.5,
    tGround: 8, tBasement: 10, tCrawl: 0,
    airChanges: 0.5, infiltration: 0.1, heatRecovery: 0, thermalBridge: 0.1,
    above: 'vind', below: 'kallare',
    tf: 70, trDesign: 50, dpKPa: 10,
    calcMode: 'dt', dtWater: 15, tempMethod: 'aritmetisk', valveSensor: 'Max', flowMargin: 0,
  };
  function defaultDb() {
    try { return C.parseRadiatorCsv(window.VSCALC_DEFAULT_CSV || ''); } catch (e) { return []; }
  }
  function newProject() {
    return { version: 1, name: 'Nytt projekt', settings: { ...DEFAULT_SETTINGS },
      plan: { image: null, w: 2000, h: 1400, pxPerM: 100 }, rooms: [], radiators: [], db: defaultDb() };
  }
  let P = migrate(load()) || newProject();
  function migrate(p) {
    if (!p) return p;
    p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
    if (!p.db || !p.db.length || p.db.every(d => String(d.id).startsWith('ex-'))) p.db = defaultDb();
    (p.radiators || []).forEach(r => { if (!r.count) r.count = 1; });
    return p;
  }
  function sysParams() {
    const s = P.settings;
    return { mode: s.calcMode, dt: s.dtWater, tf: s.tf, trDesign: s.trDesign, dpKPa: s.dpKPa,
      method: s.tempMethod, sensor: s.valveSensor, margin: s.flowMargin };
  }
  let mode = 'pan', selRoom = null, draft = [], rectStart = null, scalePts = [];
  let view = { x: 0, y: 0, w: P.plan.w, h: P.plan.h };

  function load() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(P)); }
      catch (e) { hint('Kunde inte autospara i webbläsaren (för stor ritning?). Använd "Spara projekt".'); }
    }, 300);
  }
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Beräkning ----------
  function roomGeom(room) {
    const k = P.plan.pxPerM;
    const pts = room.pts.map(p => ({ x: p.x / k, y: p.y / k }));
    return {
      area: C.polygonArea(pts),
      walls: room.pts.map((p, i) => ({
        length: C.dist(p, room.pts[(i + 1) % room.pts.length]) / k,
        exterior: !!room.edges[i].exterior,
        windowArea: room.edges[i].windowArea, doorArea: room.edges[i].doorArea,
      })),
    };
  }
  function computeRoom(room) {
    const s = P.settings;
    const g = roomGeom(room);
    const calcRoom = {
      area: g.area, walls: g.walls, tIn: room.tIn, height: room.height, airChanges: room.airChanges, supply: room.supply, exhaust: room.exhaust,
      above: room.above || s.above, below: room.below || s.below,
    };
    const loss = C.roomHeatLoss(calcRoom, s);
    const tIn = isFinite(parseFloat(room.tIn)) ? parseFloat(room.tIn) : s.tIn;
    const mine = P.radiators.filter(r => r.roomId === room.id);
    const qtyOk = r => { const d = P.db.find(x => x.id === r.dbId); return d && (d.unit === 'st' || parseFloat(r.qty) > 0); };
    const incomplete = mine.filter(r => !qtyOk(r));
    const rads = mine.filter(qtyOk).map(r => {
      const d = P.db.find(x => x.id === r.dbId);
      const count = Math.max(1, parseInt(r.count) || 1);
      return d ? { rad: r, db: d, count, pNom: C.nominalPower(d, r.qty) * count, norm: d.norm, n: d.n, dpKPa: r.dpKPa } : null;
    }).filter(Boolean);
    const bal = C.roomBalance(loss.total, tIn, rads, sysParams());
    return { room, geom: g, loss, tIn, rads, bal, incomplete };
  }
  const computeAll = () => P.rooms.map(computeRoom);

  // ---------- SVG-ritning ----------
  const svg = $('#plan');
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function svgPoint(ev) {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  const pxPerScreen = () => view.w / svg.clientWidth;
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const TOL = COARSE ? 20 : 10; // fäst-/stängningsavstånd i skärmpixlar
  function snap(p) {
    const tol = TOL * pxPerScreen();
    let best = null, bd = tol;
    for (const r of P.rooms) for (const q of r.pts) {
      const d = C.dist(p, q); if (d < bd) { bd = d; best = q; }
    }
    return best ? { x: best.x, y: best.y } : { x: p.x, y: p.y };
  }

  // Ritningen ligger i ett eget lager som bara byggs om när bilden ändras; allt annat ritas om i överlagret.
  // (Att återskapa en stor <image> vid varje omritning avkodar bilden på nytt och gör appen seg.)
  let baseKey = null, baseLayer = null, overlay = null, blobUrl = null;
  function ensureLayers() {
    const key = P.plan.image ? 'img:' + P.plan.image.length + ':' + P.plan.image.slice(-64) : `grid:${P.plan.w}:${P.plan.h}:${P.plan.pxPerM}`;
    if (key === baseKey && baseLayer && baseLayer.parentNode === svg) return;
    baseKey = key;
    svg.innerHTML = '';
    baseLayer = el('g', {}, svg);
    overlay = el('g', {}, svg);
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (P.plan.image) {
      let href = P.plan.image;
      try { blobUrl = URL.createObjectURL(dataUrlToBlob(P.plan.image)); href = blobUrl; } catch (e) { /* använd data-URL */ }
      el('image', { href, x: 0, y: 0, width: P.plan.w, height: P.plan.h }, baseLayer);
    } else drawGrid(baseLayer);
  }
  function dataUrlToBlob(u) {
    const [head, b64] = u.split(',');
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' });
  }
  function draw() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    ensureLayers();
    overlay.innerHTML = '';
    { const svg = overlay; // allt nedan ritas i överlagret
    const results = new Map(computeAll().map(r => [r.room.id, r]));
    for (const room of P.rooms) {
      const g = el('g', {}, svg);
      const poly = el('polygon', { points: room.pts.map(p => `${p.x},${p.y}`).join(' '),
        class: 'room' + (room.id === selRoom ? ' sel' : '') }, g);
      poly.addEventListener('click', ev => {
        if (suppressClick) return;
        if (mode === 'pan' || mode === 'edge') { selRoom = room.id; refresh(); ev.stopPropagation(); }
      });
      room.pts.forEach((p, i) => {
        const q = room.pts[(i + 1) % room.pts.length];
        const ext = room.edges[i].exterior;
        if (!ext && mode !== 'edge') return;
        const line = el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: 'edge' + (ext ? ' ext' : '') }, g);
        if (mode === 'edge') line.addEventListener('click', ev => {
          ev.stopPropagation(); room.edges[i].exterior = !ext; selRoom = room.id; changed();
        });
      });
      const c = centroid(room.pts), r = results.get(room.id);
      const fs = 13 * pxPerScreen();
      const t = el('text', { x: c.x, y: c.y, class: 'roomlabel', 'font-size': fs, style: `stroke-width:${3 * pxPerScreen()}px` }, g);
      t.textContent = room.name;
      const t2 = el('text', { x: c.x, y: c.y + fs * 1.2, class: 'roomlabel', 'font-size': fs * 0.9, style: `stroke-width:${3 * pxPerScreen()}px` }, g);
      t2.textContent = r ? `${fmt(r.loss.total)} W` + (r.bal.overdim != null && r.rads.length ? ` · ${fmtPct(r.bal.overdim)}` : '') : '';
    }
    const rs = 7 * pxPerScreen();
    for (const rad of P.radiators) {
      const d = P.db.find(x => x.id === rad.dbId);
      const home = rad.roomId && P.rooms.find(r => r.id === rad.roomId);
      if (home && !C.pointInPolygon(rad, home.pts)) {
        const q = C.nearestOnPolygon(rad, home.pts);
        el('line', { x1: rad.x, y1: rad.y, x2: q.x, y2: q.y, class: 'radlink' }, svg);
      }
      const cls = 'rad' + (!rad.roomId ? ' unassigned' : '') + (d && d.unit !== 'st' && !(parseFloat(rad.qty) > 0) ? ' incomplete' : '');
      const rect = el('rect', { x: rad.x - rs * 1.6, y: rad.y - rs / 2, width: rs * 3.2, height: rs, rx: rs / 4, class: cls }, svg);
      const tt = el('title', {}, rect);
      tt.textContent = (d ? d.name : 'Okänd radiator') + (rad.raw ? ` (avläst: "${rad.raw}")` : '') + (!rad.roomId ? ' – ligger inte i något rum' : '');
      rect.addEventListener('click', ev => {
        if (mode !== 'pan' && mode !== 'rad') return;
        ev.stopPropagation();
        const room = P.rooms.find(r => r.id === rad.roomId);
        if (room) selRoom = room.id;
        openRadDialog(room || null, rad, rad);
      });
    }
    if (draft.length) {
      el('polyline', { points: draft.map(p => `${p.x},${p.y}`).join(' '), class: 'draft' }, svg);
      draft.forEach(p => el('circle', { cx: p.x, cy: p.y, r: 4 * pxPerScreen(), class: 'vertex' }, svg));
    }
    scalePts.forEach(p => el('circle', { cx: p.x, cy: p.y, r: 5 * pxPerScreen(), class: 'vertex' }, svg));
    }
    $('#scaleInfo').textContent = `Skala: ${fmt(P.plan.pxPerM, 1)} px/m`;
  }
  function drawGrid(g) {
    const k = P.plan.pxPerM;
    el('rect', { x: 0, y: 0, width: P.plan.w, height: P.plan.h, fill: 'var(--panel)' }, g);
    for (let x = 0; x <= P.plan.w; x += k) el('line', { x1: x, y1: 0, x2: x, y2: P.plan.h, stroke: 'var(--line)', 'vector-effect': 'non-scaling-stroke' }, g);
    for (let y = 0; y <= P.plan.h; y += k) el('line', { x1: 0, y1: y, x2: P.plan.w, y2: y, stroke: 'var(--line)', 'vector-effect': 'non-scaling-stroke' }, g);
  }
  function centroid(pts) {
    let x = 0, y = 0; pts.forEach(p => { x += p.x; y += p.y; });
    return { x: x / pts.length, y: y / pts.length };
  }
  function fit() {
    const ar = svg.clientWidth / Math.max(1, svg.clientHeight);
    let w = P.plan.w, h = P.plan.h;
    if (w / h > ar) h = w / ar; else w = h * ar;
    view = { x: (P.plan.w - w) / 2, y: (P.plan.h - h) / 2, w, h };
    draw();
  }

  // ---------- Interaktion ----------
  const HINTS = {
    pan: COARSE ? 'Dra för att flytta, nyp med två fingrar eller använd + / − för att zooma. Tryck på ett rum för att redigera det.'
      : 'Dra för att flytta, scrolla för att zooma. Klicka på ett rum för att redigera det.',
    scale: 'Klicka på två punkter med känt avstånd (t.ex. ett måttsatt väggmått).',
    room: 'Klicka ut rummets hörn. Klicka på första punkten (eller tryck Enter) för att stänga. Esc avbryter. Två fingrar zoomar och flyttar. Hörn fäster mot befintliga hörn.',
    rect: 'Dra från ett hörn till det motsatta för att rita ett rektangulärt rum.',
    edge: 'Klicka på en vägg för att markera/avmarkera den som yttervägg (röd).',
    rad: 'Klicka i ett rum där radiatorn sitter.',
  };
  function hint(t) { $('#hint').textContent = t; }
  function setMode(m) {
    mode = m; draft = []; scalePts = []; rectStart = null;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    hint(HINTS[m]); draw();
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  let drag = null, suppressClick = false;
  // Pekskärm: två fingrar zoomar (nyp) och flyttar i alla lägen.
  const touches = new Map();
  let pinch = null;
  const mid = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  function startPinch() {
    const m = mid();
    pinch = { d: m.d, cx: m.x, cy: m.y, view: { ...view } };
    drag = null; rectStart = null; if (mode === 'rect') draft = [];
    suppressClick = true;
  }
  function zoomAt(clientX, clientY, f, base) {
    base = base || view;
    const r = svg.getBoundingClientRect();
    const px = base.x + (clientX - r.left) / r.width * base.w, py = base.y + (clientY - r.top) / r.height * base.h;
    view = { x: px - (px - base.x) * f, y: py - (py - base.y) * f, w: base.w * f, h: base.h * f };
  }
  svg.addEventListener('pointerdown', ev => {
    if (ev.pointerType === 'touch') {
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touches.size === 2) { startPinch(); draw(); return; }
      if (touches.size > 2) return;
    }
    const p = svgPoint(ev);
    if (mode === 'pan' || ev.button === 1) {
      drag = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false, id: ev.pointerId };
    } else if (mode === 'rect') {
      rectStart = snap(p);
      if (ev.pointerType !== 'touch') svg.setPointerCapture(ev.pointerId); // touch fångas implicit
    }
  });
  svg.addEventListener('pointermove', ev => {
    if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && touches.size >= 2) {
      const m = mid(), r = svg.getBoundingClientRect();
      const f = pinch.d / Math.max(10, m.d);
      // zooma kring startmitten och flytta med fingrarnas mittpunkt
      zoomAt(pinch.cx, pinch.cy, f, pinch.view);
      view.x -= (m.x - pinch.cx) / r.width * view.w; view.y -= (m.y - pinch.cy) / r.height * view.h;
      draw(); return;
    }
    if (drag) {
      const k = pxPerScreen();
      const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; svg.setPointerCapture(drag.id); }
      if (!drag.moved) return;
      view.x = drag.vx - dx * k; view.y = drag.vy - dy * k; draw();
    } else if (mode === 'rect' && rectStart) {
      const p = snap(svgPoint(ev));
      draft = [rectStart, { x: p.x, y: rectStart.y }, p, { x: rectStart.x, y: p.y }, rectStart]; draw();
    } else if (mode === 'room' && draft.length) {
      const p = snap(svgPoint(ev));
      draw(); el('line', { x1: draft[draft.length - 1].x, y1: draft[draft.length - 1].y, x2: p.x, y2: p.y, class: 'draft' }, overlay);
    }
  });
  const endTouch = ev => {
    touches.delete(ev.pointerId);
    if (pinch && touches.size < 2) { pinch = null; suppressClick = true; setTimeout(() => { suppressClick = false; }, 350); return true; }
    return false;
  };
  svg.addEventListener('pointercancel', ev => { endTouch(ev); drag = null; rectStart = null; });
  svg.addEventListener('pointerup', async ev => {
    if (endTouch(ev)) return;
    if (drag) {
      suppressClick = drag.moved; drag = null;
      return;
    }
    if (mode === 'rect' && rectStart) {
      const p = snap(svgPoint(ev)), a = rectStart; rectStart = null; draft = [];
      if (Math.abs(p.x - a.x) > 5 && Math.abs(p.y - a.y) > 5)
        await addRoom([a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }]);
      draw();
    }
  });
  svg.addEventListener('click', async ev => {
    if (suppressClick) { suppressClick = false; return; }
    const p = svgPoint(ev);
    if (mode === 'pan') { if (selRoom) { selRoom = null; refresh(); } }
    else if (mode === 'scale') {
      scalePts.push(p); draw();
      if (scalePts.length === 2) {
        const px = C.dist(scalePts[0], scalePts[1]);
        const m = parseFloat(String(await ask(`Avstånd mellan punkterna i meter (${fmt(px)} px):`, '')).replace(',', '.'));
        if (m > 0) { P.plan.pxPerM = px / m; changed(); hint(`Skala satt: ${fmt(P.plan.pxPerM, 1)} px/m.`); }
        scalePts = []; draw();
      }
    } else if (mode === 'room') {
      const q = snap(p);
      if (draft.length >= 3 && C.dist(q, draft[0]) < TOL * pxPerScreen()) { await closeDraft(); return; }
      draft.push(q); draw();
    } else if (mode === 'rad') {
      const room = P.rooms.find(r => C.pointInPolygon(p, r.pts));
      if (!room) { hint('Klicka inuti ett ritat rum.'); return; }
      openRadDialog(room, p);
    }
  });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const p = svgPoint(ev), f = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
    view = { x: p.x - (p.x - view.x) * f, y: p.y - (p.y - view.y) * f, w: view.w * f, h: view.h * f };
    draw();
  }, { passive: false });
  document.addEventListener('keydown', async ev => {
    if (ev.target.matches('input, select, textarea')) return;
    if (ev.key === 'Escape') { draft = []; scalePts = []; rectStart = null; draw(); }
    if (ev.key === 'Enter' && mode === 'room' && draft.length >= 3) await closeDraft();
    if ((ev.key === 'Backspace') && mode === 'room' && draft.length) { draft.pop(); draw(); }
  });
  async function closeDraft() { const pts = draft; draft = []; await addRoom(pts); draw(); }
  async function addRoom(pts) {
    const name = await ask('Rummets namn:', `Rum ${P.rooms.length + 1}`);
    if (name === null) return;
    const room = { id: uid(), name: name || `Rum ${P.rooms.length + 1}`, pts: pts.map(p => ({ x: p.x, y: p.y })),
      edges: pts.map(() => ({ exterior: false, windowArea: 0, doorArea: 0 })), tIn: '', height: '', airChanges: '', supply: '', exhaust: '', above: '', below: '' };
    P.rooms.push(room); selRoom = room.id; assignRadiators(); applyAirLabels(); changed();
  }
  /** Kopplar radiatorer utan (giltigt) rum till det rum de ligger i. */
  // Beteckningar står ofta utanför fasaden (ovanför/under radiatorn): koppla till närmaste rum inom detta avstånd.
  const ASSIGN_MAX_M = 4;
  function assignRadiators() {
    let n = 0;
    for (const rad of P.radiators) {
      // Avlästa radiatorer utanför rum räknas om varje gång (ett nyritat rum kan ligga närmare)
      if (rad.roomId && P.rooms.some(r => r.id === rad.roomId) && !rad.auto) continue;
      let room = P.rooms.find(r => C.pointInPolygon(rad, r.pts));
      if (!room && rad.auto) {
        let bd = ASSIGN_MAX_M * P.plan.pxPerM;
        for (const r of P.rooms) { const q = C.nearestOnPolygon(rad, r.pts); if (q.d < bd) { bd = q.d; room = r; } }
      }
      rad.roomId = room ? room.id : null; if (room) n++;
    }
    return n;
  }

  // ---------- Dialoger ----------
  // Pekskärm: en dialog som öppnas mitt i en fingergest kan tappa första trycket (inget click skapas).
  // Stäng därför direkt på pointerup för knappar i dialoger.
  // Dialogerna använder inte <form method="dialog">: i den publicerade appens sandlåda (utan allow-forms)
  // blockeras formulärsändning, så OK/Avbryt gjorde ingenting. Knapparna stänger dialogen själva.
  document.querySelectorAll('dialog button[value]').forEach(btn => {
    btn.addEventListener('click', () => { const d = btn.closest('dialog'); if (d && d.open) d.close(btn.value); });
  });
  // Enter i ett textfält = OK
  document.querySelectorAll('dialog input').forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const d = inp.closest('dialog'), ok = d && d.querySelector('button[value="ok"]');
    if (d && d.open && ok) d.close('ok');
  }));
  document.querySelectorAll('dialog button[value]').forEach(btn => {
    let downOnBtn = false;
    btn.addEventListener('pointerdown', e => { downOnBtn = e.pointerType === 'touch'; });
    btn.addEventListener('pointerup', e => {
      if (!downOnBtn || e.pointerType !== 'touch') return;
      downOnBtn = false; e.preventDefault();
      const d = btn.closest('dialog'); if (d && d.open) d.close(btn.value);
    });
  });
  function ask(text, def) {
    return new Promise(res => {
      const d = $('#askDialog'); $('#askText').textContent = text; $('#askInput').value = def ?? '';
      d.onclose = () => res(d.returnValue === 'ok' ? $('#askInput').value : null);
      d.returnValue = ''; d.showModal(); $('#askInput').select();
    });
  }
  let radCtx = null;
  function openRadDialog(room, p, existing) {
    radCtx = { room, p, existing };
    $('#radRoom').textContent = room ? `Rum: ${room.name}` : 'Ligger inte i något rum än – rita rummet runt radiatorn så kopplas den automatiskt.';
    $('#radSearch').value = '';
    fillRadSelect(existing ? existing.dbId : null);
    $('#radQty').value = existing ? (existing.qty ?? '') : 10;
    $('#radDel').hidden = !existing;
    $('#radCount').value = existing ? (existing.count || 1) : 1;
    $('#radOk').textContent = existing ? 'Spara' : 'Placera';
    const d = $('#radDialog'); d.returnValue = ''; d.showModal(); $('#radSearch').focus();
  }
  function fillRadSelect(selId) {
    const q = $('#radSearch').value.toLowerCase();
    const sel = $('#radSelect'); sel.innerHTML = '';
    const groups = {};
    P.db.filter(d => !q || `${d.name} ${d.type} ${d.maker} ${d.height}`.toLowerCase().includes(q))
      .forEach(d => (groups[d.type || 'Övrigt'] ||= []).push(d));
    for (const [type, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup'); og.label = type;
      list.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; og.appendChild(o); });
      sel.appendChild(og);
    }
    if (selId) sel.value = selId;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    updateRadInfo();
  }
  function unitLabel(u) { return u === 'sektion' ? 'Antal sektioner' : u === 'm' ? 'Längd (m)' : 'Antal'; }
  function updateRadInfo() {
    const d = P.db.find(x => x.id === $('#radSelect').value);
    if (!d) { $('#radInfo').textContent = 'Ingen radiator vald.'; return; }
    $('#radQtyLabel').textContent = unitLabel(d.unit);
    $('#radQty').disabled = d.unit === 'st';
    const cnt = Math.max(1, parseInt($('#radCount').value) || 1);
    const pn = C.nominalPower(d, $('#radQty').value);
    $('#radInfo').textContent = `${fmt(d.power, 2)} W per ${d.unit} vid ${d.norm.tf}/${d.norm.tr}/${d.norm.ti} °C, n = ${d.n}. Effekt: ${fmt(pn)} W per radiator` + (cnt > 1 ? `, ${fmt(pn * cnt)} W totalt.` : '.');
  }
  $('#radSearch').addEventListener('input', () => fillRadSelect());
  $('#radSelect').addEventListener('change', updateRadInfo);
  $('#radSelect').addEventListener('dblclick', () => { if ($('#radSelect').value) $('#radDialog').close('ok'); });
  $('#radQty').addEventListener('input', updateRadInfo);
  $('#radCount').addEventListener('input', updateRadInfo);
  $('#radDialog').addEventListener('close', () => {
    if ($('#radDialog').returnValue === 'del' && radCtx && radCtx.existing) {
      P.radiators = P.radiators.filter(x => x !== radCtx.existing); radCtx = null; changed(); return;
    }
    if ($('#radDialog').returnValue !== 'ok' || !radCtx) return;
    const dbId = $('#radSelect').value; if (!dbId) return;
    const qty = parseFloat(String($('#radQty').value).replace(',', '.')) || null;
    const count = Math.max(1, parseInt($('#radCount').value) || 1);
    if (radCtx.existing) Object.assign(radCtx.existing, { dbId, qty, count });
    else P.radiators.push({ id: uid(), roomId: radCtx.room.id, x: radCtx.p.x, y: radCtx.p.y, dbId, qty, count, dpKPa: '' });
    if (radCtx.room) selRoom = radCtx.room.id;
    radCtx = null; changed();
  });

  // ---------- Sidopanel ----------
  const ABOVE = { '': 'Som planet', vind: 'Kall vind', tak: 'Yttertak (snedtak)', uppvarmt: 'Uppvärmt plan' };
  const BELOW = { '': 'Som planet', mark: 'Platta på mark', kallare: 'Ouppvärmd källare', kryprum: 'Kryprum', uppvarmt: 'Uppvärmt plan' };
  const opts = (map, v) => Object.entries(map).map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');

  function renderSide() {
    const side = $('#sidePanel');
    const room = P.rooms.find(r => r.id === selRoom);
    if (!room) {
      const res = computeAll();
      side.innerHTML = `<h2>Planet</h2>
        <label class="f">Ovanför<select data-s="above">${opts({ vind: ABOVE.vind, tak: ABOVE.tak, uppvarmt: ABOVE.uppvarmt }, P.settings.above)}</select></label>
        <label class="f">Under<select data-s="below">${opts({ mark: BELOW.mark, kallare: BELOW.kallare, kryprum: BELOW.kryprum, uppvarmt: BELOW.uppvarmt }, P.settings.below)}</select></label>
        <h3>Rum (${P.rooms.length})</h3>
        ${P.rooms.length ? `<table>${res.map(r => `<tr data-room="${r.room.id}" style="cursor:pointer"><td>${esc(r.room.name)}</td><td>${fmt(r.loss.total)} W</td><td>${statusTag(r)}</td></tr>`).join('')}</table>`
          : '<p class="note">Ladda en planritning, sätt skalan och rita ut rummen. Utan ritning ritar du på ett rutnät där varje ruta är 1 m.</p>'}
        ${P.radiators.some(x => !x.roomId) ? `<p class="warn">${P.radiators.filter(x => !x.roomId).length} radiatorer ligger utanför ritade rum (streckade). Rita rummen runt dem så kopplas de automatiskt.</p>` : ''}
        <p class="note">Ytterväggar ritas röda. Rumsetiketten visar effektbehov och dimensioneringsfaktor.</p>`;
      side.querySelectorAll('[data-s]').forEach(i => i.addEventListener('change', () => { P.settings[i.dataset.s] = i.value; changed(); }));
      side.querySelectorAll('[data-room]').forEach(tr => tr.addEventListener('click', () => { selRoom = tr.dataset.room; refresh(); }));
      return;
    }
    const r = computeRoom(room);
    const s = P.settings;
    side.innerHTML = `
      <div class="toolbar"><button class="btn small" id="back">‹ Alla rum</button><div class="spacer"></div><button class="btn small danger" id="delRoom">Ta bort rum</button></div>
      <label class="f">Namn<input data-r="name" value="${esc(room.name)}"></label>
      <label class="f">Rumstemp °C<input data-r="tIn" type="number" step="0.5" placeholder="${s.tIn}" value="${esc(room.tIn)}"></label>
      <label class="f">Rumshöjd m<input data-r="height" type="number" step="0.05" placeholder="${s.height}" value="${esc(room.height)}"></label>
      <label class="f" title="Tal = tilluft m³/h, + = uteluftsdon (uteluft = frånluften), − = ingen tilluft (överluft)">Tilluft m³/h (+ / −)<input data-r="supply" placeholder="tomt" value="${esc(room.supply ?? '')}"></label>
      <label class="f">Frånluft m³/h<input data-r="exhaust" type="number" step="1" min="0" placeholder="tomt" value="${esc(room.exhaust ?? '')}"></label>
      ${room.airRaw ? `<p class="note">Luftflöde avläst från ritningen: "${esc(room.airRaw)}"</p>` : ''}
      <label class="f">Luftomsättning oms/h<input data-r="airChanges" type="number" step="0.1" placeholder="${s.airChanges}" value="${esc(room.airChanges)}"${String(room.supply ?? '') !== '' || String(room.exhaust ?? '') !== '' ? ' disabled title="Används inte när luftflöden är angivna"' : ''}></label>
      <label class="f">Ovanför<select data-r="above">${opts(ABOVE, room.above)}</select></label>
      <label class="f">Under<select data-r="below">${opts(BELOW, room.below)}</select></label>
      <p class="note">Golvarea ${fmt(r.geom.area, 1)} m² · volym ${fmt(r.loss.volume, 1)} m³</p>
      <h3>Väggar</h3>
      <table class="edges"><tr><th>#</th><th>Längd</th><th>Ytter</th><th>Fönster m²</th><th>Dörr m²</th></tr>
      ${r.geom.walls.map((w, i) => `<tr><td>${i + 1}</td><td>${fmt(w.length, 2)} m</td>
        <td><input type="checkbox" data-e="${i}" data-k="exterior"${w.exterior ? ' checked' : ''}></td>
        <td><input type="number" step="0.1" min="0" data-e="${i}" data-k="windowArea" value="${room.edges[i].windowArea || ''}"${w.exterior ? '' : ' disabled'}></td>
        <td><input type="number" step="0.1" min="0" data-e="${i}" data-k="doorArea" value="${room.edges[i].doorArea || ''}"${w.exterior ? '' : ' disabled'}></td></tr>`).join('')}
      </table>
      <h3>Värmeförlust vid DVUT ${s.dvut} °C</h3>
      <table>${r.loss.parts.filter(p => p.w > 0.5).map(p => `<tr><td>${p.label}${p.area != null ? ` <span class="note">${fmt(p.area, 1)} m²</span>` : ''}</td><td>${fmt(p.w)} W</td></tr>`).join('')}
      <tr><th style="text-align:left">Effektbehov</th><th>${fmt(r.loss.total)} W</th></tr></table>
      <h3>Radiatorer</h3>
      ${r.rads.length ? r.rads.map((x, i) => {
        const pr = r.bal.perRad[i];
        const cnt = x.count > 1 ? `${x.count} st × ` : '';
        return `<div style="border-top:1px solid var(--line);padding:6px 0">
          <div><b>${cnt}${esc(x.db.name)}</b> ${x.db.unit !== 'st' ? `× ${fmt(x.rad.qty, x.db.unit === 'm' ? 2 : 0)} ${x.db.unit === 'm' ? 'm' : 'sekt.'}` : ''}</div>
          <div class="note">Katalogeffekt ${fmt(x.pNom)} W (${x.norm.tf}/${x.norm.tr}/${x.norm.ti}) · ska avge ${fmt(pr.pReq)} W</div>
          ${pr.ok ? `<div>Tillopp/retur <b>${fmt(pr.tf, 1)}/${fmt(pr.tr, 1)} °C</b></div>
            <div>Flöde <b>${fmt(pr.flowEach, 1)} l/h</b>${x.count > 1 ? ' per st' : ''} · kv <b>${fmt(pr.kv, 3)}</b></div>
            ${pr.overRef ? `<div class="bad">Kräver tillopp över referens ${x.norm.tf} °C – radiatorn räcker inte</div>` : ''}
            <div>RA-DV PURE (${esc(s.valveSensor)}): <b>${pr.valve.setting ?? '–'}</b> <span class="note">${pr.valve.maxFlow ? `max ${fmt(pr.valve.maxFlow, 1)} l/h · ` : ''}${esc(pr.valve.status)}</span></div>`
            : `<div class="bad">${pr.reason} (max ${fmt(pr.pMax)} W)</div>`}
          <label class="f">Δp ventil kPa<input type="number" step="0.5" data-rad="${x.rad.id}" placeholder="${s.dpKPa}" value="${esc(x.rad.dpKPa)}"></label>
          <button class="btn small" data-edit="${x.rad.id}">Ändra</button> <button class="btn small danger" data-del="${x.rad.id}">Ta bort</button>
        </div>`;
      }).join('') : (r.incomplete.length ? '' : '<p class="note">Inga radiatorer. Välj "Placera radiator" och klicka i rummet.</p>')}
      ${r.incomplete.map(rad => { const d = P.db.find(x => x.id === rad.dbId); return `<div style="border-top:1px solid var(--line);padding:6px 0"><b>${esc(d ? d.name : '?')}</b> <span class="warn">antal sektioner saknas${rad.raw ? ` (avläst "${esc(rad.raw)}")` : ''}</span><br><button class="btn small" data-edit="${rad.id}">Ange</button> <button class="btn small danger" data-del="${rad.id}">Ta bort</button></div>`; }).join('')}
      ${r.rads.length ? `<p>Katalogeffekt <b>${fmt(r.bal.available)} W</b> · överdimensionering <b class="${overClass(r.bal.overdim)}">${fmtPct(r.bal.overdim)}</b>${s.calcMode === 'tf' ? `<br>Vid ${s.tf}/${s.trDesign} °C: ${fmt(r.bal.installedDesign)} W · faktor <b class="${factorClass(r.bal.factor)}">×${fmt(r.bal.factor, 2)}</b>` : ''}</p>` : ''}`;

    side.querySelector('#back').onclick = () => { selRoom = null; refresh(); };
    side.querySelector('#delRoom').onclick = () => {
      P.radiators = P.radiators.filter(x => x.roomId !== room.id);
      P.rooms = P.rooms.filter(x => x !== room); selRoom = null; changed();
    };
    side.querySelectorAll('[data-r]').forEach(i => i.addEventListener('change', () => { room[i.dataset.r] = i.value; changed(); }));
    side.querySelectorAll('[data-e]').forEach(i => i.addEventListener('change', () => {
      const e = room.edges[+i.dataset.e];
      e[i.dataset.k] = i.type === 'checkbox' ? i.checked : parseFloat(String(i.value).replace(',', '.')) || 0;
      changed();
    }));
    side.querySelectorAll('[data-rad]').forEach(i => i.addEventListener('change', () => {
      P.radiators.find(x => x.id === i.dataset.rad).dpKPa = i.value; changed();
    }));
    side.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { P.radiators = P.radiators.filter(x => x.id !== b.dataset.del); changed(); });
    side.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const rad = P.radiators.find(x => x.id === b.dataset.edit); openRadDialog(room, rad, rad);
    });
  }
  const fmtPct = v => v == null || !isFinite(v) ? '–' : (v >= 0 ? '+' : '') + fmt(v * 100) + ' %';
  const overClass = v => v == null ? '' : v < 0 ? 'bad' : 'ok';
  function factorClass(f) { return f == null ? '' : f < 1 ? 'bad' : f < 1.15 ? 'warn' : 'ok'; }
  function statusTag(r) {
    if (!r.rads.length) return '<span class="note">ingen radiator</span>';
    if (!r.bal.sufficient) return '<span class="bad">räcker ej</span>';
    return `<span class="${overClass(r.bal.overdim)}">${fmtPct(r.bal.overdim)}</span>`;
  }

  // ---------- Resultat ----------
  function resultRows() {
    // En rad per radiatorpost (eller per rum utan radiator) – används av tabell och CSV
    const rows = [];
    for (const r of computeAll()) {
      if (!r.rads.length) { rows.push({ r, first: true, n: 1, incomplete: r.incomplete.length }); continue; }
      r.rads.forEach((x, i) => rows.push({ r, x, pr: r.bal.perRad[i], first: i === 0, n: r.rads.length }));
    }
    return rows;
  }
  function renderResults() {
    const res = computeAll(); const s = P.settings;
    const need = res.reduce((t, r) => t + r.loss.total, 0);
    const avail = res.reduce((t, r) => t + r.bal.available, 0);
    const flow = res.reduce((t, r) => t + (isFinite(r.bal.flowLh) ? r.bal.flowLh : 0), 0);
    const tfs = res.flatMap(r => r.bal.perRad.filter(p => p.ok && p.tf != null).map(p => p.tf));
    const tfMax = tfs.length ? Math.max(...tfs) : null;
    const bad = res.filter(r => r.rads.length && !r.bal.sufficient).length;
    const valveBad = res.reduce((t, r) => t + r.bal.perRad.filter(p => p.ok && !p.valve.setting).length, 0);
    const missing = res.filter(r => !r.rads.length && r.loss.total > 0).length;
    const modeTxt = s.calcMode === 'dt' ? `ΔT vatten ${s.dtWater} K` : `framledning ${s.tf} °C`;
    $('#kpi').innerHTML = `
      <div><b>${fmt(need)} W</b><span>Effektbehov vid DVUT ${s.dvut} °C</span></div>
      <div><b>${fmt(avail)} W</b><span>Katalogeffekt · överdim. ${fmtPct(need > 0 && avail > 0 ? avail / need - 1 : null)}</span></div>
      <div><b>${fmt(flow, 0)} l/h</b><span>Totalt flöde (${modeTxt})</span></div>
      ${s.calcMode === 'dt' ? `<div><b>${fmt(tfMax, 1)} °C</b><span>Högsta erforderliga tillopp</span></div>` : ''}
      <div><b class="${bad ? 'bad' : 'ok'}">${bad}</b><span>Rum där radiatorn inte räcker</span></div>
      <div><b class="${valveBad ? 'bad' : 'ok'}">${valveBad}</b><span>Radiatorer utan möjlig ventilinställning</span></div>
      <div><b class="${missing ? 'warn' : 'ok'}">${missing}</b><span>Rum utan radiator</span></div>`;
    const check = pr => !pr.ok ? `<span class="bad">${esc(pr.reason)}</span>` : pr.overRef ? `<span class="bad">Tillopp över referens – radiatorn räcker inte</span>` : esc(pr.valve.status);
    const html = resultRows().map(({ r, x, pr, first, n, incomplete }) => {
      const head = first ? `<td rowspan="${n}">${esc(r.room.name)}${x && r.incomplete.length ? `<br><span class="warn note">${r.incomplete.length} radiator utan sektioner</span>` : ''}</td><td rowspan="${n}">${fmt(r.geom.area, 1)}</td><td rowspan="${n}">${fmt(r.tIn, 0)}</td><td rowspan="${n}">${fmt(r.loss.total)}</td><td rowspan="${n}">${x ? fmt(r.bal.available) : '–'}</td><td rowspan="${n}" class="${x ? overClass(r.bal.overdim) : ''}">${x ? fmtPct(r.bal.overdim) : '–'}</td>` : '';
      if (!x) return `<tr>${head}<td style="text-align:left" colspan="10">${incomplete ? `<span class="warn">${incomplete} radiator(er) saknar antal sektioner</span>` : '<span class="note">ingen radiator</span>'}</td></tr>`;
      const ok = pr.ok;
      return `<tr>${head}
        <td style="text-align:left">${x.count > 1 ? x.count + ' × ' : ''}${esc(x.db.name)}${x.db.unit !== 'st' ? ` / ${fmt(x.rad.qty, x.db.unit === 'm' ? 2 : 0)}${x.db.unit === 'm' ? ' m' : ' s'}` : ''}</td>
        <td>${fmt(pr.pReq)}</td>
        <td>${ok ? fmt(pr.tf, 1) : '–'}</td><td>${ok ? fmt(pr.tr, 1) : '–'}</td>
        <td>${ok ? fmt(pr.flowLh, 1) : '<span class="bad">räcker ej</span>'}</td>
        <td>${ok ? fmt(pr.flowEach, 1) : '–'}</td>
        <td>${fmt(pr.dpKPa, 1)}</td>
        <td><b>${ok ? fmt(pr.kv, 3) : '–'}</b></td>
        <td><b>${ok ? (pr.valve.setting ?? '<span class="bad">ej möjlig</span>') : '–'}</b></td>
        <td style="text-align:left" class="note">${check(pr)}</td></tr>`;
    }).join('');
    $('#resTable').innerHTML = `<tr><th>Rum</th><th>Area m²</th><th>Temp °C</th><th>Behov W</th><th>Katalog W</th><th>Överdim.</th><th style="text-align:left">Radiator</th><th>Avge W</th><th>Tillopp °C</th><th>Retur °C</th><th>Flöde l/h</th><th>Per st l/h</th><th>Δp kPa</th><th>kv</th><th>RA-DV PURE</th><th style="text-align:left">Kontroll</th></tr>${html || '<tr><td colspan="16" class="note">Inga rum ännu.</td></tr>'}`;
    $('#resNote').textContent = (s.calcMode === 'dt'
      ? `Beräkningsmetod: fast ΔT vatten ${s.dtWater} K. För varje radiator räknas den tillopps- och returtemperatur fram som ger rätt effekt (samma metod som Strandskatan v2).`
      : `Beräkningsmetod: fast framledning ${s.tf} °C. Returtemperaturen löses så att radiatorn avger exakt behovet.`)
      + ` Temperaturdifferens: ${s.tempMethod}. Behovet fördelas på rummets radiatorer i proportion till katalogeffekt. kv = q[m³/h]/√Δp[bar] per radiator. Ventilinställning för Danfoss RA-DV PURE med givare "${s.valveSensor}" och flödesmarginal ${fmt(s.flowMargin * 100)} %; halvstegen är interpolerade, kontrollmät vid injustering.`;
  }
  $('#btnCsv').onclick = () => {
    const n2 = v => (v == null || !isFinite(v)) ? '' : String(Math.round(v * 1000) / 1000).replace('.', ',');
    const lines = [['Rum', 'Area m2', 'Rumstemp', 'Behov W', 'Katalogeffekt W', 'Överdim %', 'Radiator', 'Sektioner/längd', 'Antal', 'Avge W', 'Tillopp C', 'Retur C', 'Flöde totalt l/h', 'Flöde per st l/h', 'dp kPa', 'kv', 'RA-DV PURE', 'Kontroll'].join(';')];
    for (const { r, x, pr } of resultRows()) {
      const base = [r.room.name, n2(r.geom.area), n2(r.tIn), n2(r.loss.total)];
      if (!x) { lines.push(base.concat(['', '', r.incomplete.length ? 'sektioner saknas' : 'ingen radiator']).join(';')); continue; }
      lines.push(base.concat([n2(r.bal.available), n2(r.bal.overdim * 100), x.db.name, n2(x.rad.qty), x.count, n2(pr.pReq),
        n2(pr.tf), n2(pr.tr), pr.ok ? n2(pr.flowLh) : 'räcker ej', n2(pr.flowEach), n2(pr.dpKPa), n2(pr.kv),
        pr.ok ? (pr.valve.setting ?? 'ej möjlig') : '', !pr.ok ? pr.reason : pr.overRef ? 'Tillopp över referens' : pr.valve.status]).join(';'));
    }
    download('﻿' + lines.join('\r\n'), 'injustering.csv', 'text/csv');
  };

  // ---------- Indata ----------
  const FIELDS = [
    ['Klimat', [['dvut', 'DVUT (dim. utetemp) °C', 1], ['tIn', 'Rumstemperatur °C', 0.5], ['height', 'Rumshöjd m', 0.05]]],
    ['U-värden W/m²K', [['uWall', 'Yttervägg', 0.01], ['uWindow', 'Fönster', 0.01], ['uDoor', 'Ytterdörr', 0.01], ['uRoof', 'Tak / vindsbjälklag', 0.01], ['uFloor', 'Golv', 0.01], ['thermalBridge', 'Köldbryggetillägg (andel, 0,1 = 10 %)', 0.01]]],
    ['Temperatur under golv °C', [['tGround', 'Mark (platta)', 1], ['tBasement', 'Ouppvärmd källare', 1], ['tCrawl', 'Kryprum', 1]]],
    ['Ventilation', [['airChanges', 'Luftomsättning oms/h (rum utan angivna luftflöden)', 0.05], ['infiltration', 'Infiltration oms/h (rum med angivna luftflöden)', 0.05], ['heatRecovery', 'Värmeåtervinning på tilluft (andel 0–1)', 0.05]]],
    ['Beräkningsmetod', [
      ['calcMode', 'Metod', { dt: 'Fast ΔT vatten → beräkna tillopp/retur (Strandskatan)', tf: 'Fast framledning → beräkna retur' }],
      ['dtWater', 'ΔT vatten K (metod ΔT)', 0.5],
      ['tf', 'Framledning °C (metod framledning)', 1],
      ['trDesign', 'Dim. retur °C (för faktor, metod framledning)', 1],
      ['tempMethod', 'Temperaturdifferens', { aritmetisk: 'Aritmetisk (som Excel-mallen)', logaritmisk: 'Logaritmisk (LMTD)' }],
    ]],
    ['Ventiler', [
      ['dpKPa', 'Differenstryck över ventil kPa (för kv)', 0.5],
      ['valveSensor', 'Termostatgivare RA-DV PURE', { 'Max': 'Max (utan givare)', 'RA 2000': 'RA 2000', 'RAW/RAE/RAS-C': 'RAW/RAE/RAS-C' }],
      ['flowMargin', 'Flödesmarginal ventilval (andel, 0,1 = 10 %)', 0.05],
    ]],
  ];
  function renderSettings() {
    const field = ([k, l, st]) => typeof st === 'object'
      ? `<label class="f">${l}<select data-set="${k}" data-kind="str">${Object.entries(st).map(([v, t]) => `<option value="${esc(v)}"${P.settings[k] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`
      : `<label class="f">${l}<input type="number" step="${st}" data-set="${k}" value="${P.settings[k]}"></label>`;
    $('#settingsForm').innerHTML = FIELDS.map(([title, f]) => `<div class="panel"><h2>${title}</h2>${f.map(field).join('')}</div>`).join('') +
      `<div class="panel"><h2>Om beräkningen</h2><p class="note">Transmission: U·A·(t<sub>inne</sub> − DVUT) för yttervägg (minus fönster/dörr), fönster och tak när kall vind/yttertak finns ovanför. Golv räknas mot angiven temperatur under. Ventilation: 1,2·q·Δt. q = tilluft (med återvinning), frånluft vid uteluftsdon (+), 0 vid överluft (−), plus infiltration. Utan angivna flöden: q = oms/h · volym.</p>
      <p class="note">Radiatoreffekt: P = P<sub>kat</sub>·(Δθ / Δθ<sub>ref</sub>)<sup>n</sup>, Δθ<sub>ref</sub> = 60 K vid 90/70/20. Metod ΔT: behövd Δθ = Δθ<sub>ref</sub>·(P<sub>behov</sub>/P<sub>kat</sub>)<sup>1/n</sup>, tillopp = Δθ + t<sub>rum</sub> + ΔT/2, retur = tillopp − ΔT. Flöde = P / (ΔT · 4,2 · 1000) · 3600 l/h.</p>
      <p class="note">kv = q[m³/h] / √(Δp[bar]). RA-DV PURE: lägsta inställning vars flöde ≥ behovet inkl. marginal (Danfoss datablad 12/2025; halvsteg interpolerade).</p></div>`;
    document.querySelectorAll('[data-set]').forEach(i => i.addEventListener('change', () => {
      if (i.dataset.kind === 'str') { P.settings[i.dataset.set] = i.value; changed(); return; }
      const v = parseFloat(String(i.value).replace(',', '.')); if (isFinite(v)) { P.settings[i.dataset.set] = v; changed(); }
    }));
  }

  // ---------- Databas ----------
  function renderDb() {
    $('#dbTable').innerHTML = `<tr><th>Namn</th><th style="text-align:left">Typ</th><th>Höjd cm</th><th>Effekt W</th><th>Per</th><th>Normtemp</th><th>n</th></tr>` +
      P.db.map(d => `<tr><td>${esc(d.name)}</td><td style="text-align:left">${esc(d.type)}</td><td>${esc(d.height)}</td><td>${fmt(d.power, 1)}</td><td>${esc(d.unit)}</td><td>${d.norm.tf}/${d.norm.tr}/${d.norm.ti}</td><td>${d.n}</td></tr>`).join('');
  }
  $('#fileCsv').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\ufffd')) text = new TextDecoder('windows-1252').decode(buf); // Excel-export
    try {
      const list = C.parseRadiatorCsv(text);
      if ($('#csvReplace').checked) P.db = list; else P.db = P.db.concat(list.filter(d => !P.db.some(x => x.id === d.id)));
      changed(); alertNote(`${list.length} radiatorer importerade.`);
    } catch (e) { alertNote('Fel vid import: ' + e.message); }
    ev.target.value = '';
  });
  $('#btnDbExport').onclick = () => {
    const rows = ['id;namn;typ;fabrikat;höjd_mm;längd_mm;effekt;enhet;normtemp;exponent'].concat(P.db.map(d =>
      [d.id, d.name, d.type, d.maker, d.height, d.length, String(d.power).replace('.', ','), d.unit, `${d.norm.tf}/${d.norm.tr}/${d.norm.ti}`, String(d.n).replace('.', ',')].join(';')));
    download('﻿' + rows.join('\r\n'), 'radiatorer.csv', 'text/csv');
  };
  $('#btnDbReset').onclick = () => { P.db = defaultDb(); changed(); };
  function alertNote(t) { hint(t); const n = document.createElement('p'); n.className = 'note'; n.textContent = t; $('#dbTable').before(n); setTimeout(() => n.remove(), 5000); }

  // ---------- Filer ----------
  const MAX_PLAN_PX = 3000; // håller projektfilen hanterbar
  function setPlanFromCanvas(cv, pxPerM) {
    P.plan.image = cv.toDataURL('image/jpeg', 0.85); P.plan.w = cv.width; P.plan.h = cv.height;
    if (pxPerM) P.plan.pxPerM = pxPerM;
    changed(); fit();
    if (pxPerM) { setMode('pan'); hint(`Skala satt från ritningen: ${fmt(pxPerM, 1)} px/m. Kontrollera gärna mot ett känt mått med "Skala".`); }
    else setMode('scale');
  }
  function loadScript(src) {
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('Kunde inte ladda ' + src)); document.head.appendChild(sc); });
  }
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' tog för lång tid')), ms); })]).finally(() => clearTimeout(t));
  }
  async function loadPdf(file) {
    hint('Läser PDF …');
    if (!window.pdfjsLib) {
      await withTimeout(loadScript(PDFJS + 'pdf.min.js'), 30000, 'Att ladda PDF-läsaren');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await withTimeout(window.pdfjsLib.getDocument({ data }).promise, 60000, 'Att öppna PDF:en');
    let pageNo = 1;
    if (doc.numPages > 1) {
      const a = await ask(`PDF:en har ${doc.numPages} sidor. Vilken sida är planritningen?`, '1');
      if (a === null) return;
      pageNo = Math.min(doc.numPages, Math.max(1, parseInt(a) || 1));
    }
    const page = await doc.getPage(pageNo);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = MAX_PLAN_PX / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const found = await readDesignations(page, vp);
    // PDF-enheter är punkter (1 pt = 25,4/72 mm på papperet). Med känd ritningsskala ges px/m direkt.
    const a = await ask('Ritningens skala 1: (t.ex. 50 eller 100). Lämna tomt för att kalibrera själv med två punkter. Gäller bara om PDF:en är i originalstorlek, inte inskannad i annan storlek.', '100');
    const denom = parseFloat(String(a || '').replace(',', '.'));
    const pxPerM = denom > 0 ? (1000 / denom) / (25.4 / 72) * scale : null;
    if (found.length) {
      P.radiators.push(...found);
      assignRadiators();
    }
    setPlanFromCanvas(cv, pxPerM);
    if (found.length) hint(`${found.length} radiatorbeteckningar avlästa ur ritningen (orange markeringar). Kontrollera dem – klicka på en markering för att ändra. ` + $('#hint').textContent);
    else if (matchMedia('(pointer: coarse)').matches) {
      await runOcr([{ img: cv, k: 1 }]); // surfplatta/telefon: ett pass för att spara minne
    } else {
      // Inskannad ritning utan textlager: OCR på planbilden och på en skarpare rendering, resultaten slås ihop
      const k = 1.6, vpHi = page.getViewport({ scale: scale * k });
      const hi = document.createElement('canvas'); hi.width = Math.round(vpHi.width); hi.height = Math.round(vpHi.height);
      const hctx = hi.getContext('2d'); hctx.fillStyle = '#fff'; hctx.fillRect(0, 0, hi.width, hi.height);
      await page.render({ canvasContext: hctx, viewport: vpHi }).promise;
      await runOcr([{ img: cv, k: 1 }, { img: hi, k }]);
    }
  }

  // ---------- Luftflödesetiketter ("+/45" = tilluft/frånluft m³/h) ----------
  /** Luftflöden i en textrad som inte överlappar radiatorbeteckningar. pos(index) ger planposition. */
  function airLabelsIn(text, designations, pos) {
    const busy = designations.map(m => [m.index, m.index + m.length]);
    return C.findAirflows(text).filter(a => !busy.some(([x, y]) => a.index < y && a.index + a.length > x))
      .map(a => Object.assign(pos(a.index + a.length / 2), { supply: a.supply, exhaust: a.exhaust, raw: a.raw }));
  }
  function addAirLabels(list) {
    P.plan.airLabels = P.plan.airLabels || [];
    const tol = 0.4 * P.plan.pxPerM;
    for (const a of list) if (!P.plan.airLabels.some(b => Math.hypot(a.x - b.x, a.y - b.y) < tol)) P.plan.airLabels.push(a);
  }
  /** Fyller i till-/frånluft för rum som saknar värden, från avlästa etiketter inuti rummet. */
  function applyAirLabels() {
    let n = 0;
    for (const room of P.rooms) {
      if (String(room.supply ?? '') !== '' || String(room.exhaust ?? '') !== '') continue;
      const a = (P.plan.airLabels || []).find(l => C.pointInPolygon(l, room.pts));
      if (a) { room.supply = a.supply; room.exhaust = a.exhaust; room.airRaw = a.raw; n++; }
    }
    return n;
  }

  // ---------- OCR (inskannade ritningar) ----------
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/';
  const TESS_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';
  let ocrBusy = false, ocrCancel = null;
  /** OCR-filer: först de som ligger bredvid appen (ocr/), annars CDN. */
  function ocrSources() {
    const out = [];
    try {
      const local = new URL('ocr/', document.baseURI).href;
      // Språkdata ligger som .wasm-fil (gzip-innehåll) eftersom artifact-värden bara serverar vissa filtyper.
      // (tesseract hämtar langPath + '/eng.traineddata.gz'; frågesträngen gör att filen ovan hämtas)
      out.push({ name: 'lokalt', script: local + 'tesseract.min.js', opts: { workerPath: local + 'worker.min.js', corePath: local, langPath: local + 'eng.traineddata.wasm?f=', workerBlobURL: false } });
    } catch (e) { /* ingen bas-URL */ }
    out.push({ name: 'CDN', script: TESS + 'tesseract.min.js', opts: { workerPath: TESS + 'worker.min.js', langPath: TESS_LANG } });
    return out;
  }
  async function startOcrWorker(guard, logger) {
    const errs = [];
    for (const src of ocrSources()) {
      let step = 'laddar skript';
      try {
        if (!window.Tesseract) await guard(loadScript(src.script), 30000, 'Skriptet');
        step = 'startar';
        return await guard(window.Tesseract.createWorker('eng', 1, Object.assign({ gzip: true, logger, errorHandler: () => {} }, src.opts)), src.name === 'lokalt' ? 60000 : 90000, 'Starten');
      } catch (e) {
        if (e && e.message === 'avbruten') throw e;
        errs.push(`${src.name}: ${step} – ${(e && e.message) || e}`);
        if (src.name === 'lokalt') { try { delete window.Tesseract; } catch (x) { window.Tesseract = undefined; } }
      }
    }
    throw new Error(errs.join('; '));
  }
  /** Textigenkänning på ritningsbilden; lägger till radiatorer för hittade beteckningar. */
  async function runOcr(sources) {
    if (ocrBusy) { if (ocrCancel) ocrCancel(); return; }
    if (!P.plan.image && !sources) { hint('Ladda en ritning först.'); return; }
    sources = sources || [{ img: P.plan.image, k: 1 }];
    ocrBusy = true; $('#btnOcr').textContent = 'Avbryt avläsning';
    let worker = null, pass = 0, cancelled = false;
    const cancelP = new Promise((_, rej) => { ocrCancel = () => { cancelled = true; rej(new Error('avbruten')); }; });
    const guard = (p, ms, what) => Promise.race([withTimeout(p, ms, what), cancelP]);
    try {
      hint('Läser av radiatorbeteckningar med textigenkänning … laddar OCR (första gången kan ta en stund).');
      worker = await startOcrWorker(guard, m => { if (m.status === 'recognizing text') hint(`Läser av radiatorbeteckningar … ${Math.round((pass + m.progress) / sources.length * 100)} % (du kan rita under tiden)`); });
      await worker.setParameters({ tessedit_pageseg_mode: '11' }); // gles text, som på ritningar
      const found = [], airs = [];
      for (const src of sources) {
      const { data } = await guard(worker.recognize(src.img), 300000, 'Textigenkänningen');
      pass++;
      for (const line0 of data.lines || []) {
        const line = { text: line0.text, bbox: { x0: line0.bbox.x0 / src.k, x1: line0.bbox.x1 / src.k, y0: line0.bbox.y0 / src.k, y1: line0.bbox.y1 / src.k } };
        const text = line.text.replace(/\n/g, ' ');
        const des = C.findDesignations(text, P.db);
        airs.push(...airLabelsIn(text, des, i => ({ x: line.bbox.x0 + (line.bbox.x1 - line.bbox.x0) * i / Math.max(1, text.length), y: (line.bbox.y0 + line.bbox.y1) / 2 })));
        for (const m of des) {
          const b = line.bbox, w = b.x1 - b.x0;
          const x = b.x0 + w * (m.index + m.length / 2) / Math.max(1, text.length);
          const y = (b.y0 + b.y1) / 2;
          const near = r => Math.hypot(r.x - x, r.y - y) < 0.6 * P.plan.pxPerM;
          if (P.radiators.some(near) || found.some(near)) continue; // redan avläst
          found.push({ id: uid(), roomId: null, x, y, dbId: m.dbId, qty: m.qty, count: m.count, dpKPa: '', auto: true, raw: m.raw });
        }
      }
      }
      P.radiators.push(...found);
      addAirLabels(airs);
      assignRadiators(); applyAirLabels(); changed();
      const airTxt = airs.length ? ` ${P.plan.airLabels.length} luftflöden (till/från) hittades och fylls i när rummen ritas.` : '';
      hint((found.length
        ? `${found.length} radiatorbeteckningar avlästa med textigenkänning (orange). Kontrollera dem mot ritningen – handskrivna noteringar läses inte. Klicka på en markering för att ändra.`
        : 'Inga radiatorbeteckningar hittades med textigenkänning. Placera radiatorerna manuellt.') + airTxt);
    } catch (e) {
      hint(cancelled ? 'Avläsningen avbröts. Du kan köra den igen med "Läs beteckningar".'
        : 'Textigenkänningen kunde inte köras här (' + (e && e.message || e) + '). Placera radiatorerna manuellt.');
    } finally {
      if (worker) { try { worker.terminate(); } catch (e) { /* redan stoppad */ } }
      ocrBusy = false; ocrCancel = null; $('#btnOcr').textContent = 'Läs beteckningar';
    }
  }
  $('#btnOcr').onclick = () => runOcr();
  /** Läser PDF-sidans text, slår ihop ord på samma rad och letar radiatorbeteckningar. */
  async function readDesignations(page, vp) {
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const h = Math.hypot(it.transform[2], it.transform[3]) * vp.scale;
      const w = (it.width || 0) * vp.scale;
      return { str: it.str, x, y, h, w };
    });
    // Gruppera i rader (liknande y), sortera på x och bygg en sträng med positionskarta
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find(l => Math.abs(l.y - it.y) < Math.max(2, it.h * 0.4) && it.x - l.end < it.h * 2);
      if (line) { line.items.push(it); line.end = Math.max(line.end, it.x + it.w); } else lines.push({ y: it.y, end: it.x + it.w, items: [it] });
    }
    const out = [];
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let text = '', map = [];
      for (const it of l.items) { if (text) { text += ' '; map.push(it); } for (const _ of it.str) map.push(it); text += it.str; }
      const des = C.findDesignations(text, P.db);
      addAirLabels(airLabelsIn(text, des, i => { const it = map[Math.floor(i)] || l.items[0]; return { x: it.x + (it.w || 0) / 2, y: it.y - it.h / 2 }; }));
      for (const m of des) {
        const it = map[m.index] || l.items[0];
        out.push({ id: uid(), roomId: null, x: it.x + (it.w || 0) / 2, y: it.y - it.h / 2, dbId: m.dbId, qty: m.qty, count: m.count, dpKPa: '', auto: true, raw: m.raw });
      }
    }
    return out;
  }
  $('#fileImage').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    ev.target.value = '';
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      try { await loadPdf(f); } catch (e) { hint('Kunde inte läsa PDF:en: ' + e.message); }
      return;
    }
    if (!f.type.startsWith('image/')) { hint('Ladda ritningen som PDF eller bild (PNG/JPG).'); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_PLAN_PX / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url); setPlanFromCanvas(cv, null);
      runOcr([{ img: cv, k: 1 }]);
    };
    img.onerror = () => hint('Kunde inte läsa bilden.');
    img.src = url;
  });
  $('#btnExport').onclick = () => download(JSON.stringify(P), 'vscalc-projekt.json', 'application/json');
  $('#fileProject').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try { P = Object.assign(newProject(), JSON.parse(await f.text())); P.settings = { ...DEFAULT_SETTINGS, ...P.settings }; selRoom = null; changed(); fit(); }
    catch (e) { hint('Kunde inte läsa projektfilen.'); }
    ev.target.value = '';
  });
  $('#btnNew').onclick = async () => {
    if ((await ask('Skriv JA för att börja ett nytt projekt (nuvarande töms).', '')) !== 'JA') return;
    const db = P.db; P = newProject(); P.db = db; selRoom = null; changed(); fit();
  };
  $('#btnFit').onclick = fit;
  const zoomCenter = f => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); draw(); };
  $('#btnZoomIn').onclick = () => zoomCenter(1 / 1.4);
  $('#btnZoomOut').onclick = () => zoomCenter(1.4);
  // I claude.ai-artefakter går nedladdning via plattformens downloads-capability; annars vanlig länk.
  const dlPromise = (window.claude && window.claude.use) ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  async function download(content, name, type) {
    const dl = await dlPromise;
    if (dl) {
      try { await dl.save({ filename: name, data: content }); }
      catch (e) { if (e && e.code !== 'declined') hint('Kunde inte spara filen: ' + (e.message || e.code)); }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Flikar ----------
  let tab = 'plan';
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.view;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + tab));
    refresh(); if (tab === 'plan') fit();
  }));

  function refresh() {
    if (tab === 'plan') { draw(); renderSide(); }
    if (tab === 'results') renderResults();
    if (tab === 'settings') renderSettings();
    if (tab === 'db') renderDb();
  }
  function changed() { save(); refresh(); }
  window.addEventListener('resize', () => tab === 'plan' && fit());

  setMode('pan'); fit(); refresh();
})();
