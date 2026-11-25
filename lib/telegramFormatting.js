'use strict';
function sanitizeUtf8(s) {
  return String(s ?? '')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, m => m.length === 2 ? m : '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// Telegram supports only a small HTML subset. Preserve supported tags and escape every
// other angle-bracket expression, including placeholders with punctuation such as <HH:MM|+30m|date>.
function sanitizeTelegramHtml(s) {
  const supported = /^\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler|span)(?:\s+[^<>]*)?$/i;
  return sanitizeUtf8(String(s ?? '')).replace(/<([^<>]{1,160})>/g, (whole, inside) => {
    if (supported.test(inside)) return whole;
    return `&lt;${inside}&gt;`;
  }).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
}
module.exports = { sanitizeTelegramHtml };
