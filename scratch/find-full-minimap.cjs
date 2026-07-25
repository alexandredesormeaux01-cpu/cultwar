const fs = require('fs');
const path = 'C:/Users/alexa/.cursor/projects/c-Cult-io/agent-transcripts/c4a06089-9a42-4340-8884-ddd9c464e37d/c4a06089-9a42-4340-8884-ddd9c464e37d.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
// Find Read tool results or any message with full drawMinimap body including island.tiles
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('island.tiles') || !line.includes('drawMinimap')) continue;
  const obj = JSON.parse(line);
  const role = obj.role;
  const content = obj.message && obj.message.content;
  if (!content) continue;
  const texts = [];
  for (const part of (Array.isArray(content) ? content : [content])) {
    if (typeof part === 'string') texts.push(part);
    else if (part.text) texts.push(part.text);
    else if (part.type === 'tool_result' && part.content) texts.push(typeof part.content === 'string' ? part.content : JSON.stringify(part.content).slice(0,500));
  }
  if (texts.join('').includes('function drawMinimap') || line.includes('function drawMinimap')) {
    console.log('hit line', i+1, 'role', role, 'len', line.length);
  }
}
// Also search other transcripts for complete function with island.tiles AND miniGrad
const base = 'C:/Users/alexa/.cursor/projects/c-Cult-io/agent-transcripts';
function walk(d) {
  for (const ent of fs.readdirSync(d, {withFileTypes:true})) {
    const p = d + '/' + ent.name;
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.jsonl')) {
      const data = fs.readFileSync(p, 'utf8');
      if (data.includes('island.tiles') && data.includes('miniGrad') && data.includes('function drawMinimap')) {
        console.log('file', p);
      }
    }
  }
}
walk(base);
