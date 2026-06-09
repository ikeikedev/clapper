const fs = require('fs');
const path = require('path');

const appFile = 'C:/Users/dx009/.gemini/antigravity/scratch/multicam-sync-editor/src/App.tsx';
const content = fs.readFileSync(appFile, 'utf-8');
const lines = content.split('\n');

lines.forEach((line, index) => {
  if (line.includes('requestAnimationFrame') || line.includes('setInterval') || line.includes('timeupdate') || line.includes('performance.now')) {
    console.log(`L${index + 1}: ${line.trim()}`);
  }
});
