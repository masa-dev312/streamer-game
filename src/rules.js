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
  const colors = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419'];
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
    p.stats = { trapHits: 0, steals: 0, selfDestructs: 0, targeted: 0, nearMiss: 0, trapped: 0 };
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

export function placeLimit(state) {
  return TUNE.placePerRound[state.players.length] ?? 1;
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
  if (placedCount(state, pid) >= placeLimit(state)) return false;
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
  while (placedCount(state, pid) < placeLimit(state) && p.hand.length && guard++ < 10) {
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
  state.dice = [r(), r()];
  return state.dice;
}

export function destination(state, pid, die) {
  return Math.min(TUNE.goal, state.players[pid].pos + die);
}

// ボットの目の選び方。ボットは自分の仕掛けと「伏せマスがある」ことしか知らない
export function botChooseDie(state, pid) {
  const p = state.players[pid];
  const scores = state.dice.map(d => {
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
  return scores[0] >= scores[1] ? 0 : 1;
}

// 目を選んで進む。発動した仕掛けをイベントとして返す
export function move(state, dieIdx) {
  const p = currentMover(state);
  if (!p || !state.dice) return null;
  const die = state.dice[dieIdx];
  const from = p.pos;
  const dest = destination(state, p.id, die);
  p.pos = dest;
  const ev = { mover: p.id, from, die, dest, round: state.round, item: null, effect: null };
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
        const gain = TUNE.trapGain + (victimAhead ? TUNE.trapGainLeader : 0);
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
