export const MAX_ARTICLE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export class InputError extends Error {}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new InputError(`Invalid ${name}.`);
  return value;
}
export function articleId(value: unknown): string {
  const id = text(value, 'article id', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new InputError('Invalid article id.');
  return id;
}
export function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Date.now()/1000 + 300) throw new InputError(`Invalid ${name}. Use epoch seconds.`);
  return value;
}
export function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new InputError(`Invalid ${name}.`);
  return value;
}
export function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new InputError('Use at most 20 tags.');
  return [...new Set(value.map(t => {
    const normalized = text(t, 'tag', 1000).trim().toLowerCase().replace(/\s+/g, ' ');
    return text(normalized, 'tag', 60);
  }))];
}
export function source(value: unknown): string {
  const result = text(value, 'source', 4096, true);
  if (!result) return '';
  let url: URL;
  try { url = new URL(result); } catch { throw new InputError('Invalid source URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new InputError('Invalid source URL.');
  return result;
}
export function linkHref(value: unknown): string {
  const raw = text(value, 'link URL', 4096);
  // URL parsers differ on controls and backslashes. Reject ambiguous input,
  // then store a canonical URL that both the Python and native clients accept.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new InputError('Invalid link URL.');
  const authority = raw.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (authority?.includes('@')) throw new InputError('Link URLs cannot contain credentials.');
  const canonical = new URL(source(raw)).href;
  return text(canonical, 'link URL', 4096);
}
export function marks(value: unknown, wordCount: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50000) throw new InputError('Use at most 50,000 formatting marks.');
  return value.map(value => {
    const mark = object(value);
    const start = integer(mark.start, 'mark start', wordCount - 1);
    const end = integer(mark.end, 'mark end', wordCount);
    if (end <= start || !['bold', 'italic', 'underline', 'link'].includes(mark.kind as string)) throw new InputError('Invalid formatting mark.');
    const kind = mark.kind as 'bold' | 'italic' | 'underline' | 'link';
    if (kind === 'link') return {start, end, kind, href:linkHref(mark.href)};
    if ('href' in mark) throw new InputError('Only link marks can have a URL.');
    return {start, end, kind};
  });
}
export function lifecycle(data: Record<string, unknown>) {
  if (typeof data.archived !== 'boolean' || typeof data.deleted !== 'boolean' || !('lifecycleUpdated' in data)) throw new InputError('Supply archived, deleted and lifecycleUpdated together.');
  return {archived:data.archived, deleted:data.deleted, lifecycleUpdated:timestamp(data.lifecycleUpdated,'lifecycleUpdated')};
}
export function readStatus(data: Record<string, unknown>) {
  if (typeof data.unread !== 'boolean' || !('readUpdated' in data)) throw new InputError('Supply unread (boolean) and readUpdated together.');
  return {unread:data.unread, readUpdated:timestamp(data.readUpdated, 'readUpdated')};
}
export function article(value: unknown, origin: string) {
  const data = object(value);
  if (!Array.isArray(data.words) || !data.words.length || data.words.length > 250000) throw new InputError('An article needs 1 to 250,000 words.');
  const words = data.words.map(w => text(w, 'word', 10000));
  if (!Array.isArray(data.paragraphs) || !data.paragraphs.length || data.paragraphs.length > 250000) throw new InputError('Invalid paragraphs.');
  let previousEnd = 0;
  const paragraphs = data.paragraphs.map(p => {
    const item = object(p);
    const start = integer(item.start, 'paragraph start', words.length - 1);
    const end = integer(item.end, 'paragraph end', words.length);
    if (end <= start || start !== previousEnd || !['heading','paragraph','blockquote'].includes(item.kind as string)) throw new InputError('Invalid paragraph range.');
    previousEnd = end;
    return {start, end, kind: item.kind as 'heading' | 'paragraph' | 'blockquote'};
  });
  if (previousEnd !== words.length) throw new InputError('Paragraphs must cover the article words.');
  if (!Array.isArray(data.images ?? []) || ((data.images ?? []) as unknown[]).length > 20) throw new InputError('Use at most 20 images.');
  const images = ((data.images ?? []) as unknown[]).map(image => {
    const item = object(image);
    const src = text(item.src, 'image URL', 4096);
    let url: URL;
    try { url = new URL(src, origin); } catch { throw new InputError('Invalid image URL.'); }
    if (url.origin !== origin || url.pathname !== '/images' || !url.searchParams.get('id') || url.username || url.password) throw new InputError('Images must be uploaded to this library first.');
    const ids = url.searchParams.getAll('id');
    if (ids.length !== 1 || ids[0].length > 256 || [...url.searchParams.keys()].some(key => key !== 'id')) throw new InputError('Invalid image URL parameters.');
    return {src: '/images?id=' + encodeURIComponent(ids[0]), alt: text(item.alt ?? '', 'image description', 2000, true),
      caption: text(item.caption ?? '', 'image caption', 4000, true), position: integer(item.position ?? 0, 'image position', words.length)};
  });
  return {
    id: articleId(data.id), title: text(data.title, 'title', 300).trim(), source: source(data.source ?? ''),
    words, paragraphs, images, marks:marks(data.marks, words.length), tags: tags(data.tags), position: integer(data.position, 'position', words.length - 1),
    updated: timestamp(data.updated, 'updated'), metadataUpdated: timestamp(data.metadataUpdated, 'metadataUpdated'),
    contentUpdated: timestamp(data.contentUpdated, 'contentUpdated'),
    ...(('unread' in data || 'readUpdated' in data) ? readStatus(data) : {}),
    ...(('archived' in data || 'deleted' in data || 'lifecycleUpdated' in data) ? lifecycle(data) : {}),
  };
}
export type Article = ReturnType<typeof article>;

export function rasterMime(bytes: Uint8Array): string {
  const prefix = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (prefix(137,80,78,71,13,10,26,10)) return 'image/png';
  if (prefix(255,216,255)) return 'image/jpeg';
  if (prefix(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5] === 97) return 'image/gif';
  if (prefix(82,73,70,70) && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  throw new InputError('Upload a PNG, JPEG, GIF, or WebP image.');
}
