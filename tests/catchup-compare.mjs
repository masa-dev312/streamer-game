// 逆転の仕組みを1つずつ入れたとき・全部入れたときを比べる
// 使い方: node tests/catchup-compare.mjs [回数]
import { TUNE } from '../src/rules.js';
import { measure, report } from './balance.mjs';

const N = Number(process.argv[2] ?? 2000);
const KEYS = ['heavyGap', 'bountyDiv', 'trailerPlaceGap', 'sumGap'];
const DEF = Object.fromEntries(KEYS.map(k => [k, TUNE[k]]));
const off = Object.fromEntries(KEYS.map(k => [k, null]));
const configs = [
  ['逆転の仕組みなし(PR #4 時点)', off],
  ['重い荷物だけ', { ...off, heavyGap: DEF.heavyGap }],
  ['賞金首だけ', { ...off, bountyDiv: DEF.bountyDiv }],
  ['最下位の置ける数+1だけ', { ...off, trailerPlaceGap: DEF.trailerPlaceGap }],
  ['追い上げの一手だけ', { ...off, sumGap: DEF.sumGap }],
  ['全部入り(採用案)', DEF],
  ...(process.argv[3] ? JSON.parse(process.argv[3]) : []),
];
for (const [name, cfg] of configs) {
  Object.assign(TUNE, DEF, cfg);
  console.log(`## ${name} ${JSON.stringify(cfg)}`);
  for (const p of [2, 3, 4]) console.log(report(measure(p, N, 100000)));
}
Object.assign(TUNE, DEF);
