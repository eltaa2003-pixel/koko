export function normalizeStrict(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ۃ/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[یے]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ہ/g, 'ه')
    .replace(/[جغق]/g, 'ج')
    .replace(/\s+/g, ' ');
}

export function normalizeLenient(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/۳/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[یے]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ہ/g, 'ه')
    .replace(/\s+/g, ' ');
}