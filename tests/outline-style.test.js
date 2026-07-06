const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('desired rail-card navigation style is available to both outline root ids', () => {
  assert.match(css, /:is\(#tm-chatgpt-outline-root,\s*#tm-chatgpt-outline-root-v4\)/);
  assert.match(css, /:is\(#tm-chatgpt-outline-root,\s*#tm-chatgpt-outline-root-v4\) \.tm-outline-panel-inner/);
  assert.match(css, /:is\(#tm-chatgpt-outline-root,\s*#tm-chatgpt-outline-root-v4\) \.tm-outline-rail/);
  assert.match(css, /:is\(#tm-chatgpt-outline-root,\s*#tm-chatgpt-outline-root-v4\) \.tm-outline-tick\.active/);
});

test('legacy root is hidden only when the preferred root exists', () => {
  assert.doesNotMatch(css, /(^|\n)\s*#tm-chatgpt-outline-root-v4\s*\{\s*display:\s*none !important;\s*\}/);
  assert.match(
    css,
    /body:has\(#tm-chatgpt-outline-root\[data-tm-outline-layout="rail-card-v4"\]\) #tm-chatgpt-outline-root-v4/
  );
});
