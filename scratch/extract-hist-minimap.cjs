const fs = require('fs');
const dir = 'C:/Users/alexa/AppData/Roaming/Cursor/User/History/-2c672a7';
for (const f of ['0QB6.js','FCwv.js','zdYp.js','8lUA.js']) {
  const t = fs.readFileSync(dir + '/' + f, 'utf8');
  const idx = t.indexOf('function drawMinimap');
  const mapCv = t.indexOf('const mapCv');
  const gray = t.indexOf('GRAY_CSS');
  console.log('\n====', f, 'len', t.length, 'drawMinimap@', idx, 'mapCv@', mapCv, 'GRAY@', gray);
  if (idx < 0) {
    // stub?
    const stub = t.match(/function drawMinimap\(\)[^\n]*/);
    console.log('stub', stub && stub[0]);
    continue;
  }
  // extract from mapCv or section header to end of function
  let start = t.lastIndexOf('/* ============================== Mini-map', idx);
  if (start < 0) start = mapCv >= 0 ? mapCv : idx;
  // find matching closing brace of drawMinimap
  let i = idx;
  while (t[i] !== '{') i++;
  let depth = 0;
  let end = i;
  for (; end < t.length; end++) {
    if (t[end] === '{') depth++;
    else if (t[end] === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  const body = t.slice(start, end);
  fs.writeFileSync('C:/Cult.io/scratch/hist-' + f + '-drawMinimap.js', body, 'utf8');
  console.log('extracted', body.length, 'chars, lines', body.split(/\n/).length);
  console.log(body.slice(0, 200).replace(/\n/g,'\\n'));
  console.log('...tail...');
  console.log(body.slice(-150).replace(/\n/g,'\\n'));
}
