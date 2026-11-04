/* VScalc – beräkningskärna för injustering av vattenburna värmesystem.
 * Rena funktioner utan DOM-beroenden, så att de kan testas i Node.
 * Enheter: längd m, area m², temperatur °C, effekt W, flöde l/h, tryck kPa.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VSCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Värmekapacitet per liter vatten, kJ/(l·K). 4,2 som i Strandskatan-mallen.
  const WATER_KJ_PER_LK = 4.2;
  const RHO_CP_AIR = 1.2 * 1005 / 1000; // W per (l/s)·K

  // ---------- Geometri ----------
  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }
  function dist(p, q) { return Math.hypot(q.x - p.x, q.y - p.y); }
  /** Närmaste punkt på polygonens kant och avståndet dit. */
  function nearestOnPolygon(pt, pts) {
    let best = { x: pts[0].x, y: pts[0].y, d: Infinity };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L)) : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(pt.x - q.x, pt.y - q.y);
      if (d < best.d) best = { x: q.x, y: q.y, d };
    }
    return best;
  }
  function pointInPolygon(pt, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // ---------- Värmeförluster ----------
  /**
   * room: { area, height, tIn, walls:[{length, exterior, windowArea, doorArea}],
   *         above:'vind'|'tak'|'uppvarmt', below:'mark'|'kallare'|'kryprum'|'uppvarmt',
   *         airChanges (oms/h) }
   * s: { dvut, tGround, tBasement, tCrawl, uWall, uWindow, uDoor, uRoof, uFloor,
   *      airChanges, heatRecovery (0–1), thermalBridge (0–1) }
   */
  function roomHeatLoss(room, s) {
    const tIn = num(room.tIn, s.tIn);
    const dT = tIn - s.dvut;
    const h = num(room.height, s.height);
    const parts = [];
    let wallA = 0, winA = 0, doorA = 0;
    for (const w of room.walls || []) {
      if (!w.exterior) continue;
      const gross = w.length * h;
      const win = num(w.windowArea, 0), door = num(w.doorArea, 0);
      wallA += Math.max(0, gross - win - door);
      winA += win; doorA += door;
    }
    parts.push({ key: 'vagg', label: 'Yttervägg', area: wallA, u: s.uWall, dT, w: wallA * s.uWall * dT });
    parts.push({ key: 'fonster', label: 'Fönster', area: winA, u: s.uWindow, dT, w: winA * s.uWindow * dT });
    if (doorA > 0) parts.push({ key: 'dorr', label: 'Ytterdörr', area: doorA, u: s.uDoor, dT, w: doorA * s.uDoor * dT });

    const A = room.area;
    if (room.above === 'vind' || room.above === 'tak') {
      parts.push({ key: 'tak', label: room.above === 'vind' ? 'Vindsbjälklag' : 'Yttertak', area: A, u: s.uRoof, dT, w: A * s.uRoof * dT });
    }
    const tBelow = { mark: s.tGround, kallare: s.tBasement, kryprum: s.tCrawl }[room.below];
    if (tBelow !== undefined) {
      const dTf = tIn - tBelow;
      parts.push({ key: 'golv', label: 'Golv', area: A, u: s.uFloor, dT: dTf, w: A * s.uFloor * dTf });
    }
    const transmission = parts.reduce((t, p) => t + p.w, 0);
    const bridges = transmission * num(s.thermalBridge, 0);
    if (bridges > 0) parts.push({ key: 'kb', label: 'Köldbryggor', w: bridges });

    const n = num(room.airChanges, s.airChanges);
    const volume = A * h;
    const flowLs = n * volume / 3.6;
    const vent = RHO_CP_AIR * flowLs * dT * (1 - num(s.heatRecovery, 0));
    parts.push({ key: 'vent', label: 'Ventilation/infiltration', flowLs, w: vent });

    const total = parts.reduce((t, p) => t + p.w, 0);
    return { total, parts, dT, volume, exteriorWallArea: wallA, windowArea: winA };
  }

  // ---------- Radiatorer ----------
  /** Logaritmisk medeltemperaturdifferens. */
  function lmtd(tf, tr, ti) {
    const a = tf - ti, b = tr - ti;
    if (a <= 0 || b <= 0) return 0;
    if (Math.abs(a - b) < 1e-9) return a;
    return (a - b) / Math.log(a / b);
  }
  /** Medeltemperaturdifferens: 'aritmetisk' ((tf+tr)/2 − ti) eller 'logaritmisk' (LMTD). */
  function meanDiff(tf, tr, ti, method) {
    if (method === 'logaritmisk') return lmtd(tf, tr, ti);
    return Math.max(0, (tf + tr) / 2 - ti);
  }
  /** Normeffekt för en vald radiator (W) vid dess normtemperaturer. */
  function nominalPower(dbRad, qty) {
    return dbRad.power * (dbRad.unit === 'st' ? 1 : num(qty, 1));
  }
  /** Avgiven effekt vid aktuella temperaturer. */
  function radiatorOutput(pNom, norm, n, tf, tr, ti, method) {
    const ref = meanDiff(norm.tf, norm.tr, norm.ti, method);
    const act = meanDiff(tf, tr, ti, method);
    if (ref <= 0 || act <= 0) return 0;
    return pNom * Math.pow(act / ref, n);
  }
  /**
   * Beräknar returtemperatur och flöde som krävs för att radiatorn ska avge pReq.
   * Returnerar { ok, tr, flowLh, pMax, reason }.
   */
  function requiredFlow(pNom, norm, n, pReq, tf, ti, method) {
    const pMax = radiatorOutput(pNom, norm, n, tf, tf - 1e-6, ti, method);
    if (pReq <= 0) return { ok: true, tr: null, flowLh: 0, pMax };
    if (pReq >= pMax) return { ok: false, tr: null, flowLh: Infinity, pMax, reason: 'Radiatorn räcker inte ens vid oändligt flöde' };
    let lo = ti + 1e-6, hi = tf - 1e-6;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (radiatorOutput(pNom, norm, n, tf, mid, ti, method) < pReq) lo = mid; else hi = mid;
    }
    const tr = (lo + hi) / 2;
    return { ok: true, tf, tr, flowLh: flowFor(pReq, tf - tr), pMax };
  }
  /** Flöde l/h för effekt P (W) och temperaturfall dt. */
  function flowFor(p, dt) { return p / (dt * WATER_KJ_PER_LK * 1000) * 3600; }

  /**
   * Strandskatan-metoden: fast ΔT över radiatorn. Beräknar den tillopps- och
   * returtemperatur som krävs för att radiatorn ska avge pReq, samt flödet.
   */
  function requiredTempsAtDt(pNom, norm, n, pReq, dt, ti, method) {
    if (pReq <= 0 || pNom <= 0) return { ok: true, tf: null, tr: null, flowLh: 0 };
    const ref = meanDiff(norm.tf, norm.tr, norm.ti, method);
    const need = ref * Math.pow(pReq / pNom, 1 / n);
    let tf;
    if (method === 'logaritmisk') {
      let lo = ti + dt + 1e-6, hi = ti + dt + 500;
      for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (lmtd(mid, mid - dt, ti) < need) lo = mid; else hi = mid; }
      tf = (lo + hi) / 2;
    } else tf = need + ti + dt / 2;
    return { ok: true, tf, tr: tf - dt, dTheta: need, flowLh: flowFor(pReq, dt) };
  }

  /** Danfoss RA-DV PURE: max flöde (l/h) per inställning och givare (från Ventildata-fliken). */
  const RADV_PURE = {
    settings: ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', '5.5', '6', '6.5', '7', '7.5'],
    flows: {
      'Max': [10, 12.5, 15, 17.5, 20, 27.5, 35, 42.5, 50, 65, 80, 90, 100, 117.5],
      'RA 2000': [9, 11.5, 14, 16, 18, 24, 30, 37.5, 45, 57.5, 70, 80, 90, 110],
      'RAW/RAE/RAS-C': [8, 10, 12, 14, 16, 20.5, 25, 32.5, 40, 52.5, 65, 75, 85, 97.5],
    },
  };
  /** Lägsta inställning vars flöde ≥ behovet inkl. marginal (samma logik som Excel-mallen). */
  function valveSetting(flowLh, sensor, margin) {
    const tab = RADV_PURE.flows[sensor] || RADV_PURE.flows.Max;
    const q = flowLh * (1 + (margin || 0));
    if (!isFinite(q)) return { setting: null, maxFlow: null, status: 'Ej möjlig' };
    const i = tab.findIndex(v => v >= q);
    if (i < 0) return { setting: null, maxFlow: null, status: `Flödet överstiger max ${tab[tab.length - 1]} l/h` };
    return { setting: RADV_PURE.settings[i], maxFlow: tab[i], status: q < tab[0] ? 'Lägsta inställning ger mer än behovet' : 'OK' };
  }
  /** kv = q[m³/h] / sqrt(Δp[bar]) */
  function kv(flowLh, dpKPa) {
    if (!isFinite(flowLh) || dpKPa <= 0) return NaN;
    return (flowLh / 1000) / Math.sqrt(dpKPa / 100);
  }

  /**
   * Komplett beräkning för ett rum.
   * rads: [{ pNom (totalt för alla 'count' st), count, norm:{tf,tr,ti}, n, dpKPa? }]
   * sys: { mode:'dt'|'tf', dt, tf, trDesign, dpKPa, method, sensor, margin }
   * Effektbehovet fördelas på rummets radiatorer i proportion till normeffekt.
   */
  function roomBalance(need, tIn, rads, sys) {
    const m = sys.method;
    const pNomTot = rads.reduce((t, r) => t + r.pNom, 0);
    const installedDesign = rads.reduce((t, r) => t + radiatorOutput(r.pNom, r.norm, r.n, sys.tf, sys.trDesign, tIn, m), 0);
    const factor = need > 0 ? installedDesign / need : null;
    // Överdimensionering mot katalogeffekt (som mallens "tillgänglig effekt vid 90/70")
    const available = pNomTot;
    const overdim = need > 0 && available > 0 ? available / need - 1 : null;
    const perRad = rads.map(r => {
      const share = pNomTot > 0 ? r.pNom / pNomTot : 0;
      const pReq = need * share;
      const pAvail = radiatorOutput(r.pNom, r.norm, r.n, r.norm.tf, r.norm.tr, tIn, m);
      const f = sys.mode === 'dt'
        ? requiredTempsAtDt(pAvail, { tf: r.norm.tf, tr: r.norm.tr, ti: tIn }, r.n, pReq, sys.dt, tIn, m)
        : requiredFlow(r.pNom, r.norm, r.n, pReq, sys.tf, tIn, m);
      const count = Math.max(1, r.count || 1);
      const flowEach = f.flowLh / count;
      const dp = num(r.dpKPa, sys.dpKPa);
      // Som mallens kontroll: kräver radiatorn högre tillopp än katalogens referens räcker den inte i praktiken
      const overRef = f.ok && f.tf != null && sys.mode === 'dt' && f.tf > r.norm.tf;
      return Object.assign({ pReq, overRef, pAvail, count, flowEach, dpKPa: dp, kv: kv(flowEach, dp),
        valve: valveSetting(flowEach, sys.sensor, sys.margin),
        pDesign: radiatorOutput(r.pNom, r.norm, r.n, sys.tf, sys.trDesign, tIn, m) }, f);
    });
    const flowLh = perRad.reduce((t, r) => t + r.flowLh, 0);
    return { installedDesign, available, factor, overdim, perRad, flowLh, ok: perRad.every(r => r.ok),
      sufficient: perRad.every(r => r.ok && !r.overRef) };
  }

  /** Läser radiatorförteckning i CSV (semikolon eller komma). */
  function parseRadiatorCsv(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    const head = lines[0].split(sep).map(h => h.trim().toLowerCase());
    const col = (...names) => head.findIndex(h => names.includes(h));
    const c = {
      id: col('id'), name: col('namn', 'name', 'benämning'), type: col('typ', 'type'),
      maker: col('fabrikat', 'tillverkare'), h: col('höjd', 'hojd', 'höjd_mm', 'hojd_mm'),
      l: col('längd', 'langd', 'längd_mm', 'langd_mm', 'djup'), p: col('effekt', 'effekt_w', 'power'),
      unit: col('enhet', 'unit'), norm: col('normtemp', 'norm'), n: col('exponent', 'n'),
    };
    if (c.name < 0 || c.p < 0) throw new Error('CSV måste ha minst kolumnerna "namn" och "effekt"');
    const out = [];
    lines.slice(1).forEach((line, i) => {
      const v = line.split(sep).map(x => x.trim());
      const g = k => (c[k] >= 0 ? v[c[k]] : '');
      const p = parseFloat(String(g('p')).replace(',', '.'));
      if (!isFinite(p)) return;
      const nt = (g('norm') || '90/70/20').split('/').map(x => parseFloat(x.replace(',', '.')));
      out.push({
        id: g('id') || 'csv-' + (i + 1), name: g('name'), type: g('type'), maker: g('maker'),
        height: g('h'), length: g('l'), power: p,
        unit: (g('unit') || 'st').toLowerCase(),
        norm: { tf: nt[0], tr: nt[1], ti: nt[2] },
        n: parseFloat(String(g('n') || '1.3').replace(',', '.')) || 1.3,
      });
    });
    return out;
  }

  /**
   * Hittar radiatorbeteckningar i fritext, t.ex. "MR 59-20", "MP2 44/16", "2×MR59-20", "MR 59 20 sekt".
   * Matchar bara serie + höjd som finns i databasen. Returnerar [{index, length, raw, dbId, qty, count}].
   */
  function findDesignations(text, db) {
    const byKey = new Map();
    for (const d of db) if (d.type && d.height) byKey.set((d.type + '|' + d.height).toUpperCase().replace(/\s/g, ''), d);
    const series = [...new Set(db.map(d => String(d.type || '').trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
    if (!series.length) return [];
    const re = new RegExp('(?<![A-Za-zÅÄÖåäö0-9])(?:(\\d{1,2})\\s*(?:st|x|×|\\*)\\s*)?(' + series.join('|') +
      ')\\s*[-.]?\\s*(\\d{2,3})(?:\\s*(?:[-\\/x×*:]|\\s)\\s*(\\d{1,3})(?!\\d)(?:\\s*(?:sekt|s)\\b\\.?)?)?', 'gi');
    // Äldre ritningar: "sektioner - höjd - serie", t.ex. "52-44-MP" (även OCR-varianter av bindestreck)
    const D = '\\s*[-–—~=.]+\\s*';
    const reRev = new RegExp('(?<![A-Za-zÅÄÖåäö0-9])(\\d{1,3})' + D + '(\\d{2,3})' + D + '(' + series.join('|') + ')(?![A-Za-zÅÄÖåäö0-9])', 'gi');
    const out = [];
    const taken = [];
    const free = (i, len) => !taken.some(([a, b]) => i < b && i + len > a);
    const push = (m, series, height, qty, count) => {
      const d = byKey.get((series + '|' + height).toUpperCase().replace(/\s/g, ''));
      if (!d || !free(m.index, m[0].length)) return;
      taken.push([m.index, m.index + m[0].length]);
      out.push({ index: m.index, length: m[0].length, raw: m[0].trim(), dbId: d.id, qty, count });
    };
    let m;
    while ((m = reRev.exec(text))) push(m, m[3], m[2], parseInt(m[1], 10), 1);
    while ((m = re.exec(text))) push(m, m[2], m[3], m[4] ? parseInt(m[4], 10) : null, m[1] ? parseInt(m[1], 10) : 1);
    return out.sort((x, y) => x.index - y.index);
  }

  function num(v, d) { const x = parseFloat(v); return isFinite(x) ? x : d; }

  return { polygonArea, dist, pointInPolygon, nearestOnPolygon, roomHeatLoss, lmtd, meanDiff, nominalPower, radiatorOutput,
    requiredFlow, requiredTempsAtDt, flowFor, valveSetting, RADV_PURE, kv, roomBalance, parseRadiatorCsv, findDesignations, WATER_KJ_PER_LK };
});
