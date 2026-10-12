// ボットだけで多数回遊ばせて、ルールが破綻しないか・偏りがないかを確かめる
// 使い方: node tests/sim.mjs [回数]
import {
  createGame, endPlacement, rollDice, botChooseDie, move, currentMover, botPlace,
  sanitizeName, TUNE,
} from '../src/rules.js';

const N = Number(process.argv[2] ?? 2000);
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; if (failures < 10) console.error('NG:', msg); } }

check(sanitizeName('  a‮b​c\u0007  ') === 'abc', '制御文字・書式文字を除去する');
check(sanitizeName('１２３') === '123', '全角英数を正規化する');
check(Array.from(sanitizeName('あ'.repeat(30))).length === 10, '10文字に切り詰める');
check(sanitizeName('') === 'あなた', '空なら既定の名前');

for (const players of [2, 3, 4]) {
  for (const mode of ['hide', 'all']) {
    const wins = new Map();
    let rounds = 0, goals = 0, trapHits = 0, steals = 0, selfD = 0;
    for (let g = 0; g < N; g++) {
      const st = createGame({ humanName: 'P', botCount: players - 1, mode, seed: g * 7919 + players });
      st.players[0].isBot = true; st.players[0].personality = 'bold'; // 全員ボットで回す
      let guard = 0;
      while (!st.over && guard++ < 1000) {
        if (st.phase === 'place') { botPlace(st, 0); endPlacement(st); }
        else { rollDice(st); move(st, botChooseDie(st, currentMover(st).id)); }
        for (const p of st.players) check(p.pos >= 0 && p.pos <= TUNE.goal, `位置が範囲外 ${p.pos}`);
        for (const [sq, it] of st.items) check(sq > 0 && sq < TUNE.goal && it.type, `仕掛けの位置が不正 ${sq}`);
        if (mode === 'hide') for (const it of st.items.values()) check(it.type !== 'fake', '隠すモードに見せかけが混ざった');
      }
      check(st.over, '終わらないゲームがあった');
      rounds += st.round;
      if (st.endReason === 'goal') goals++;
      const w = st.players[st.winner].personality;
      wins.set(w, (wins.get(w) ?? 0) + 1);
      for (const p of st.players) { trapHits += p.stats.trapHits; steals += p.stats.steals; selfD += p.stats.selfDestructs; }
    }
    console.log(`${players}人 ${mode}: 平均ラウンド ${(rounds / N).toFixed(1)} / ゴール決着 ${(100 * goals / N).toFixed(0)}% / 1試合あたり ワナ命中 ${(trapHits / N).toFixed(1)} 横取り ${(steals / N).toFixed(1)} 自爆 ${(selfD / N).toFixed(2)} / 勝利(性格別) ${[...wins].map(([k, v]) => `${k}:${(100 * v / N).toFixed(0)}%`).join(' ')}`);
  }
}
console.log(failures ? `失敗 ${failures} 件` : 'すべて成功');
process.exit(failures ? 1 : 0);
