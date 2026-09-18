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
    expect(f.libraryHidden).toEqual(['code', 'other']);
    expect(f.kinds.map((k) => k.value)).toEqual(expect.arrayContaining(['code', 'other', 'office']));
  });
});
