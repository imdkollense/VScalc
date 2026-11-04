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
