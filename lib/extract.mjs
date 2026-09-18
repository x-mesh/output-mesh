import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { BINARY_SNIFF_BYTES, EXTRACT_TIMEOUT_MS, MAX_ARTIFACT_BYTES, MAX_INDEXED_BODY_BYTES, TITLE_MAX_CHARS } from './paths.mjs';

export const KIND = {
  TEXT: 'text',
  CODE: 'code',
  MARKUP: 'markup',
  PDF: 'pdf',
  SHEET: 'sheet',
  OFFICE: 'office',
  IMAGE: 'image',
  OTHER: 'other',
};

export const BODY_STATE = { INDEXED: 'indexed', SKIPPED: 'skipped', FAILED: 'failed', PENDING: 'pending' };

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'log', 'rtf']);
// 추출·미리보기는 TEXT 와 같다. 자동 발견된 소스가 수백 개라 목록에서만 갈라 본다.
const CODE_EXT = new Set([
  'json', 'jsonl', 'yml', 'yaml', 'toml', 'xml', 'env', 'proto', 'sql',
  'mjs', 'cjs', 'js', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'swift', 'java', 'kt', 'c', 'h', 'cpp', 'zig', 'tpl',
  'tape', 'pbxproj', 'example', 'lock', 'cfg', 'ini', 'conf', 'gradle', 'properties',
  // Codex 가 여러 저장소로 뻗으며 들어온 설정·빌드 파일들.
  'kts', 'diff', 'patch', 'plist', 'xcstrings', 'mod', 'sum', 'service', 'timer',
  'pro', 'astro', 'vue', 'svelte', 'prompt', 'dockerfile', 'cmake', 'mk', 'nix',
]);

// 텍스트로 뽑을 수는 없지만 사람이 쓰는 문서다. 모르는 형식을 숨기는 규칙에 걸려
// 진짜 문서가 사라지지 않도록 명시적으로 보이는 종류로 둔다.
const OFFICE_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'key', 'pages', 'numbers', 'odt', 'odp', 'ods', 'rtf', 'hwp', 'hwpx']);

// 확장자가 없는 설정·스크립트. 이것들이 문서 목록에 섞이면 산출물이 묻힌다.
const CODE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'Justfile', 'Rakefile', 'Gemfile', 'Procfile', 'Brewfile', 'Vagrantfile',
]);
const MARKUP_EXT = new Set(['html', 'htm', 'svg']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'tiff', 'bmp', 'ico', 'avif']);
const SHEET_EXT = new Set(['xlsx']);

/**
 * kindOf 를 고치면 이 값을 올린다. artifacts.kind 는 읽을 때가 아니라 쓸 때 굳는 캐시라,
 * 키가 바뀌어야 기존 행이 다시 매겨진다. 잊으면 분류 수정이 아무 효과도 내지 않는다.
 */
export const KIND_RULES_VERSION = 2;

