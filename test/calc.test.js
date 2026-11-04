const assert = require('assert');
const C = require('../src/calc.js');
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
const L = 'logaritmisk', A = 'aritmetisk';

near(C.lmtd(90, 70, 20), 59.44, 0.01, 'lmtd');
near(C.meanDiff(90, 70, 20, A), 60, 1e-9, 'arit');
near(C.radiatorOutput(1000, { tf: 90, tr: 70, ti: 20 }, 1.3, 90, 70, 20, L), 1000, 1e-9, 'nominal');
near(C.radiatorOutput(1000, { tf: 90, tr: 70, ti: 20 }, 1.3, 55, 45, 20, A), 1000 * Math.pow(30 / 60, 1.3), 1e-9, 'scaled arit');

// Fast framledning: be om effekten vid 70/50 -> retur 50
const norm = { tf: 90, tr: 70, ti: 20 };
for (const m of [L, A]) {
  const pAt = C.radiatorOutput(1500, norm, 1.3, 70, 50, 21, m);
  const f = C.requiredFlow(1500, norm, 1.3, pAt, 70, 21, m);
  near(f.tr, 50, 1e-4, 'tr ' + m);
  near(f.flowLh, pAt / (20 * 4200) * 3600, 1e-3, 'flow ' + m);
}
assert(!C.requiredFlow(500, norm, 1.3, 2000, 55, 21, A).ok, 'undersized flagged');

// Strandskatan v2, rad 13: MR 59 × 43 sekt, överdim 0,7, rum 21, DT 15, n 1,3
const G = 43 * 46.98, K = G / 1.7;
const r = C.requiredTempsAtDt(G, { tf: 90, tr: 70, ti: 20 }, 1.3, K, 15, 21, A);
const Lx = 60 * Math.pow(K / G, 1 / 1.3);
near(r.tf, Lx + 21 + 7.5, 1e-9, 'ny tillopp'); near(r.tr, Lx + 21 - 7.5, 1e-9, 'ny retur');
near(r.flowLh, K / (15 * 4.2 * 1000) * 3600, 1e-9, 'flöde');
// Log-variant: lmtd(tf, tf-dt) ska bli behövd Δθ
const rl = C.requiredTempsAtDt(1000, norm, 1.3, 600, 15, 20, L);
near(C.lmtd(rl.tf, rl.tr, 20), C.lmtd(90, 70, 20) * Math.pow(0.6, 1 / 1.3), 1e-6, 'log dt');

// Ventil RA-DV PURE
assert.strictEqual(C.valveSetting(33, 'Max', 0).setting, '4');      // 35 ≥ 33
assert.strictEqual(C.valveSetting(35, 'Max', 0).setting, '4');
assert.strictEqual(C.valveSetting(33, 'RA 2000', 0.1).setting, '4.5'); // 36,3 -> 37,5
assert.strictEqual(C.valveSetting(200, 'Max', 0).setting, null);
assert.strictEqual(C.valveSetting(5, 'Max', 0).setting, '1');

near(C.kv(100, 10), 0.3162, 1e-4, 'kv');

// Värmeförlust
const s = { dvut: -16, tIn: 21, height: 2.5, uWall: 0.5, uWindow: 2.0, uDoor: 2, uRoof: 0.3, uFloor: 0.4,
  tGround: 5, tBasement: 10, tCrawl: 0, airChanges: 0.5, heatRecovery: 0, thermalBridge: 0 };
const h = C.roomHeatLoss({ area: 12, walls: [{ length: 4, exterior: true, windowArea: 2 }], above: 'vind', below: 'uppvarmt' }, s);
near(h.total, 8 * 0.5 * 37 + 2 * 2 * 37 + 12 * 0.3 * 37 + 1.206 * (0.5 * 30 / 3.6) * 37, 1e-6, 'heat loss');

// roomBalance dt-läge, två identiska radiatorer -> flöde per st halveras
const bal = C.roomBalance(1000, 21, [{ pNom: 2000, count: 2, norm, n: 1.3 }], { mode: 'dt', dt: 15, tf: 70, trDesign: 50, dpKPa: 10, method: A, sensor: 'Max', margin: 0 });
near(bal.overdim, 1, 1e-9, 'överdim'); near(bal.perRad[0].flowEach, bal.perRad[0].flowLh / 2, 1e-9, 'per st');

near(C.polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]), 12, 1e-9, 'area');
const db = C.parseRadiatorCsv(require('fs').readFileSync(__dirname + '/../data/radiatorer.csv', 'utf8'));
assert.strictEqual(db.length, 78); assert.strictEqual(db.find(d => d.name === 'MR 59').power, 46.98);
console.log('Alla tester OK');
{
  const db2 = C.parseRadiatorCsv(require('fs').readFileSync(__dirname + '/../data/radiatorer.csv', 'utf8'));
  const f = t => C.findDesignations(t, db2).map(x => `${x.count}|${x.dbId}|${x.qty}`);
  assert.deepStrictEqual(f('Rad MR 59-20 vid fönster'), ['1|mr-59|20']);
  assert.deepStrictEqual(f('MP2 44/16'), ['1|mp2-44|16']);
  assert.deepStrictEqual(f('2×MR59-20'), ['2|mr-59|20']);
  assert.deepStrictEqual(f('MP2C 99 12 sekt'), ['1|mp2c-99|12']);
  assert.deepStrictEqual(f('N40 100-8'), ['1|n40-100|8']);
  assert.deepStrictEqual(f('MP3 59'), ['1|mp3-59|null']);
  assert.deepStrictEqual(f('RUM 12 MR 33-10 D 44-15'), ['1|d-44|15']); // MR 33 finns ej
  assert.deepStrictEqual(f('VARDAGSRUM 59'), []);
  console.log('Beteckningar OK');
}
{
  const db2 = C.parseRadiatorCsv(require('fs').readFileSync(__dirname + '/../data/radiatorer.csv', 'utf8'));
  assert.deepStrictEqual(C.findDesignations('2xMP2 44/16', db2).map(x => x.count + '|' + x.dbId + '|' + x.qty), ['2|mp2-44|16']);
  const b = C.roomBalance(3000, 21, [{ pNom: 1000, count: 1, norm: { tf: 90, tr: 70, ti: 20 }, n: 1.3 }], { mode: 'dt', dt: 15, method: 'aritmetisk', sensor: 'Max', margin: 0, dpKPa: 10, tf: 70, trDesign: 50 });
  assert(b.perRad[0].overRef && !b.sufficient, 'över referens');
  console.log('Kontroller OK');
}
{
  const db2 = C.parseRadiatorCsv(require('fs').readFileSync(__dirname + '/../data/radiatorer.csv', 'utf8'));
  const f = t => C.findDesignations(t, db2).map(x => `${x.count}|${x.dbId}|${x.qty}`);
  assert.deepStrictEqual(f('Bv 52-44 - MP   24 - 44 - MP'), ['1|mp-44|52', '1|mp-44|24']);
  assert.deepStrictEqual(f('10-59-MP Vd 10'), ['1|mp-59|10']);
  assert.deepStrictEqual(f('28 – 74 — MP'), ['1|mp-74|28']);
  assert.deepStrictEqual(f('22-30-MP2'), ['1|mp2-30|22']);
  assert.deepStrictEqual(f('18-44-MP'), ['1|mp-44|18']);
  console.log('Äldre format OK');
}
{
  const q = C.nearestOnPolygon({ x: 2, y: -3 }, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  near(q.d, 3, 1e-9, 'avstånd'); near(q.x, 2, 1e-9, 'x'); near(q.y, 0, 1e-9, 'y');
  console.log('Geometri OK');
}
