// ワナしかけダンジョン: ルールとボット(画面に依存しない部分)
// 数値はすべて試作用の設計値。遊んで調整する前提。

export const TUNE = {
  goal: 40,             // ゴールのマス番号(スタートは 0)
  maxRounds: 14,        // 最大ラウンド数。超えたら一番進んでいる人が勝ち
  handSize: 3,          // 手札の枚数
  lastPlaceBonus: 1,    // 最下位の人だけ手札が増える枚数
  placePerRound: { 2: 2, 3: 2, 4: 1 }, // 1ラウンドに置ける数(人数ごと)
  placeRange: 8,        // 各コマの何マス先まで置けるか
  trapBack: 3,          // ワナを踏んだ人が戻るマス数
  trapGain: 2,          // ワナが当たったとき仕掛けた人が進むマス数
  trapGainLeader: 1,    // 踏んだ人が仕掛けた人より前にいたら追加で進むマス数
  selfTrapBack: 3,      // 自爆で戻るマス数
  neutralBack: 2,       // ダンジョンのいたずらで戻るマス数
  treasureGain: 3,      // 宝箱で進むマス数
  neutralChance: 0.35,  // 各ラウンドに「ダンジョンのいたずら」が置かれる確率
  deck: { trap: 18, treasure: 10, fake: 6 }, // 山札の内訳(見せかけは隠すモードでは入れない)
  // 逆転の仕組み(null で無効)
  heavyGap: 6,          // 重い荷物: 先頭が2位よりこのマス数以上前なら、先頭のサイコロは1個だけ(目を選べない)
  bountyDiv: 3,         // 賞金首: 先頭にワナを当てた人は「先頭と2位の差 ÷ この数(切り捨て)」マス多く進む
  bountyMax: 3,         //   賞金の上限
  trailerPlaceGap: 6,   // 最下位が先頭からこのマス数以上遅れていたら、置ける数 +1
  sumGap: 10,           // 追い上げの一手: 先頭からこのマス数以上遅れている人は、サイコロ2個の合計でも進める
};

export const MODES = {
  hide: { label: '隠す', badge: 'ワナ非表示' },
  own: { label: '自分の仕掛けを表示', badge: '自分のワナ表示中' },
  bot: { label: 'ボットの仕掛けだけ表示', badge: 'ボットのワナ表示中' },
  all: { label: '全部表示(観戦用)', badge: '全ワナ表示中' },
};

export const CARD_LABEL = { trap: 'ワナ', treasure: '宝箱', fake: '見せかけ' };

export const PERSONALITIES = [
  { key: 'bold', name: 'ガンガン', desc: '大きい目を選びがち' },
  { key: 'careful', name: 'しんちょう', desc: '伏せマスを避けがち' },
  { key: 'greedy', name: 'よくばり', desc: '伏せマスに飛びこみがち' },
];

export const NEUTRAL = -1;

// 再現できる乱数(試作の検証用)
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 表示名の安全化: 正規化、制御文字・書式文字の除去、長さ制限
export function sanitizeName(raw, fallback = 'あなた') {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s).slice(0, 10).join('');
  return chars || fallback;
}

export function createGame({ humanName, botCount, mode, seed = Date.now() }) {
  const rng = makeRng(seed);
  const colors = ['#4dabf7', '#69db7c', '#f783ac', '#e9ecef']; // 赤はワナ、黄は宝箱専用にするため使わない
  const players = [{
    id: 0, name: sanitizeName(humanName), isBot: false, personality: null,
    pos: 0, hand: [], color: colors[0],
  }];
  const pers = shuffle(PERSONALITIES.slice(), rng);
  for (let i = 0; i < botCount; i++) {
    const p = pers[i % pers.length];
    players.push({
      id: i + 1, name: `ボット:${p.name}`, isBot: true, personality: p.key,
      pos: 0, hand: [], color: colors[i + 1],
    });
  }
  for (const p of players) {
    p.stats = { bounties: 0, trapHits: 0, steals: 0, selfDestructs: 0, targeted: 0, nearMiss: 0, trapped: 0 };
  }
  const deckDef = { ...TUNE.deck };
  if (mode === 'hide') deckDef.fake = 0;
  const deck = [];
  for (const [type, n] of Object.entries(deckDef)) for (let i = 0; i < n; i++) deck.push(type);
  const state = {
    rng, mode, players,
    deckDef, deck: shuffle(deck, rng), discard: [],
    items: new Map(),       // マス番号 -> { type, owner, round, target }
    revealed: [],           // 発動して公開された仕掛け(リプレイ用)
    round: 1, phase: 'place',
    placedThisRound: new Map(),
    moveOrder: [], moveIdx: 0, dice: null,
    log: [], winner: null, over: false,
  };
  for (const p of players) refill(state, p);
  return state;
}

