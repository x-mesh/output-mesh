import { readFileSync } from 'node:fs';

// package.json 이 버전의 유일한 기준이다. 릴리스 도구(git-kit ship)가 여기를 올리고 태그를 단다.
// 코드에 버전을 따로 적으면 둘이 어긋난다.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const NAME = 'output-mesh';
