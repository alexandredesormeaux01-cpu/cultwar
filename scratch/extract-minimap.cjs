const fs = require('fs');
const path = 'C:/Users/alexa/.cursor/projects/c-Cult-io/agent-transcripts/c4a06089-9a42-4340-8884-ddd9c464e37d/c4a06089-9a42-4340-8884-ddd9c464e37d.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
const out = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('const mapCv') || !line.includes('drawMinimap') || !line.includes('old_string')) continue;
  const obj = JSON.parse(line);
  for (const part of obj.message.content) {
    if (part.type === 'tool_use' && part.name === 'StrReplace') {
      const old = part.input.old_string || '';
      if (old.includes('const mapCv') && old.includes('function drawMinimap')) {
        out.push('LINE ' + (i+1));
        out.push('===OLD===');
        out.push(old);
        out.push('===END OLD len=' + old.length + '===');
      }
    }
  }
}
fs.writeFileSync('C:/Cult.io/scratch/recovered-drawMinimap.txt', out.join('\n'), 'utf8');
console.log('wrote', out.length, 'lines, bytes', out.join('\n').length);
