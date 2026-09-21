import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { facets, planQuery, search, searchCount } from '../lib/search.mjs';
import { decodeEntities, extractBody, kindOf, looksBinary, stripTags, BODY_STATE, KIND } from '../lib/extract.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-search-'));
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function index(name, body, meta = '') {
  const dot = name.lastIndexOf('.');
  const id = store.insertArtifact({
    pathKey: `/x/${name}`, absPath: `/x/${name}`, fileName: name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    sizeBytes: 1, contentHash: name, fileId: null, mtime: 1,
  });
  store.upsertSearchDoc(id, { name, path: `/x/${name}`, body, meta, bodyState: 'indexed' });
  return id;
}

const XLSX = '2024-01_2024-12_분기별_매출흐름.xlsx';
const RESUME = '홍길동_이력서_초안.md';

describe('V6 — 쿼리 분기', () => {
  test('3자 이상은 전문 검색 경로', () => {
    expect(planQuery('매출흐름').mode).toBe('fts');
  });
  test('2자 토큰이 하나라도 있으면 부분 일치 경로', () => {
    expect(planQuery('이력').mode).toBe('like');
    expect(planQuery('매출흐름 이력').mode).toBe('like');
  });
  test('빈 입력은 전체', () => {
    expect(planQuery('   ').mode).toBe('all');
  });
});

describe('V6 — 한글 검색', () => {
  beforeEach(() => {
    index(XLSX, '연도는 달력연도 기준입니다', '가계부 앱 데이터 연동 분석 ai-mesh');
    index(RESUME, '인프라 플랫폼 엔지니어링 경력', 'claude-code 채용공고 작성');
  });

  test('토큰 중간 일치를 trigram 이 잡는다 — unicode61 로는 0건인 케이스', () => {
    expect(search(store, '매출흐름').map((r) => r.file_name)).toEqual([XLSX]);
  });
  test('2글자 한글이 LIKE 경로로 잡힌다 — trigram 으로는 0건인 케이스', () => {
    expect(search(store, '이력').map((r) => r.file_name)).toEqual([RESUME]);
  });
  test('본문으로 찾는다', () => {
    expect(search(store, '달력연도').map((r) => r.file_name)).toEqual([XLSX]);
  });
  test('세션 제목으로 찾는다 — 파일명을 몰라도 작업 기억으로 도달한다', () => {
    expect(search(store, '가계부').map((r) => r.file_name)).toEqual([XLSX]);
  });
  test('여러 토큰은 AND 로 묶인다', () => {
    expect(search(store, '인프라 엔지니어링')).toHaveLength(1);
    expect(search(store, '인프라 가계부')).toHaveLength(0);
  });
  test('LIKE 와일드카드는 리터럴로 취급된다 — 이스케이프가 빠지면 전체가 걸린다', () => {
    index('100%_달성.md', '본문', '');
    // 두 픽스처 파일명에 _ 가 실제로 들어 있으므로 리터럴 매칭이면 그것들이 잡혀야 한다.
    expect(search(store, '%').map((r) => r.file_name)).toEqual(['100%_달성.md']);
    expect(search(store, '_').map((r) => r.file_name).sort()).toEqual([XLSX, RESUME, '100%_달성.md'].sort());
  });
  test('FTS 특수문자가 구문 오류를 내지 않는다', () => {
    expect(() => search(store, '"드롭" OR')).not.toThrow();
  });
});

describe('V6 — 필터', () => {
  test('사라진 원본은 기본 결과에서 빠지고 옵션으로만 보인다', () => {
    const id = index('gone.md', '내용', '');
    store.markMissing([id]);
    expect(search(store, '내용')).toHaveLength(0);
    expect(search(store, '내용', { includeMissing: true })).toHaveLength(1);
  });
  test('태그 필터는 NFC 로 정규화해 맞춘다', () => {
    const id = index('a.md', '본문내용', '');
    store.addTag(id, '보고서'.normalize('NFC'));
    expect(search(store, '', { tag: '보고서'.normalize('NFD') })).toHaveLength(1);
  });
});

