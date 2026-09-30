export function normalizeLinkedinUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}