function draw(state) {
  if (state.deck.length === 0) {
    state.deck = shuffle(state.discard, state.rng);
    state.discard = [];
  }
  return state.deck.pop();
}

function rankOrder(state) {
  // 進んでいる順。同じ位置なら番号の小さい順
  return state.players.slice().sort((a, b) => b.pos - a.pos || a.id - b.id);
}

// 単独の先頭と、2位との差。並んでいたら null
export function soleLeader(state) {
  const o = rankOrder(state);
  return o[0].pos > o[1].pos ? { player: o[0], lead: o[0].pos - o[1].pos } : null;
}

function leaderPos(state) {
  return Math.max(...state.players.map(p => p.pos));
}

export function lastPlaceIds(state) {
  const min = Math.min(...state.players.map(p => p.pos));
  const max = Math.max(...state.players.map(p => p.pos));
  if (min === max) return [];
  return state.players.filter(p => p.pos === min).map(p => p.id);
}

function refill(state, p) {
  const size = TUNE.handSize + (lastPlaceIds(state).includes(p.id) ? TUNE.lastPlaceBonus : 0);
  while (p.hand.length < size) {
    const c = draw(state);
    if (!c) break;
    p.hand.push(c);
  }
}

export function deckCounts(state) {
  const c = { trap: 0, treasure: 0, fake: 0 };
  for (const t of state.deck) c[t]++;
  return c;
}

export function placeLimit(state, pid = null) {
  const base = TUNE.placePerRound[state.players.length] ?? 1;
  return base + (pid !== null && isTrailing(state, pid) ? 1 : 0);
}

// 最下位(単独)で、先頭から trailerPlaceGap 以上遅れているか
export function isTrailing(state, pid) {
  if (TUNE.trailerPlaceGap == null) return false;
  const ids = lastPlaceIds(state);
  return ids.length === 1 && ids[0] === pid && leaderPos(state) - state.players[pid].pos >= TUNE.trailerPlaceGap;
}

// 追い上げの一手を使えるか
export function canUseSum(state, pid) {
  return TUNE.sumGap != null && leaderPos(state) - state.players[pid].pos >= TUNE.sumGap;
}

export function placedCount(state, pid) {
  return state.placedThisRound.get(pid) ?? 0;
}

function occupied(state, sq) {
  return state.players.some(p => p.pos === sq);
}

// 置けるマスと、そのマスで狙っている相手(一番近い後ろのコマ)
export function validSquares(state, pid, type) {
  const res = new Map();
  for (const q of state.players) {
    if (type !== 'treasure' && q.id === pid) continue;
    for (let d = 1; d <= TUNE.placeRange; d++) {
      const sq = q.pos + d;
      if (sq >= TUNE.goal || sq <= 0) continue;
      if (state.items.has(sq) || occupied(state, sq)) continue;
      const prev = res.get(sq);
      if (prev === undefined || state.players[prev].pos < q.pos) res.set(sq, q.id);
    }
  }
  return res; // sq -> target id
}

export function place(state, pid, handIdx, sq) {
  if (state.phase !== 'place') return false;
  const p = state.players[pid];
  const type = p.hand[handIdx];
  if (!type) return false;
  if (placedCount(state, pid) >= placeLimit(state, pid)) return false;
  const valid = validSquares(state, pid, type);
  if (!valid.has(sq)) return false;
  const target = valid.get(sq);
  p.hand.splice(handIdx, 1);
  state.items.set(sq, { type, owner: pid, round: state.round, target });
  if (type !== 'treasure' && target !== pid) state.players[target].stats.targeted++;
  state.placedThisRound.set(pid, placedCount(state, pid) + 1);
  return true;
}