/** 하나의 분류가 추출과 미리보기 라우팅을 함께 구동한다. 확장자 목록이 두 군데 있으면 안 된다. */
export function kindOf(ext, fileName = '') {
  // 점으로 시작하는 파일은 설정이다. 확장자가 없어 TEXT 로 새는 걸 막는다.
  if (fileName.startsWith('.') || CODE_FILENAMES.has(fileName)) return KIND.CODE;
  if (ext === '' && fileName !== '') return KIND.OTHER;
  if (TEXT_EXT.has(ext)) return KIND.TEXT;
  if (CODE_EXT.has(ext)) return KIND.CODE;
  if (MARKUP_EXT.has(ext)) return KIND.MARKUP;
  if (IMAGE_EXT.has(ext)) return KIND.IMAGE;
  if (SHEET_EXT.has(ext)) return KIND.SHEET;
  if (OFFICE_EXT.has(ext)) return KIND.OFFICE;
  if (ext === 'pdf') return KIND.PDF;
  return KIND.OTHER;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** xlsx 는 비ASCII 를 XML 수치 참조로 이스케이프한다. 풀지 않으면 한글 검색이 통째로 실패한다. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function stripTags(text) {
  return decodeEntities(
    text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function readHead(absPath, bytes) {
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function looksBinary(buffer) {
  if (buffer.includes(0)) return true;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return decoded.includes('�');
}

async function runCapped(cmd, cap) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of proc.stdout) {
      chunks.push(chunk);
      total += chunk.length;
      // 압축 폭탄 방지: 2.5MB xlsx 안에 25MB 시트가 실재한다. 상한에 닿으면 즉시 끊는다.
      if (total >= cap) {
        proc.kill();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
}

const SHEET_ENTRY_PATTERN = /^(xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|docProps\/core\.xml)$/;

async function listZipEntries(absPath) {
  const listing = await runCapped(['/usr/bin/unzip', '-Z1', absPath], MAX_INDEXED_BODY_BYTES);
  return listing.split('\n').map((s) => s.trim()).filter((s) => SHEET_ENTRY_PATTERN.test(s));
}

async function extractSheet(absPath) {
  const entries = await listZipEntries(absPath);
  if (entries.length === 0) return { body: null, state: BODY_STATE.FAILED, code: 'xlsx_no_text_parts' };
  const ordered = entries.sort((a, b) => Number(b.includes('sharedStrings')) - Number(a.includes('sharedStrings')));

  const pieces = [];
  let budget = MAX_INDEXED_BODY_BYTES;
  for (const entry of ordered) {
    if (budget <= 0) break;
    const xml = await runCapped(['/usr/bin/unzip', '-p', absPath, entry], budget);
    const texts = xml.match(/<t[^>]*>[^<]*<\/t>/g) ?? [];
    const decoded = texts.map((t) => decodeEntities(t.replace(/<[^>]+>/g, ''))).join(' ');
    if (decoded) {
      pieces.push(decoded);
      budget -= decoded.length;
    }
  }
  const body = normalizeWhitespace(pieces.join(' '));
  return body ? { body, state: BODY_STATE.INDEXED } : { body: null, state: BODY_STATE.SKIPPED, code: 'xlsx_no_strings' };
}

const MARKDOWN_EXT = new Set(['md', 'markdown']);
const TITLED_MARKUP_EXT = new Set(['html', 'htm', 'svg']);

/**
 * 문서가 스스로 밝힌 제목. 이름이 겹치는 파일(SKILL.md 19개, README.md 15개)을 목록에서
 * 구분하는 첫 번째 재료다. 프런트매터가 있으면 `name — description` 을 합친다 —
 * SKILL.md 들은 이름은 같아도 이 조합이 다르다.
 */
export function docTitleFrom(raw, ext) {
  if (!raw) return null;
  if (MARKDOWN_EXT.has(ext)) return markdownTitle(raw);
  if (TITLED_MARKUP_EXT.has(ext)) return markupTitle(raw);
  return null;
}

function markdownTitle(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  // 닫히지 않은 프런트매터는 프런트매터로 보지 않는다. 문서 전체를 삼키지 않게.
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (front) {
    const name = frontmatterValue(front[1], 'name') ?? frontmatterValue(front[1], 'title');
    const description = frontmatterValue(front[1], 'description');
    const joined = name && description ? `${name} — ${description}` : name ?? description;
    if (joined) return cleanTitle(joined);
  }
  // 코드 블록 안의 `# install` 같은 셸 주석이 첫 제목으로 잡히지 않게 걷어낸다.
  const prose = (front ? text.slice(front[0].length) : text).replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  // 가운데 정렬 로고를 단 README 는 제목을 `<h1 align="center">` 로 쓴다. 이걸 놓치면 한참 아래의
  // `## Features` 가 제목이 된다. 둘 중 먼저 나오는 쪽이 문서의 제목이다.
  const top = [prose.match(/^#[ \t]+(.+?)[ \t#]*$/m), prose.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)]
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)[0];
  const heading = top ?? prose.match(/^##[ \t]+(.+?)[ \t#]*$/m);
  return heading ? cleanTitle(heading[1]) : null;
}

/**
 * 프런트매터 한 키의 값. `description: >` 같은 블록 스칼라는 뒤따르는 들여쓴 줄을 잇는다 —
 * 안 그러면 제목이 `>` 한 글자가 된다. YAML 전체를 해석하지 않는다: 제목 한 줄이면 된다.
 */
function frontmatterValue(block, key) {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return null;
  let value = lines[at].slice(key.length + 1).trim();
  if (/^[>|][+-]?$/.test(value) || value === '') {
    const continued = [];
    for (let i = at + 1; i < lines.length && /^[ \t]+\S/.test(lines[i]); i++) continued.push(lines[i].trim());
    value = continued.join(' ');
  }
  value = value.replace(/^(["'])(.*)\1$/, '$2').trim();
  return value || null;
}

function markupTitle(raw) {
  const found = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return found ? cleanTitle(found[1].replace(/<[^>]+>/g, ' ')) : null;
}

/** 표시용으로 마크다운 장식과 엔티티를 벗기고 길이를 자른다. */
export function cleanTitle(text) {
  const plain = decodeEntities(
    String(text)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/<[^>]+>/g, ' '),
  );
  const title = normalizeWhitespace(plain);
  if (!title) return null;
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
}

/**
 * 추출 규칙을 고치면 올린다. search_docs 는 파일에서 파생된 캐시라 키가 바뀌어야 기존 행이
 * 다시 뽑힌다. 분류(KIND_RULES_VERSION)·세션 로그 파서와 같은 함정이다.
 */
export const EXTRACT_RULES_VERSION = 2;

/**
 * 색인용 본문을 뽑는다. 추출 불가는 SKIPPED, 시도했는데 실패한 것은 FAILED 로 구분한다 —
 * 실패가 조용히 빈 본문으로 둔갑하면 "검색이 안 되는 이유"를 영영 알 수 없다.
 */
export async function extractBody(absPath, ext, fileName = '') {
  const kind = kindOf(ext, fileName);
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_ARTIFACT_BYTES) return { kind, body: null, state: BODY_STATE.SKIPPED, code: 'too_large' };

    if (kind === KIND.TEXT || kind === KIND.CODE || kind === KIND.MARKUP) {
      if (looksBinary(readHead(absPath, BINARY_SNIFF_BYTES))) {
        return { kind, body: null, state: BODY_STATE.SKIPPED, code: 'binary' };
      }
      const raw = readHead(absPath, MAX_INDEXED_BODY_BYTES).toString('utf8');
      const body = normalizeWhitespace(kind === KIND.MARKUP ? stripTags(raw) : raw);
      const title = docTitleFrom(raw, ext);
      return { kind, body: body || null, title, state: body ? BODY_STATE.INDEXED : BODY_STATE.SKIPPED };
    }

    if (kind === KIND.SHEET) return { kind, ...(await extractSheet(absPath)) };

    // PDF 본문 추출에는 vendor 라이브러리가 필요하다. 미리보기는 브라우저가 처리한다.
    if (kind === KIND.PDF) return { kind, body: null, state: BODY_STATE.SKIPPED, code: 'pdf_text_unsupported' };
    if (kind === KIND.IMAGE) return { kind, body: null, state: BODY_STATE.SKIPPED, code: 'no_ocr' };
    return { kind, body: null, state: BODY_STATE.SKIPPED, code: 'unsupported_type' };
  } catch (error) {
    return { kind, body: null, state: BODY_STATE.FAILED, code: 'extract_failed', message: String(error.message ?? error) };
  }
}
