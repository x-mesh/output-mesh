import { nfc } from './paths.mjs';

/**
 * 사용자가 정하는 숨김 규칙. 수집은 그대로 하고 보기에서만 가린다 — 규칙을 끄면 바로 돌아온다.
 * 이름이 들어갔다고 가리지 않는다: 폴더 규칙은 경로의 폴더 조각이 이름과 정확히 같을 때만 걸린다
 * (`vendor-notes.md` 나 `vendor` 라는 이름의 파일은 해당 없다).
 */
export const RULE_KIND = { FOLDER: 'folder', PATH: 'path' };

const MAX_PATTERN_CHARS = 512;
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 사람이 고쳐 쓴 값을 규칙 하나로 다듬는다. 못 쓰는 값은 예외다 — 조용히 고쳐서 다른 규칙을 만들지 않는다. */
export function normalizeRule({ kind, pattern }) {
  const text = nfc(String(pattern ?? '')).trim();
  if (text === '' || text.length > MAX_PATTERN_CHARS) throw new Error('empty or too long pattern');
  if (kind === RULE_KIND.FOLDER) {
    if (text.includes('/') || text === '.' || text === '..') throw new Error('a folder rule is one folder name without a slash');
    return { kind, pattern: text };
  }
  if (kind === RULE_KIND.PATH) {
    const path = text.replace(/\/+$/, '');
    if (!path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) throw new Error('a path rule is an absolute path');
    return { kind, pattern: path };
  }
  throw new Error('unknown rule kind');
}

/** 규칙 하나가 걸리는 파일의 SQL 조건. 경로는 DB 의 path_key 만 본다 — 파일시스템에 닿지 않는다. */
export function ruleClause({ kind, pattern }) {
  return kind === RULE_KIND.FOLDER
    ? { sql: "a.path_key LIKE ? ESCAPE '\\'", params: [`%/${escapeLike(pattern)}/%`] }
    : { sql: "a.path_key LIKE ? ESCAPE '\\'", params: [`${escapeLike(pattern)}/%`] };
}

/**
 * 규칙이 있어도 가리지 않는 파일. 사람이 손댔거나 에이전트가 산출물로 표시한 것은 폴더 이름 하나로 묻히면
 * 안 된다 — 라이브러리가 코드 종류보다 산출물 표시를 앞세우는 것과 같은 방향이다.
 */
export const PROTECTED_CLAUSE = `(a.favorite = 1 OR a.state = 'final' OR (a.note IS NOT NULL AND a.note <> '')
  OR EXISTS (SELECT 1 FROM artifact_tags x WHERE x.artifact_id = a.id)
  OR EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id AND o.is_deliverable = 1))`;

/** 켜진 규칙들 중 하나라도 걸리는 조건. 규칙이 없으면 null. */
export function matchAnyClause(rules) {
  if (rules.length === 0) return null;
  const parts = rules.map(ruleClause);
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}
