/**
 * Markdown engine for dashboard chat text.
 *
 * Raw HTML is disabled, so message contents can never inject markup: markdown-it
 * escapes anything that is not Markdown syntax before it reaches the DOM. Links
 * and images are only emitted for protocols markdown-it considers safe.
 */
const MarkdownIt = require('markdown-it');

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
});

const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
  return renderToken(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('loading', 'lazy');
  tokens[idx].attrSet('referrerpolicy', 'no-referrer');
  tokens[idx].attrSet('decoding', 'async');
  return renderToken(tokens, idx, options, env, self);
};

// GitHub-style task lists without emitting raw HTML (which html:false would have to
// trust). The checkbox is a text glyph, so the user content stays escaped.
md.core.ruler.after('inline', 'task-lists', state => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const match = /^\[([ xX])\]\s+/.exec(inline.content);
    if (!match) continue;
    inline.content = inline.content.slice(match[0].length);
    if (inline.children?.[0]?.type === 'text') {
      inline.children[0].content = inline.children[0].content.replace(/^\[[ xX]\]\s+/, '');
    }
    const box = new state.Token('text', '', 0);
    box.content = match[1].toLowerCase() === 'x' ? '☑ ' : '☐ ';
    box.level = inline.children[0]?.level || 0;
    inline.children.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-list-item');
    for (let j = i - 2; j >= 0; j--) {
      if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
        if (tokens[j].level === tokens[i - 2].level - 1) {
          if (!tokens[j].attrGet('class')) tokens[j].attrSet('class', 'contains-task-list');
          break;
        }
      }
    }
  }
});

function render(text) {
  if (text === undefined || text === null) return '';
  const source = String(text);
  if (!source.trim()) return '';
  return md.render(source);
}

// Single-line text for chat-list previews: markdown syntax is dropped instead of rendered.
function plainText(text, limit = 160) {
  if (text === undefined || text === null) return '';
  const source = String(text);
  if (!source.trim()) return '';

  const collect = token => {
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return token.children ? token.children.map(collect).join('') : '';
  };

  const parts = [];
  for (const token of md.parse(source, {})) {
    if (token.type === 'inline') parts.push(collect(token));
    else if (token.type === 'fence' || token.type === 'code_block') parts.push(token.content);
  }
  let out = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (limit && out.length > limit) out = out.slice(0, limit - 1) + '…';
  return out;
}

module.exports = { render, plainText };
