import { readFileSync, writeFileSync } from 'node:fs';

const [, , notesPath, releaseName, releaseUrl, outputPath] = process.argv;

if (!notesPath || !releaseName || !releaseUrl || !outputPath) {
  console.error(
    'Usage: create-x-release-intent.mjs <notes-file> <release-name> <release-url> <output-file>',
  );
  process.exit(1);
}

const MAX_POST_LENGTH = 280;

function stripMarkdown(value) {
  return value
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractBullets(notes) {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => stripMarkdown(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean)
    .filter((line) => !/^full changelog:/i.test(line))
    .slice(0, 3);
}

function buildPost(notes) {
  const bullets = extractBullets(notes);
  const header = `Released ${releaseName}`;
  const footer = `Changelog: ${releaseUrl}`;

  let body = bullets.map((bullet) => `• ${bullet}`).join('\n');
  let post = body ? `${header}\n\n${body}\n\n${footer}` : `${header}\n\n${footer}`;

  while (post.length > MAX_POST_LENGTH && bullets.length > 1) {
    bullets.pop();
    body = bullets.map((bullet) => `• ${bullet}`).join('\n');
    post = `${header}\n\n${body}\n\n${footer}`;
  }

  if (post.length <= MAX_POST_LENGTH) return post;

  const fixedLength = `${header}\n\n\n\n${footer}`.length;
  const availableBodyLength = Math.max(0, MAX_POST_LENGTH - fixedLength);
  const firstBullet = bullets[0]
    ? `• ${truncate(bullets[0], Math.max(0, availableBodyLength - 2))}`
    : '';
  post = firstBullet ? `${header}\n\n${firstBullet}\n\n${footer}` : `${header}\n\n${footer}`;

  return truncate(post, MAX_POST_LENGTH);
}

const notes = readFileSync(notesPath, 'utf8');
const postText = buildPost(notes);
const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(postText)}`;

writeFileSync(
  outputPath,
  [
    '## Share on X',
    '',
    `[Draft X post](${intentUrl})`,
    '',
    '<details>',
    '<summary>Draft post text</summary>',
    '',
    '```text',
    postText,
    '```',
    '',
    '</details>',
    '',
  ].join('\n'),
);
