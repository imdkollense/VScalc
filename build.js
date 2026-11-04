// Bygger src/default-db.js från data/radiatorer.csv och en fristående dist/vscalc.html.
const fs = require('fs'), path = require('path');
const r = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
fs.writeFileSync(path.join(__dirname, 'src/default-db.js'),
  '// Genererad av build.js – redigera data/radiatorer.csv\nwindow.VSCALC_DEFAULT_CSV = ' + JSON.stringify(r('data/radiatorer.csv')) + ';\n');
let html = r('src/index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + r('src/style.css') + '</style>');
for (const f of ['calc.js', 'default-db.js', 'app.js'])
  html = html.replace(`<script src="${f}"></script>`, () => '<script>\n' + r('src/' + f).replace(/<\/script/g, '<\\/script') + '</script>');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/vscalc.html'), html);
console.log('Byggt dist/vscalc.html', html.length, 'bytes');

// OCR-filer (tesseract.js) bredvid appen, så att textigenkänningen inte är beroende av CDN.
// Kräver `npm install`; publiceras som ocr/* tillsammans med vscalc.html.
const nm = p => path.join(__dirname, 'node_modules', p);
const ocrFiles = {
  'tesseract.min.js': 'tesseract.js/dist/tesseract.min.js',
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};
if (fs.existsSync(nm('tesseract.js'))) {
  fs.mkdirSync(path.join(__dirname, 'dist/ocr'), { recursive: true });
  for (const [to, from] of Object.entries(ocrFiles)) fs.copyFileSync(nm(from), path.join(__dirname, 'dist/ocr', to));
  console.log('OCR-filer kopierade till dist/ocr');
} else console.log('OBS: kör npm install för att få med OCR-filerna i dist/ocr');
