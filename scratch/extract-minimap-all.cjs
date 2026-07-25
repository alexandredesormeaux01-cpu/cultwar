const fs = require('fs');
const path = 'C:/Users/alexa/.cursor/projects/c-Cult-io/agent-transcripts/c4a06089-9a42-4340-8884-ddd9c464e37d/c4a06089-9a42-4340-8884-ddd9c464e37d.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
const out = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('drawMinimap') || !line.includes('StrReplace')) continue;
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (!obj.message || !obj.message.content) continue;
  for (const part of obj.message.content) {
    if (part.type !== 'tool_use' || part.name !== 'StrReplace') continue;
    const old = part.input.old_string || '';
    const neu = part.input.new_string || '';
    if (old.includes('drawMinimap') || neu.includes('drawMinimap') || old.includes('mctx.') || neu.includes('Mini-map')) {
      out.push('\n######## LINE ' + (i+1) + ' old_len=' + old.length + ' new_len=' + neu.length);
      out.push('---OLD---');
      out.push(old);
      out.push('---NEW---');
      out.push(neu);
    }
  }
}
fs.writeFileSync('C:/Cult.io/scratch/recovered-drawMinimap-all.txt', out.join('\n'), 'utf8');
console.log('entries chars', out.join('\n').length);