describe('추출기', () => {
  test('확장자 분류가 추출과 미리보기를 함께 구동한다', () => {
    expect(kindOf('md')).toBe(KIND.TEXT);
    expect(kindOf('html')).toBe(KIND.MARKUP);
    expect(kindOf('svg')).toBe(KIND.MARKUP);
    expect(kindOf('xlsx')).toBe(KIND.SHEET);
    expect(kindOf('png')).toBe(KIND.IMAGE);
    expect(kindOf('docx')).toBe(KIND.OFFICE);
    expect(kindOf('plist')).toBe(KIND.CODE);
    expect(kindOf('weird-unknown-ext')).toBe(KIND.OTHER);
  });
  test('xlsx 의 XML 수치 참조를 푼다 — 안 풀면 한글 검색이 통째로 실패한다', () => {
    expect(decodeEntities('&#53685;&#54633;&#48372;&#51221;')).toBe('통합보정');
    expect(decodeEntities('&amp;&lt;&gt;&#x41;')).toBe('&<>A');
    expect(decodeEntities('&nope; &#99999999999;')).toBe('&nope; &#99999999999;');
  });
  test('script/style 안의 코드를 본문으로 색인하지 않는다', () => {
    expect(stripTags('<p>본문</p><script>var secret=1</script>')).not.toContain('secret');
  });
  test('바이너리를 판별한다', () => {
    expect(looksBinary(Buffer.from([0x00, 0x01]))).toBe(true);
    expect(looksBinary(Buffer.from('평문 텍스트', 'utf8'))).toBe(false);
  });
  test('텍스트 파일에서 본문을 뽑는다', async () => {
    const path = join(dir, 'a.md');
    writeFileSync(path, '# 제목\n\n한글 본문입니다');
    const got = await extractBody(path, 'md');
    expect(got.state).toBe(BODY_STATE.INDEXED);
    expect(got.body).toContain('한글 본문입니다');
  });
  test('없는 파일은 조용한 빈 본문이 아니라 failed 로 보고된다', async () => {
    const got = await extractBody(join(dir, 'nope.md'), 'md');
    expect(got.state).toBe(BODY_STATE.FAILED);
    expect(got.code).toBe('extract_failed');
  });
  test('이미지는 skipped 이고 이유가 남는다', async () => {
    mkdirSync(join(dir, 'i'), { recursive: true });
    writeFileSync(join(dir, 'i/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const got = await extractBody(join(dir, 'i/a.png'), 'png');
    expect(got).toMatchObject({ state: BODY_STATE.SKIPPED, code: 'no_ocr' });
  });
});

describe('V8 — 라이브러리 범위', () => {
  beforeEach(() => {
    index('note.md', '문서 본문', '');
    index('shot.png', null, '');
    index('App.swift', 'struct App {}', '');
    index('.zshrc', 'export PATH=x', '');
    const bundleId = index('gen-app', 'src/main.mjs', '');
    store.setBundleFiles(bundleId, 3);
  });

  test('라이브러리 패싯이 목록과 같은 집합을 센다 — 사이드바가 코드를 광고하던 실패', () => {
    const f = facets(store, { view: 'library' });
    expect(f.exts.map((e) => e.value)).not.toContain('swift');
    expect(f.states.reduce((sum, row) => sum + row.n, 0)).toBe(searchCount(store, '', { view: 'library' }));
  });

  test('형식을 골라도 라이브러리를 벗어나지 않는다 — 사이드바가 모드를 풀던 탈출구', () => {
    expect(search(store, '', { view: 'library', ext: 'swift' })).toHaveLength(0);
    expect(search(store, '', { ext: 'swift' })).toHaveLength(1);
  });

  test('종류를 직접 고르면 그 선택이 라이브러리 규칙을 이긴다', () => {
    expect(search(store, '', { view: 'library', kind: 'code' }).map((r) => r.file_name).sort())
      .toEqual(['.zshrc', 'App.swift']);
  });

  test('종류 패싯만 전역 건수를 유지한다 — 코드가 한 번의 클릭 거리에 남는다', () => {
    const kinds = facets(store, { view: 'library' }).kinds;
    expect(kinds.find((k) => k.value === 'code').n).toBe(2);
    expect(search(store, '', { view: 'library' }).map((r) => r.file_name)).not.toContain('App.swift');
  });

  test('kind 가 비어 있는 행도 라이브러리에 남는다 — 조용히 사라지지 않는다', () => {
    store.db.query("UPDATE artifacts SET kind = NULL WHERE file_name = 'note.md'").run();
    expect(search(store, '', { view: 'library' }).map((r) => r.file_name)).toContain('note.md');
  });

  test('번들은 코드가 아니라 폴더로 분류돼 라이브러리에 남는다', () => {
    expect(search(store, '', { view: 'library' }).map((r) => r.file_name)).toContain('gen-app');
  });

  test('다른 필터가 걸려도 그 차원의 패싯은 접히지 않는다', () => {
    const f = facets(store, { view: 'library', ext: 'md' });
    expect(f.exts.map((e) => e.value)).toEqual(expect.arrayContaining(['md', 'png']));
  });

  test('검색어가 패싯에도 걸린다 — 부분 일치와 전문 검색 두 경로 모두', () => {
    const like = facets(store, { view: 'library' }, '문서');
    expect(like.exts).toEqual([{ value: 'md', n: 1 }]);
    expect(like.states.reduce((sum, row) => sum + row.n, 0)).toBe(searchCount(store, '문서', { view: 'library' }));

    const fts = facets(store, { view: 'library' }, 'struct');
    expect(fts.states).toEqual([]);
    expect(fts.kinds).toEqual([{ value: 'code', n: 1 }]);
  });
});

describe('V9 — 라이브러리는 모르는 형식을 숨긴다', () => {
  beforeEach(() => {
    for (const name of ['report.md', 'deck.pptx', 'go.mod', 'Info.plist', 'build.gradle.kts', 'thing.zzz', '_redirects']) {
      index(name, '내용', '');
    }
  });

  test('모르는 확장자는 기본으로 숨는다 — 새 저장소가 늘 때마다 설정 파일이 새던 실패', () => {
    const names = search(store, '', { view: 'library' }).map((r) => r.file_name);
    expect(names).not.toContain('thing.zzz');
    expect(names).not.toContain('_redirects');
  });

  test('알려진 설정·빌드 파일은 기타가 아니라 코드로 분류돼 숨는다', () => {
    const names = search(store, '', { view: 'library' }).map((r) => r.file_name);
    for (const name of ['go.mod', 'Info.plist', 'build.gradle.kts']) expect(names).not.toContain(name);
    expect(search(store, '', { kind: 'code' }).map((r) => r.file_name)).toEqual(expect.arrayContaining(['go.mod', 'Info.plist']));
  });

  test('오피스 문서는 숨는 규칙에 걸리지 않는다 — 진짜 문서가 사라지는 반대 실패', () => {
    expect(search(store, '', { view: 'library' }).map((r) => r.file_name)).toEqual(expect.arrayContaining(['report.md', 'deck.pptx']));
  });

  test('기타를 직접 고르면 보인다 — 숨긴 것이지 버린 것이 아니다', () => {
    expect(search(store, '', { view: 'library', kind: 'other' }).map((r) => r.file_name).sort()).toEqual(['_redirects', 'thing.zzz']);
  });

  test('사이드바가 숨긴 종류를 서버에서 받는다 — 클라이언트에 복사하면 어긋난다', () => {
    const f = facets(store, { view: 'library' });
    expect(f.libraryHidden).toEqual(['code', 'other', 'memo']);
    expect(f.kinds.map((k) => k.value)).toEqual(expect.arrayContaining(['code', 'other', 'office']));
  });
});

describe('V10 — 검색 결과는 맞은 이유를 말한다', () => {
  const filler = '가나다라마바사 '.repeat(20);

  test('전문 검색은 이름에 맞은 파일을 본문에 스친 파일보다 위에 둔다', () => {
    index('notes.md', `${filler}마이그레이션을 한 번 언급한다`);
    index('마이그레이션-계획.md', '일정과 담당자');
    expect(search(store, '마이그레이션').map((r) => r.file_name)).toEqual(['마이그레이션-계획.md', 'notes.md']);
  });

  test('부분 일치도 같은 순서를 낸다 — bm25 가 없는 경로', () => {
    index('memo.md', '지난 이력을 정리');
    index('홍길동_이력서.md', '경력 기술');
    expect(search(store, '이력').map((r) => r.file_name)).toEqual(['홍길동_이력서.md', 'memo.md']);
  });

  test('최종본은 검색 중에도 먼저다', () => {
    const mention = index('notes.md', '마이그레이션을 한 번 언급한다');
    index('마이그레이션-계획.md', '일정과 담당자');
    store.setUserState(mention, 'final');
    expect(search(store, '마이그레이션')[0].file_name).toBe('notes.md');
  });

  test('발췌는 맞은 곳 주변이고, 잘린 쪽에 말줄임표가 붙는다', () => {
    index('notes.md', `${filler}여기서 마이그레이션을\n\n   언급한다 ${filler}`);
    const [{ excerpt }] = search(store, '마이그레이션');
    expect(excerpt).toContain('여기서 마이그레이션을 언급한다');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('발췌는 대소문자를 가리지 않고, 부분 일치 경로에서도 나온다', () => {
    index('a.md', 'See the README for setup');
    index('b.md', '지난 이력을 정리');
    expect(search(store, 'readme')[0].excerpt).toBe('See the README for setup');
    expect(search(store, '이력')[0].excerpt).toBe('지난 이력을 정리');
  });

  test('여러 낱말이면 본문에 있는 첫 낱말 주변을 보인다', () => {
    index('deploy-guide.md', '롤백 절차를 먼저 읽는다');
    expect(search(store, 'deploy 롤백 절차')[0].excerpt).toBe('롤백 절차를 먼저 읽는다');
  });

  test('이름에만 맞았거나 검색어가 없으면 발췌가 없다 — 지어내지 않는다', () => {
    index('마이그레이션-계획.md', '일정과 담당자');
    expect(search(store, '마이그레이션')[0].excerpt).toBeNull();
    expect(search(store, '')[0].excerpt).toBeNull();
  });
});

describe('V11 — 에이전트 메모는 숨기되 버리지 않는다', () => {
  function at(absPath, body) {
    const name = absPath.split('/').pop();
    const id = store.insertArtifact({ pathKey: absPath, absPath, fileName: name, ext: 'md', sizeBytes: 1, contentHash: absPath, fileId: null, mtime: 1 });
    store.upsertSearchDoc(id, { name, path: absPath, body, bodyState: 'indexed' });
    return id;
  }

  beforeEach(() => {
    at('/Users/me/.claude/projects/-Users-me-work-aic/memory/aic-local-history.md', '로컬 히스토리가 갈라진 이유');
    at('/Users/me/.claude/plans/pure-yawning-llama.md', '구현 계획');
    at('/Users/me/work/aic/docs/memory/design.md', '메모리 설계 문서');
  });

  test('Claude Code 의 프로젝트 memory 파일만 메모로 분류한다 — 이름이 memory 인 폴더가 전부 걸리지 않는다', () => {
    const kinds = Object.fromEntries(search(store, '').map((r) => [r.file_name, r.kind]));
    expect(kinds).toEqual({ 'aic-local-history.md': 'memo', 'pure-yawning-llama.md': 'text', 'design.md': 'text' });
  });

  test('라이브러리에서는 숨고, 종류로 고르거나 검색 범위를 넓히면 나온다', () => {
    expect(search(store, '', { view: 'library' }).map((r) => r.file_name)).not.toContain('aic-local-history.md');
    expect(search(store, '', { view: 'library', kind: 'memo' }).map((r) => r.file_name)).toEqual(['aic-local-history.md']);
    expect(search(store, '히스토리가').map((r) => r.file_name)).toEqual(['aic-local-history.md']);
    expect(facets(store, { view: 'library' }).libraryHidden).toContain('memo');
  });

  test('규칙 버전이 오르면 이미 들어온 행도 다시 분류된다 — 캐시라 키가 바뀌어야 한다', () => {
    store.db.exec("UPDATE artifacts SET kind = 'text'");
    store.setState('kind.rules_version', 'older');
    const path = store.db.filename;
    store.close();
    store = new CatalogStore(path);
    expect(store.db.query("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'memo'").get().n).toBe(1);
  });
});