export function botPlace(state, pid) {
  const p = state.players[pid];
  const rng = state.rng;
  let guard = 0;
  while (placedCount(state, pid) < placeLimit(state, pid) && p.hand.length && guard++ < 10) {
    // 置く札を選ぶ: ワナ優先、見せかけはときどき、宝箱は自分の先に
    let idx = p.hand.indexOf('trap');
    if (p.hand.includes('fake') && rng() < 0.35) idx = p.hand.indexOf('fake');
    if (idx < 0 && p.hand.includes('treasure')) idx = p.hand.indexOf('treasure');
    if (idx < 0) idx = 0;
    const type = p.hand[idx];
    const valid = validSquares(state, pid, type);
    if (valid.size === 0) break;
    let candidates;
    if (type === 'treasure') {
      // 自分のコマの先 3〜8 マス
      candidates = [...valid.keys()].filter(sq => sq - p.pos >= 3 && sq - p.pos <= 8);
    } else {
      // 先頭の相手を狙いやすい。サイコロ2個から選ぶので 2〜6 マス先を狙う
      const others = state.players.filter(q => q.id !== pid);
      const leader = others.reduce((a, b) => (b.pos > a.pos ? b : a));
      const target = rng() < 0.6 ? leader : others[Math.floor(rng() * others.length)];
      candidates = [...valid.keys()].filter(sq => sq - target.pos >= 2 && sq - target.pos <= 6);
    }
    if (!candidates.length) candidates = [...valid.keys()];
    const sq = candidates[Math.floor(rng() * candidates.length)];
    if (!place(state, pid, idx, sq)) break;
  }
}

// 仕掛けフェーズを締め切る: ボットが置き、いたずらが置かれ、移動の順番が決まる
export function endPlacement(state) {
  if (state.phase !== 'place') return [];
  const events = [];
  for (const p of state.players) if (p.isBot) botPlace(state, p.id);
  if (state.rng() < TUNE.neutralChance) {
    const leader = rankOrder(state)[0];
    for (let tries = 0; tries < 10; tries++) {
      const sq = leader.pos + 2 + Math.floor(state.rng() * 5);
      if (sq < TUNE.goal && !state.items.has(sq) && !occupied(state, sq)) {
        state.items.set(sq, { type: 'trap', owner: NEUTRAL, round: state.round, target: leader.id });
        events.push({ kind: 'neutral-placed' });
        break;
      }
    }
  }
  // 最下位から移動する
  state.moveOrder = state.players.slice().sort((a, b) => a.pos - b.pos || a.id - b.id).map(p => p.id);
  state.moveIdx = 0;
  state.phase = 'move';
  state.dice = null;
  return events;
}

export function currentMover(state) {
  return state.phase === 'move' ? state.players[state.moveOrder[state.moveIdx]] : null;
}

export function rollDice(state) {
  const r = () => 1 + Math.floor(state.rng() * 6);
  state.dice = isHeavy(state, currentMover(state)?.id) ? [r()] : [r(), r()];
  return state.dice;
}

// 重い荷物を背負っているか(単独の先頭で、2位より heavyGap 以上前)
export function isHeavy(state, pid) {
  const sl = soleLeader(state);
  return TUNE.heavyGap != null && !!sl && sl.player.id === pid && sl.lead >= TUNE.heavyGap;
}

// 賞金首: 単独の先頭にワナを当てたときの追加の前進。先頭がいなければ 0
export function bountyValue(state) {
  const sl = soleLeader(state);
  if (TUNE.bountyDiv == null || !sl) return 0;
  return Math.min(TUNE.bountyMax, Math.floor(sl.lead / TUNE.bountyDiv));
}

// 選べる進み方(マス数)。サイコロ2個の目、追い上げの一手が使えるなら合計も
export function moveChoices(state) {
  const p = currentMover(state);
  if (!p || !state.dice) return [];
  const c = state.dice.slice();
  if (c.length === 2 && canUseSum(state, p.id)) c.push(state.dice[0] + state.dice[1]);
  return c;
}

export function destination(state, pid, die) {
  return Math.min(TUNE.goal, state.players[pid].pos + die);
}

// ボットの目の選び方。ボットは自分の仕掛けと「伏せマスがある」ことしか知らない
export function botChooseDie(state, pid) {
  const p = state.players[pid];
  const scores = moveChoices(state).map(d => {
    const dest = destination(state, pid, d);
    let s = d * (p.personality === 'bold' ? 4 : 2);
    if (dest >= TUNE.goal) s += 1000;
    const it = state.items.get(dest);
    if (it) {
      if (it.owner === pid) s += it.type === 'trap' ? -50 : it.type === 'treasure' ? 30 : 0;
      else s += p.personality === 'careful' ? -15 : p.personality === 'greedy' ? 6 : 0;
    }
    return s + state.rng() * 0.5;
  });
  return scores.indexOf(Math.max(...scores));
}

