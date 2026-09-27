(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardFormat = api;
})(globalThis, function () {
'use strict';
function parseYamlList(text) {
  const cleanText = (text || '').replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/);
  const items = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (line.startsWith('- ')) {
      if (current && current.word && current.mean) items.push(current);
      current = {};
      const afterDash = line.slice(2).trim();
      const dashMatch = afterDash.match(/^(\w+):\s*(.*)$/);
      if (dashMatch && dashMatch[1] === 'word') {
        current.word = dashMatch[2];
      }
    } else if (current) {
      const match = line.trim().match(/^(\w+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        if (key === 'word') current.word = value;
        else if (key === 'mean') current.mean = value;
        else if (key === 'example') current.example = value;
        else if (key === 'spell') current.spell = value;
        else if (key === 'created') current.created = value;
      }
    }
  }

  if (current && current.word && current.mean) items.push(current);
  return items;
}

function buildYamlFromCards(cards) {
  const blocks = cards.map((card) => {
    const block = [`- word: ${card.word}`, `  mean: ${card.mean}`];
    if (card.example) block.push(`  example: ${card.example}`);
    if (card.spell) block.push(`  spell: ${card.spell}`);
    if (card.created) block.push(`  created: ${card.created}`);
    return block.join('\n');
  });
  return blocks.join('\n') + (blocks.length ? '\n' : '');
}

function parseTexts(raw) {
    raw = (raw || '').replace(/^\uFEFF/, '');
    const out = {};
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const m = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        let value = m[2] || '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
          value = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
        }
        out[key] = value;
      }
    });
    return out;
}


function unknownFileFor(source = 'cards.yaml') {
  const parts = source.replace(/\\/g, '/').split('/');
  const base = parts.pop().replace(/\.ya?ml$/i, '');
  parts.push((base.endsWith('_unknown') ? base : base + '_unknown') + '.yaml');
  return parts.join('/');
}
return { parseYamlList, buildYamlFromCards, parseTexts, unknownFileFor };
});
