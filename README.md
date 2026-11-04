# VScalc – injustering av vattenburna värmesystem

Webbapp (ren HTML/JS, ingen server) för att beräkna effektbehov per rum vid DVUT, jämföra med installerade radiatorer och få flöde och kv-värde per radiator.

## Struktur
- `src/calc.js` – beräkningskärna (värmeförlust, LMTD-skalning av radiatoreffekt, flöde, kv, CSV-import). Ren JS, testbar i Node.
- `src/app.js`, `src/index.html`, `src/style.css` – gränssnitt (SVG-ritning ovanpå planritningsbild).
- `data/radiatorer.csv` – radiatordatabas (78 modeller, W/sektion vid 90/70/20) från fliken Radiatordata i Peters Excel-mall.
- `build.js` – genererar `src/default-db.js` och en fristående `dist/vscalc.html`.
- `test/calc.test.js` – enhetstester.

```
node build.js && node test/calc.test.js
```
Öppna `dist/vscalc.html` direkt i webbläsaren.

## Beräkningsmodell
- Transmission: U·A·(t_inne − DVUT) för yttervägg (netto), fönster, dörr, tak (kall vind/yttertak). Golv mot temperatur under (mark/källare/kryprum). Köldbryggor som procentuellt tillägg.
- Ventilation: 1,2 · q[l/s] · Δt · (1 − återvinning), q = oms/h · V / 3,6.
- Radiator: P = P_norm · (LMTD/LMTD_norm)^n.
- Flöde: returtemperatur löses (bisektion) så att radiatorn avger rummets behov vid vald framledning; q = P/(cp·ρ·Δt).
- kv = q[m³/h] / √(Δp[bar]).
- Faktor = installerad effekt vid dim. fram/retur ÷ effektbehov.

## Version 2
- Beräkningsmetod som i Excel-mallen (Strandskatan v2): fast ΔT vatten, aritmetisk Δθ, Δθref = 60 K, flöde = P/(ΔT·4,2·1000)·3600. Kontroll "tillopp över referens". Alternativ metod: fast framledning.
- Danfoss RA-DV PURE: inställning per radiator utifrån givare och flödesmarginal (Ventildata-fliken).
- kv vid Δp (standard 10 kPa, ändringsbart per radiator).
- PDF-ritningar via pdf.js (cdnjs), skala från ritningsskala 1:N.
- Automatisk avläsning av radiatorbeteckningar (t.ex. "MR 59-20", "2xMP2 44/16") ur PDF:ens text. Kopplas till rum när rummet ritas.

## Version 4
- Beteckningsformat "sektioner-höjd-serie" (t.ex. "52-44-MP") som på äldre ritningar.
- OCR med tesseract.js (jsdelivr) för inskannade PDF:er och bilder: två pass (planbild + skarpare rendering) slås ihop. Knappen "Läs beteckningar" kör om avläsningen.
- Beteckningar utanför fasaden kopplas till närmaste rum inom 4 m (streckad linje visar kopplingen).

## Planerat
- Automatisk rumsidentifiering från planritning (bildanalys).
- Flera plan, ventilförinställning per ventilfabrikat, rörförluster/Δp per krets.