// 目を選んで進む。発動した仕掛けをイベントとして返す
export function move(state, dieIdx) {
  const p = currentMover(state);
  if (!p || !state.dice) return null;
  const die = moveChoices(state)[dieIdx];
  if (die === undefined) return null;
  const leaderBefore = soleLeader(state);
  const bountyBefore = bountyValue(state);
  const from = p.pos;
  const dest = destination(state, p.id, die);
  p.pos = dest;
  const ev = { mover: p.id, from, die, dest, round: state.round, item: null, effect: null, usedSum: dieIdx === 2 };
  // ニアミス: 隣のマスに他人(またはいたずら)のワナがあった
  for (const sq of [dest - 1, dest + 1]) {
    const it = state.items.get(sq);
    if (it && it.type === 'trap' && it.owner !== p.id) { p.stats.nearMiss++; ev.nearMiss = true; break; }
  }
  const it = state.items.get(dest);
  if (it && dest < TUNE.goal) {
    state.items.delete(dest);
    ev.item = { ...it, square: dest };
    state.revealed.push({ ...it, square: dest, revealedRound: state.round, mover: p.id });
    if (it.owner !== NEUTRAL) state.discard.push(it.type);
    if (it.type === 'trap') {
      if (it.owner === p.id) {
        p.pos = Math.max(0, p.pos - TUNE.selfTrapBack);
        p.stats.selfDestructs++;
        ev.effect = 'self';
      } else if (it.owner === NEUTRAL) {
        p.pos = Math.max(0, p.pos - TUNE.neutralBack);
        p.stats.trapped++;
        ev.effect = 'neutral';
      } else {
        const owner = state.players[it.owner];
        const victimAhead = dest > owner.pos;
        p.pos = Math.max(0, p.pos - TUNE.trapBack);
        p.stats.trapped++;
        // 賞金首: 単独の先頭に当てたら、差に応じて多く進む
        const bounty = leaderBefore?.player.id === p.id ? bountyBefore : 0;
        ev.bounty = bounty;
        if (bounty) owner.stats.bounties++;
        const gain = TUNE.trapGain + (victimAhead ? TUNE.trapGainLeader : 0) + bounty;
        owner.pos = Math.min(TUNE.goal - 1, owner.pos + gain);
        owner.stats.trapHits++;
        ev.effect = 'trap';
        ev.ownerGain = gain;
      }
    } else if (it.type === 'treasure') {
      p.pos = Math.min(TUNE.goal, p.pos + TUNE.treasureGain);
      if (it.owner !== p.id) p.stats.steals++;
      ev.effect = it.owner === p.id ? 'collect' : 'steal';
    } else {
      ev.effect = 'fake';
    }
  }
  ev.to = p.pos;
  state.log.push(ev);
  state.dice = null;
  if (p.pos >= TUNE.goal) {
    finish(state, p.id);
    return ev;
  }
  state.moveIdx++;
  if (state.moveIdx >= state.moveOrder.length) endRound(state);
  return ev;
}

function endRound(state) {
  if (state.round >= TUNE.maxRounds) {
    finish(state, null);
    return;
  }
  state.round++;
  state.phase = 'place';
  state.placedThisRound = new Map();
  for (const p of state.players) refill(state, p);
}

function finish(state, goalId) {
  state.over = true;
  state.phase = 'over';
  if (goalId !== null) {
    state.winner = goalId;
    state.endReason = 'goal';
  } else {
    const best = rankOrder(state).sort((a, b) => b.pos - a.pos || b.stats.trapHits - a.stats.trapHits);
    state.winner = best[0].id;
    state.endReason = 'rounds';
  }
}

export function ranking(state) {
  return state.players.slice().sort((a, b) => {
    if (a.id === state.winner) return -1;
    if (b.id === state.winner) return 1;
    return b.pos - a.pos || b.stats.trapHits - a.stats.trapHits;
  });
}

// 表彰: 該当者がいないものは出さない
export function awards(state) {
  const defs = [
    ['trapHits', '一番踏ませた人'],
    ['bounties', '大物食い'],
    ['steals', '横取り王'],
    ['selfDestructs', '自爆王'],
    ['targeted', '一番狙われた人'],
    ['nearMiss', 'ニアミス王'],
  ];
  const out = [];
  for (const [key, title] of defs) {
    const max = Math.max(...state.players.map(p => p.stats[key]));
    if (max <= 0) continue;
    const who = state.players.filter(p => p.stats[key] === max).map(p => p.name);
    out.push({ title, who, count: max });
  }
  return out;
}

// 配信画面にその仕掛けの中身を見せてよいか(表示モード)
export function visibleOnStream(mode, item, players) {
  if (mode === 'all') return true;
  if (mode === 'own') return item.owner === 0;
  if (mode === 'bot') return item.owner === NEUTRAL || (players[item.owner]?.isBot ?? false);
  return false;
}
