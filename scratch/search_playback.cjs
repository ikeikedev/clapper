const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');
const keywords = ['currentTime', 'playbackRate', 'sync', 'play', 'pause', 'seeking'];

const files = fs.readdirSync(srcDir);

files.forEach(file => {
  const filePath = path.join(srcDir, file);
  const stat = fs.statSync(filePath);
  if (stat.isFile() && (file.endsWith('.tsx') || file.endsWith('.ts'))) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      keywords.forEach(keyword => {
        if (line.includes(keyword)) {
          console.log(`${file}:${index + 1} (${keyword}): ${line.trim().substring(0, 120)}`);
        }
      });
    });
  }
});
