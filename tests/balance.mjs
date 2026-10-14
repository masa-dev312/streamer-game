// 逆転のしやすさを測る: ボットだけで多数回遊ばせ、序盤の先頭がどれだけ勝つかなどを数える
// 使い方: node tests/balance.mjs [回数]
import { createGame, endPlacement, rollDice, botChooseDie, move, currentMover, botPlace, TUNE } from '../src/rules.js';

const N = Number(process.argv[2] ?? 3000);
const pct = x => `${(x * 100).toFixed(0)}%`;

export function measure(players, n = N, seedBase = 0) {
  const r = { games: 0, leaderR3Wins: 0, lastR3Wins: 0, gapR3: 0, gapEnd: 0, leadChanges: 0, close: 0,
    rounds: 0, trapOnLeader: 0, trapOnOthers: 0, leaderMoves: 0, otherMoves: 0, finalSwing: 0 };
  for (let g = 0; g < n; g++) {
    const st = createGame({ humanName: 'P', botCount: players - 1, mode: 'hide', seed: seedBase + g * 7919 + players });
    st.players[0].isBot = true; st.players[0].personality = ['bold', 'careful', 'greedy'][g % 3];
    let r3 = null, prevLeader = null, guard = 0, lastRoundLeader = null;
    while (!st.over && guard++ < 1000) {
      if (st.phase === 'place') { botPlace(st, 0); endPlacement(st); continue; }
      const mover = currentMover(st);
      const order = st.players.slice().sort((a, b) => b.pos - a.pos);
      const isLeader = order[0].pos > order[1].pos && order[0].id === mover.id;
      const roundBefore = st.round;
      rollDice(st);
      const ev = move(st, botChooseDie(st, mover.id));
      const trapped = ['trap', 'neutral', 'self'].includes(ev.effect);
      if (isLeader) { r.leaderMoves++; if (trapped) r.trapOnLeader++; } else { r.otherMoves++; if (trapped) r.trapOnOthers++; }
      if (st.round !== roundBefore || st.over) {
        const o = st.players.slice().sort((a, b) => b.pos - a.pos);
        const leader = o[0].pos > o[1].pos ? o[0].id : null;
        if (leader !== null && prevLeader !== null && leader !== prevLeader) r.leadChanges++;
        if (leader !== null) prevLeader = leader;
        if (roundBefore === 3) r3 = { leader, last: o[o.length - 1].pos < o[o.length - 2].pos ? o[o.length - 1].id : null, gap: o[0].pos - o[o.length - 1].pos };
        if (st.round === TUNE.maxRounds || st.over) lastRoundLeader ??= leader;
      }
    }
    r.games++; r.rounds += st.round;
    const o = st.players.slice().sort((a, b) => b.pos - a.pos);
    r.gapEnd += o[0].pos - o[o.length - 1].pos;
    if (o[0].pos - o[1].pos <= 3) r.close++;
    if (r3) {
      r.gapR3 += r3.gap;
      if (r3.leader === st.winner) r.leaderR3Wins++;
      if (r3.last === st.winner) r.lastR3Wins++;
    }
  }
  return {
    players, avgRounds: r.rounds / r.games, leaderR3Win: r.leaderR3Wins / r.games, lastR3Win: r.lastR3Wins / r.games,
    gapR3: r.gapR3 / r.games, gapEnd: r.gapEnd / r.games, leadChanges: r.leadChanges / r.games, close: r.close / r.games,
    trapRateLeader: r.trapOnLeader / Math.max(1, r.leaderMoves), trapRateOthers: r.trapOnOthers / Math.max(1, r.otherMoves),
  };
}

export function report(m) {
  return `${m.players}人: 3R目の先頭が勝つ ${pct(m.leaderR3Win)}(均等なら${pct(1 / m.players)}) / 3R目の最下位が勝つ ${pct(m.lastR3Win)} / ` +
    `差(先頭-最下位) 3R ${m.gapR3.toFixed(1)}→終了 ${m.gapEnd.toFixed(1)}マス / 先頭交代 ${m.leadChanges.toFixed(1)}回 / ` +
    `1・2位の差3マス以内 ${pct(m.close)} / ワナを踏む率 先頭${pct(m.trapRateLeader)} 他${pct(m.trapRateOthers)} / 平均${m.avgRounds.toFixed(1)}R`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const p of [2, 3, 4]) console.log(report(measure(p)));
}
