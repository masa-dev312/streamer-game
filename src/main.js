// ワナしかけダンジョン: 画面と進行(試作・ボット対戦)
import {
  TUNE, MODES, CARD_LABEL, NEUTRAL, createGame, validSquares, place, placeLimit, placedCount,
  endPlacement, currentMover, rollDice, destination, botChooseDie, move, deckCounts,
  ranking, awards, visibleOnStream,
} from './rules.js';

const MODE_DESC = {
  hide: '配信画面には公開済みの情報だけ。参加者どうしの読み合いと、踏んだ瞬間の驚きを楽しむ(コラボ向け)',
  own: '自分が置いた仕掛けを配信画面に表示。視聴者と「そこ踏め!」の共犯になれる(相手が配信を見ないとき向け)',
  bot: 'ボットが置いた仕掛けだけ表示。ソロ配信でも「視聴者だけが答えを知っている」状態を作れる',
  all: '全員の仕掛けを表示。参加しない実況役が映す観戦用。参加者が見ると全部ばれる',
};

// 配色(デザインの見直しで決めた値。赤はワナ、黄は宝箱だけに使う)
const C = {
  bg: '#0b0907', stone: '#2a2420', stoneHi: '#4a3f35', stoneLo: '#15110e', stage: '#16110d',
  text: '#f3e9d2', sub: '#b8a98c', dim: '#8a7a62',
  trap: '#e03131', trapLo: '#7a1414', gold: '#fcc419', goldLo: '#a8690a', chest: '#c27c0e',
  mischief: '#9775fa', wood: '#6b4f2a', woodLo: '#3d2b14', torch: '255,179,71', hilite: '#fff4c2',
};
const FONT = '"Hiragino Sans","Noto Sans JP","WenQuanYi Zen Hei",system-ui,sans-serif';

const $ = id => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phoneQuery = matchMedia('(max-width: 820px) and (orientation: portrait)');

let st = null;
const ui = {
  selected: null,       // 手札の何枚目を選んでいるか
  valid: null,          // 置けるマス -> 狙う相手
  dice: null,           // [{ die, dest }]
  chosen: null,         // 選んだサイコロ
  pulse: null,          // 「来る来る」中のマス
  stageMsg: null,       // 舞台の中央に出す一行
  event: null,          // 大きな告知 { word, lines, color, tier, t0, until }
  vpos: [],             // 画面上のコマの位置(ルール上の位置とは別に動かす)
  anim: new Map(),      // pid -> { a, b, t0, dur }
  particles: [],
  shake: null,
  botsDone: false,
};

// ---------- 音(WebAudio の短い音だけ。素材は使わない) ----------
let audio = null;
function tone(freq, dur = 0.12, type = 'square', vol = 0.05, delay = 0) {
  if ($('mute').checked) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime + delay;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  } catch { /* 音が出せない環境では無視 */ }
}
const sfx = {
  place: () => tone(660, 0.08),
  step: () => tone(880, 0.03, 'triangle', 0.025),
  dice: () => { tone(400, 0.05); tone(500, 0.05, 'square', 0.05, 0.06); },
  kuru: () => { for (let i = 0; i < 6; i++) tone(300 + i * 60, 0.09, 'triangle', 0.05, i * 0.13); },
  trap: () => { tone(220, 0.25, 'sawtooth', 0.07); tone(150, 0.3, 'sawtooth', 0.07, 0.15); },
  self: () => { tone(500, 0.1, 'sawtooth'); tone(250, 0.1, 'sawtooth', 0.05, 0.1); tone(120, 0.4, 'sawtooth', 0.07, 0.2); },
  treasure: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, i * 0.08)); },
  fake: () => { tone(440, 0.1, 'sine'); tone(330, 0.2, 'sine', 0.05, 0.12); },
  goal: () => { [523, 659, 784, 659, 784, 1046].forEach((f, i) => tone(f, 0.15, 'triangle', 0.07, i * 0.12)); },
  final: () => { [392, 392, 523].forEach((f, i) => tone(f, 0.18, 'square', 0.06, i * 0.2)); },
};

// 時間: 早送りでは短くする。進行は setTimeout で待つので、タブが裏に回っても止まらない
const spd = ms => ($('fast').checked ? ms * 0.25 : ms);
const sleepRaw = ms => new Promise(r => setTimeout(r, ms));
const sleep = ms => sleepRaw(spd(ms));

// ---------- 盤面の配置: ダンジョンの外周を一周する。内側は「舞台」 ----------
const LAYOUTS = {
  land: { W: 960, H: 540, cols: 15, rows: 8, CW: 62, CH: 64 },
  port: { W: 540, H: 960, cols: 8, rows: 15, CW: 64, CH: 62 },
};
let L = null;
function makeLayout(key) {
  const b = LAYOUTS[key];
  const OX = (b.W - b.cols * b.CW) / 2, OY = (b.H - b.rows * b.CH) / 2;
  const cells = [];
  for (let c = 0; c < b.cols; c++) cells.push([c, 0]);
  for (let r = 1; r < b.rows; r++) cells.push([b.cols - 1, r]);
  for (let c = b.cols - 2; c >= 0; c--) cells.push([c, b.rows - 1]);
  for (let r = b.rows - 2; r >= 1; r--) cells.push([0, r]);
  // マスは 0〜goal の 41 個。外周は 42 個なので、ゴールとスタートの間の 1 個は封印の扉にする
  const pad = 8;
  const stage = { x: OX + b.CW + pad, y: OY + b.CH + pad, w: (b.cols - 2) * b.CW - pad * 2, h: (b.rows - 2) * b.CH - pad * 2 };
  // 縦向きでは舞台の上側だけを描き、下側には操作パネルを重ねる
  const panel = key === 'port' ? { x: stage.x, y: stage.y + 340, w: stage.w, h: stage.h - 340 } : null;
  const show = key === 'port' ? { ...stage, h: 330 } : stage;
  return { key, ...b, OX, OY, cells, stage, show, panel };
}
function cellXY(sq) {
  const [c, r] = L.cells[sq];
  return { x: L.OX + c * L.CW, y: L.OY + r * L.CH };
}
function cellCenter(sq) {
  const { x, y } = cellXY(sq);
  return { x: x + L.CW / 2, y: y + L.CH / 2 };
}
function squareAt(px, py) {
  for (let sq = 0; sq <= TUNE.goal; sq++) {
    const { x, y } = cellXY(sq);
    if (px >= x && px < x + L.CW && py >= y && py < y + L.CH) return sq;
  }
  return null;
}

function applyLayout() {
  const key = phoneQuery.matches ? 'port' : 'land';
  if (!L || L.key !== key) L = makeLayout(key);
  const hand = $('hand');
  if (L.panel) {
    if (hand.parentElement !== canvas.parentElement) canvas.parentElement.append(hand);
    hand.classList.add('inboard');
    Object.assign(hand.style, {
      left: `${(L.panel.x / L.W) * 100}%`, top: `${(L.panel.y / L.H) * 100}%`,
      width: `${(L.panel.w / L.W) * 100}%`, height: `${(L.panel.h / L.H) * 100}%`,
    });
  } else {
    if (hand.parentElement === canvas.parentElement) document.querySelector('.layout').append(hand);
    hand.classList.remove('inboard');
    hand.removeAttribute('style');
  }
  // 画面の解像度に合わせて描く(高解像度の画面で文字がにじまないように)
  const cssW = canvas.clientWidth || L.W;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(cssW * dpr), h = Math.round((cssW * dpr * L.H) / L.W);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------- 描画の部品 ----------
function label(text, x, y, color, size = 14, align = 'center', weight = 'normal', shadow = null) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (shadow) { ctx.fillStyle = shadow; ctx.fillText(text, x + 2, y + 3); }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
function fit(text, maxW, size, weight = 'bold') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  let t = text;
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
  return t === text ? t : `${t.slice(0, -1)}…`;
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function star(cx, cy, ro, ri, n = 4) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro, a = (Math.PI / n) * i - Math.PI / 2;
    ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
}
const initial = p => Array.from(p.name.replace('ボット:', ''))[0] ?? '?';

function drawTrap(cx, cy, s, color, lo) {
  star(cx + 2, cy + 3, 21 * s, 8 * s, 4); ctx.fillStyle = lo; ctx.fill();
  star(cx, cy, 21 * s, 8 * s, 4); ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#1a0606'; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  ctx.beginPath(); ctx.arc(cx - 3 * s, cy - 4 * s, 3 * s, 0, Math.PI * 2); ctx.fill();
}
function drawChest(cx, cy, s) {
  const w = 34 * s, h = 24 * s, x = cx - w / 2, y = cy - h / 2 + 3 * s;
  ctx.fillStyle = C.goldLo; roundRect(x + 2, y + 3, w, h, 4); ctx.fill();
  ctx.fillStyle = C.chest; roundRect(x, y, w, h, 4); ctx.fill();
  ctx.fillStyle = C.gold; roundRect(x, y - 6 * s, w, 12 * s, [8 * s, 8 * s, 2, 2]); ctx.fill();
  ctx.fillStyle = C.woodLo; ctx.fillRect(x, y + 5 * s, w, 3 * s);
  ctx.fillStyle = C.hilite; ctx.fillRect(cx - 3 * s, y + 3 * s, 6 * s, 8 * s);
  ctx.lineWidth = 2; ctx.strokeStyle = '#2a1a06'; roundRect(x, y - 6 * s, w, h + 6 * s, 4); ctx.stroke();
}
function drawFake(cx, cy, s) {
  ctx.setLineDash([4, 3]); ctx.lineWidth = 2.5; ctx.strokeStyle = C.mischief;
  star(cx, cy, 21 * s, 8 * s, 4); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.25; ctx.fillStyle = C.mischief; ctx.fill(); ctx.globalAlpha = 1;
}
function drawHidden(cx, cy, glow) {
  const s = 34, x = cx - s / 2, y = cy - s / 2;
  if (glow) {
    ctx.fillStyle = `rgba(255,244,194,${0.25 + 0.25 * glow})`;
    roundRect(x - 6, y - 6, s + 12, s + 12, 8); ctx.fill();
  }
  ctx.fillStyle = C.woodLo; roundRect(x + 2, y + 3, s, s, 5); ctx.fill();
  ctx.fillStyle = C.wood; roundRect(x, y, s, s, 5); ctx.fill();
  ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 1;
  for (const k of [11, 22]) { ctx.beginPath(); ctx.moveTo(x + 3, y + k); ctx.lineTo(x + s - 3, y + k); ctx.stroke(); }
  label('?', cx, cy + 1, C.text, 24, 'center', 'bold', C.woodLo);
}

function drawItem(it, cx, cy, reveal) {
  // 配信画面では見せかけはワナと同じ見た目(終了後の全公開でだけ正体を出す)
  const looks = it.type === 'fake' && !reveal ? 'trap' : it.type;
  if (looks === 'trap') {
    if (it.owner === NEUTRAL) drawTrap(cx, cy, 1, C.mischief, '#3b2470');
    else drawTrap(cx, cy, 1, C.trap, C.trapLo);
  } else if (looks === 'treasure') drawChest(cx, cy, 1);
  else drawFake(cx, cy, 1);
  // 置いた人の色の小さな印(中身が見えているときだけ)
  if (it.owner !== NEUTRAL) {
    ctx.fillStyle = st.players[it.owner].color;
    ctx.beginPath(); ctx.arc(cx + 18, cy + 18, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.bg; ctx.lineWidth = 2; ctx.stroke();
  }
}

function drawDie(x, y, size, n, color = C.text, dim = false) {
  ctx.globalAlpha = dim ? 0.35 : 1;
  ctx.fillStyle = 'rgba(0,0,0,.5)'; roundRect(x + 3, y + 4, size, size, size * 0.18); ctx.fill();
  ctx.fillStyle = color; roundRect(x, y, size, size, size * 0.18); ctx.fill();
  const pips = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] }[n];
  ctx.fillStyle = n === 1 ? C.trap : '#1a1208';
  for (const [i, j] of pips) {
    ctx.beginPath();
    ctx.arc(x + size * (0.25 + i * 0.25), y + size * (0.25 + j * 0.25), size * (n === 1 ? 0.12 : 0.085), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- 盤面 ----------
function drawBackground() {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, L.W, L.H);
  // たいまつの光(四隅)
  for (const [x, y] of [[0, 0], [L.W, 0], [0, L.H], [L.W, L.H]]) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(L.W, L.H) * 0.55);
    g.addColorStop(0, `rgba(${C.torch},.16)`); g.addColorStop(1, `rgba(${C.torch},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, L.W, L.H);
  }
}

function drawStone(x, y, w, h) {
  ctx.fillStyle = C.stoneLo; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  ctx.fillStyle = C.stone; ctx.fillRect(x + 3, y + 3, w - 6, h - 8);
  ctx.fillStyle = C.stoneHi; ctx.fillRect(x + 3, y + 3, w - 6, 2);
}

function drawBoard(now) {
  const blink = 0.5 + 0.5 * Math.sin(now / 140);
  // 封印の扉(ゴールとスタートの間)
  {
    const [c, r] = L.cells[TUNE.goal + 1];
    const x = L.OX + c * L.CW, y = L.OY + r * L.CH;
    ctx.fillStyle = '#1f1a16'; ctx.fillRect(x + 2, y + 2, L.CW - 4, L.CH - 4);
    ctx.strokeStyle = '#5c5048'; ctx.lineWidth = 3;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + (L.CW * i) / 4, y + 6); ctx.lineTo(x + (L.CW * i) / 4, y + L.CH - 6); ctx.stroke(); }
  }
  for (let sq = 0; sq <= TUNE.goal; sq++) {
    const { x, y } = cellXY(sq);
    const cx = x + L.CW / 2, cy = y + L.CH / 2;
    if (sq === TUNE.goal) {
      const g = ctx.createLinearGradient(x, y, x, y + L.CH);
      g.addColorStop(0, '#ffe066'); g.addColorStop(1, C.goldLo);
      ctx.fillStyle = g; roundRect(x + 5, y + 5, L.CW - 10, L.CH - 8, [20, 20, 3, 3]); ctx.fill();
      ctx.strokeStyle = C.hilite; ctx.lineWidth = 2; ctx.stroke();
      label('ゴール', cx, cy + 6, '#2a1a06', 14, 'center', 'bold');
    } else if (sq === 0) {
      drawStone(x, y, L.CW, L.CH);
      ctx.fillStyle = 'rgba(105,219,124,.18)'; ctx.fillRect(x + 3, y + 3, L.CW - 6, L.CH - 8);
      label('スタート', cx, y + 12, C.sub, 11, 'center', 'bold');
    } else {
      drawStone(x, y, L.CW, L.CH);
      if (sq % 5 === 0) label(String(sq), x + 7, y + 11, C.dim, 11, 'left', 'bold');
    }
    // 置けるマス: 狙う相手の色で塗る
    const target = ui.valid?.get(sq);
    if (target !== undefined) {
      ctx.globalAlpha = 0.28 + 0.12 * blink;
      ctx.fillStyle = st.players[target].color; ctx.fillRect(x + 3, y + 3, L.CW - 6, L.CH - 6);
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]); ctx.strokeStyle = C.text; ctx.lineWidth = 2;
      ctx.strokeRect(x + 4, y + 4, L.CW - 8, L.CH - 8); ctx.setLineDash([]);
    }
    const diceHit = ui.dice?.findIndex(d => d.dest === sq);
    const isDice = diceHit !== undefined && diceHit >= 0 && (ui.chosen === null || ui.chosen === diceHit);
    if (isDice) {
      ctx.strokeStyle = blink > 0.5 ? C.hilite : C.gold; ctx.lineWidth = 4;
      ctx.strokeRect(x + 3, y + 3, L.CW - 6, L.CH - 6);
    }
    if (ui.pulse === sq) {
      const k = 0.5 + 0.5 * Math.sin(now / 70);
      ctx.strokeStyle = `rgba(224,49,49,${0.5 + 0.5 * k})`; ctx.lineWidth = 6 + 4 * k;
      ctx.strokeRect(x + 1, y + 1, L.CW - 2, L.CH - 2);
    }
    const it = st?.items.get(sq);
    if (it) {
      if (st.over || visibleOnStream(st.mode, it, st.players)) drawItem(it, cx, cy + 2, st.over);
      else drawHidden(cx, cy + 2, isDice || ui.pulse === sq ? blink : 0);
    }
    if (isDice) {
      const d = ui.dice[diceHit].die;
      ctx.fillStyle = C.gold; ctx.beginPath(); ctx.arc(x + L.CW - 10, y + 11, 10, 0, Math.PI * 2); ctx.fill();
      label(String(d), x + L.CW - 10, y + 12, '#1a1208', 14, 'center', 'bold');
    }
  }
}

// タイトル画面の飾り(st がないとき)
const DECOR = [[3, 'trap'], [7, 'hidden'], [12, 'treasure'], [18, 'hidden'], [24, 'trap'], [29, 'hidden'], [33, 'treasure'], [37, 'hidden']];
function drawDecor(now) {
  for (const [sq, kind] of DECOR) {
    const { x, y } = cellCenter(sq);
    if (kind === 'trap') drawTrap(x, y + 2, 1, C.trap, C.trapLo);
    else if (kind === 'treasure') drawChest(x, y + 2, 1);
    else drawHidden(x, y + 2, sq === 18 ? 0.5 + 0.5 * Math.sin(now / 200) : 0);
  }
}

// ---------- コマ ----------
function viewPos(pid, now) {
  const a = ui.anim.get(pid);
  if (!a) return { f: ui.vpos[pid] ?? 0, hop: 0 };
  const t = Math.min(1, (now - a.t0) / a.dur);
  const steps = Math.abs(a.b - a.a);
  const s = t * steps;
  const hop = t >= 1 ? 0 : Math.sin(Math.PI * (s - Math.floor(s)));
  return { f: a.a + (a.b - a.a) * t, hop };
}
function pathPoint(f) {
  const i = Math.max(0, Math.min(TUNE.goal, Math.floor(f)));
  const j = Math.min(TUNE.goal, i + 1);
  const p = cellCenter(i), q = cellCenter(j), k = f - i;
  return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
}
function drawPieces(now) {
  const mover = currentMover(st);
  const at = st.players.map(p => ({ p, ...viewPos(p.id, now) }));
  const bySq = new Map();
  for (const a of at) {
    const key = Math.round(a.f);
    if (!ui.anim.has(a.p.id)) bySq.set(key, [...(bySq.get(key) ?? []), a]);
  }
  const offsets = { 1: [[0, 0]], 2: [[-13, 0], [13, 0]], 3: [[-13, -11], [13, -11], [0, 11]], 4: [[-13, -11], [13, -11], [-13, 11], [13, 11]] };
  const draws = [];
  for (const [sq, list] of bySq) {
    const c = cellCenter(sq);
    list.forEach((a, i) => {
      const [dx, dy] = offsets[list.length][i];
      draws.push({ ...a, x: c.x + dx, y: c.y + dy, r: list.length === 1 ? 17 : 14 });
    });
  }
  for (const a of at) {
    if (!ui.anim.has(a.p.id)) continue;
    const pt = pathPoint(a.f);
    draws.push({ ...a, x: pt.x, y: pt.y - 14 * a.hop, r: 17 });
  }
  // 手番のコマを最後に描いて手前に出す
  draws.sort((u, v) => (u.p.id === mover?.id) - (v.p.id === mover?.id));
  for (const d of draws) {
    const isMover = mover?.id === d.p.id;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.ellipse(d.x, d.y + d.r * 0.8 + 10 * d.hop, d.r * 0.8, d.r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    if (isMover) {
      const k = 0.5 + 0.5 * Math.sin(now / 160);
      ctx.strokeStyle = d.p.color; ctx.globalAlpha = 0.4 + 0.4 * k; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 6 + 3 * k, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      const ay = d.y - d.r - 14 - 4 * k;
      ctx.fillStyle = C.hilite;
      ctx.beginPath(); ctx.moveTo(d.x - 8, ay - 8); ctx.lineTo(d.x + 8, ay - 8); ctx.lineTo(d.x, ay + 2); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = d.p.color;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    label(initial(d.p), d.x, d.y + 1, '#111', d.r > 15 ? 16 : 13, 'center', 'bold');
  }
}

// ---------- 舞台(盤面の内側) ----------
function drawStageFrame() {
  const s = L.stage;
  ctx.fillStyle = C.stage; roundRect(s.x, s.y, s.w, s.h, 12); ctx.fill();
  ctx.strokeStyle = C.stoneHi; ctx.lineWidth = 2; ctx.stroke();
}

function drawStandings(x, y, w, rowH, now) {
  const mover = currentMover(st);
  const order = st.players.slice().sort((a, b) => b.pos - a.pos || a.id - b.id);
  order.forEach((p, i) => {
    const ry = y + i * rowH;
    const isMover = mover?.id === p.id;
    ctx.fillStyle = isMover ? '#2e2418' : '#1f1914';
    roundRect(x, ry, w, rowH - 6, 8); ctx.fill();
    if (isMover) { ctx.strokeStyle = C.hilite; ctx.lineWidth = 2; ctx.stroke(); }
    const rank = order.findIndex(q => q.pos === p.pos) + 1;
    label(String(rank), x + 16, ry + (rowH - 6) / 2, rank === 1 ? C.gold : C.sub, 20, 'center', 'bold');
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x + 42, ry + (rowH - 6) / 2, 12, 0, Math.PI * 2); ctx.fill();
    label(initial(p), x + 42, ry + (rowH - 6) / 2 + 1, '#111', 13, 'center', 'bold');
    const nameW = w - 62 - 96;
    label(fit(p.name, nameW, 18), x + 62, ry + 14, C.text, 18, 'left', 'bold');
    // レース棒: ゴールまでの進み具合
    const bx = x + 62, bw = w - 62 - 72, by = ry + rowH - 20;
    ctx.fillStyle = C.stoneLo; roundRect(bx, by, bw, 8, 4); ctx.fill();
    const vp = viewPos(p.id, now).f;
    ctx.fillStyle = p.color; roundRect(bx, by, Math.max(8, (bw * vp) / TUNE.goal), 8, 4); ctx.fill();
    let right = `あと${TUNE.goal - p.pos}`;
    if (st.phase === 'place') right = placedCount(st, p.id) >= placeLimit(st) || (p.isBot && ui.botsDone) ? '伏せ終えた' : '仕掛け中…';
    if (st.over && st.winner === p.id) right = '勝ち!';
    label(right, x + w - 10, ry + 14, isMover ? C.hilite : C.sub, 15, 'right', 'bold');
  });
}

function drawStage(now) {
  const s = L.show, port = L.key === 'port';
  const pad = 14;
  // 見出し: ラウンドと表示モード
  const final = st.round === TUNE.maxRounds && !st.over;
  label(final ? '最終ラウンド!' : `ラウンド ${Math.min(st.round, TUNE.maxRounds)} / ${TUNE.maxRounds}`,
    s.x + pad, s.y + 20, final ? C.gold : C.text, 20, 'left', 'bold');
  const badge = MODES[st.mode].badge;
  ctx.font = `bold 13px ${FONT}`;
  const bw = ctx.measureText(badge).width + 20;
  ctx.fillStyle = st.mode === 'hide' ? '#2a2420' : '#5a2a10';
  roundRect(s.x + s.w - pad - bw, s.y + 8, bw, 24, 12); ctx.fill();
  label(badge, s.x + s.w - pad - bw / 2, s.y + 21, '#e8d5a9', 13, 'center', 'bold');

  // 状況の一行
  const mover = currentMover(st);
  let head = '';
  if (st.over) head = '';
  else if (st.phase === 'place') head = port ? '仕掛けフェーズ' : '仕掛けフェーズ: みんなが伏せています';
  else if (mover) head = `${mover.name}の手番`;
  if (ui.stageMsg) head = ui.stageMsg;
  if (head) label(fit(head, s.w - pad * 2, 22), s.x + s.w / 2, s.y + 52, mover && !ui.stageMsg ? mover.color : C.hilite, 22, 'center', 'bold');

  if (st.over) { drawPodium(now); return; }

  // 順位とサイコロ
  if (port) {
    drawStandings(s.x + pad, s.y + 76, s.w - pad * 2, 44, now);
    drawDiceArea(s.x + pad, s.y + 76 + st.players.length * 44, s.w - pad * 2, s.y + s.h - (s.y + 76 + st.players.length * 44));
  } else {
    const lw = Math.round(s.w * 0.56);
    drawStandings(s.x + pad, s.y + 80, lw, 56, now);
    drawDiceArea(s.x + pad + lw + 12, s.y + 80, s.w - lw - pad * 2 - 12, s.h - 90);
  }
}

function drawDiceArea(x, y, w, h) {
  if (ui.dice) {
    const size = Math.min(76, h - 40, (w - 30) / 2);
    const gap = Math.min(40, w - size * 2);
    const total = size * 2 + gap;
    ui.dice.forEach((d, i) => {
      const dx = x + (w - total) / 2 + i * (size + gap), dy = y + (h - size - 26) / 2;
      const dim = ui.chosen !== null && ui.chosen !== i;
      drawDie(dx, dy, size, d.die, C.text, dim);
      if (!dim) label(d.dest >= TUNE.goal ? 'ゴール!' : `${d.dest}マス目へ`, dx + size / 2, dy + size + 18, C.sub, 15, 'center', 'bold');
    });
  } else if (st.phase === 'place' && st.round === 1) {
    const lines = ['ワナや宝箱を', 'だれかの先に伏せて置く', '→ サイコロ2個から1つ選んで進む', '先にゴールした人の勝ち'];
    lines.forEach((t, i) => label(t, x + w / 2, y + h / 2 - 45 + i * 30, i === 2 ? C.gold : C.sub, 16, 'center', 'bold'));
  } else {
    // 伏せマスの数(配信の見どころ)
    const hidden = [...st.items.values()].filter(it => !visibleOnStream(st.mode, it, st.players)).length;
    const shown = st.items.size - hidden;
    drawHidden(x + w / 2 - 50, y + h / 2 - 6, 0);
    label(`× ${st.items.size}`, x + w / 2 - 20, y + h / 2 - 4, C.text, 26, 'left', 'bold');
    label(shown && hidden ? `うち${shown}個は配信に表示中` : 'ダンジョンに潜む仕掛け', x + w / 2, y + h / 2 + 36, C.sub, 14);
  }
}

function drawPodium(now) {
  const s = L.show;
  const top = ranking(st).slice(0, 3);
  const port = L.key === 'port';
  const colW = port ? 96 : 120, heights = port ? [120, 85, 60] : [140, 100, 70];
  const order = [1, 0, 2].filter(i => top[i]);
  const baseY = s.y + (port ? 250 : 290);
  const startX = s.x + (port ? s.w / 2 : s.w * 0.3) - (colW * 3 + 16) / 2;
  order.forEach((ri, k) => {
    const p = top[ri];
    const slot = top.length === 2 ? [0, 1][k] + 0.5 : k;
    const x = startX + slot * (colW + 8), hgt = heights[ri];
    const rise = Math.min(1, (now - (ui.podiumT0 ?? now)) / 600);
    const hh = hgt * rise;
    const g = ctx.createLinearGradient(x, baseY - hh, x, baseY);
    g.addColorStop(0, ri === 0 ? C.gold : ri === 1 ? '#ced4da' : '#d9895b'); g.addColorStop(1, C.woodLo);
    ctx.fillStyle = g; roundRect(x, baseY - hh, colW, hh, [8, 8, 0, 0]); ctx.fill();
    label(String(ri + 1), x + colW / 2, baseY - hh + 26, '#1a1208', 28, 'center', 'bold');
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x + colW / 2, baseY - hh - 26, 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    label(initial(p), x + colW / 2, baseY - hh - 25, '#111', 16, 'center', 'bold');
    label(fit(p.name, colW + 10, 16), x + colW / 2, baseY - hh - 58, C.text, 16, 'center', 'bold');
  });
  if (port) return; // 縦向きでは表彰は下の操作パネルに出す
  const list = awards(st).slice(0, 3);
  const ax = port ? s.x + 20 : s.x + s.w * 0.62, ay = port ? baseY + 24 : s.y + 100;
  label('今日の表彰', ax, ay, C.gold, 18, 'left', 'bold');
  list.forEach((a, i) => {
    label(a.title, ax, ay + 32 + i * 50, C.sub, 14, 'left', 'bold');
    label(fit(`${a.who.join('、')}  ${a.count}回`, port ? s.w - 40 : s.w * 0.36, 18), ax, ay + 54 + i * 50, C.text, 18, 'left', 'bold');
  });
  if (!list.length) label('なし', ax, ay + 34, C.sub, 16, 'left');
}

function drawTitleStage(now) {
  const s = L.show;
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  const bob = Math.sin(now / 600) * 3;
  label('ワナしかけ', cx, cy - 50 + bob, C.gold, L.key === 'port' ? 50 : 60, 'center', 'bold', C.trapLo);
  label('ダンジョン', cx, cy + 20 + bob, C.text, L.key === 'port' ? 50 : 60, 'center', 'bold', C.trapLo);
  label('伏せて、踏ませて、ゴールを目指せ', cx, cy + 82, C.sub, 18, 'center', 'bold');
}

// ---------- 演出: 告知・粒・揺れ ----------
function announce(word, lines, color, tier) {
  const ms = { big: 1900, mid: 1500, small: 1100 }[tier];
  ui.event = { word, lines, color, tier, t0: performance.now(), until: performance.now() + spd(ms) };
}
function burst(sq, colors, n, power = 1) {
  if (reduceMotion.matches) n = Math.floor(n / 3);
  const { x, y } = cellCenter(sq);
  for (let i = 0; i < n && ui.particles.length < 220; i++) {
    const a = Math.random() * Math.PI * 2, v = (60 + Math.random() * 220) * power;
    ui.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80 * power, life: 0.7 + Math.random() * 0.6, age: 0,
      color: colors[i % colors.length], size: 2 + Math.random() * 4,
    });
  }
}
function shake(mag, ms) {
  if (reduceMotion.matches) return;
  ui.shake = { mag, t0: performance.now(), dur: spd(ms) };
}
function drawParticles(dt) {
  ui.particles = ui.particles.filter(p => (p.age += dt) < p.life);
  for (const p of ui.particles) {
    p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
    ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}
function drawEvent(now) {
  const e = ui.event;
  if (!e || now > e.until) return;
  const s = L.show;
  const t = (now - e.t0) / 1000;
  const fadeOut = Math.min(1, (e.until - now) / 200);
  ctx.globalAlpha = 0.9 * fadeOut;
  ctx.fillStyle = C.bg; roundRect(s.x, s.y, s.w, s.h, 12); ctx.fill();
  ctx.strokeStyle = e.color; ctx.lineWidth = e.tier === 'big' ? 5 : 3; ctx.stroke();
  ctx.globalAlpha = fadeOut;
  const base = { big: L.key === 'port' ? 64 : 84, mid: 58, small: 42 }[e.tier];
  const pop = 1 + 0.4 * Math.max(0, 1 - t / 0.18);
  const cy = s.y + s.h / 2 - (e.lines.length * 30) / 2;
  ctx.save();
  ctx.translate(s.x + s.w / 2, cy - 10); ctx.scale(pop, pop);
  label(e.word, 0, 0, e.color, base, 'center', 'bold', 'rgba(0,0,0,.7)');
  ctx.restore();
  e.lines.forEach((l, i) => label(fit(l, s.w - 30, 22), s.x + s.w / 2, cy + base / 2 + 22 + i * 32, i === 0 ? C.text : C.sub, 22, 'center', 'bold'));
  ctx.globalAlpha = 1;
}

let lastT = performance.now();
function draw(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  ctx.setTransform(canvas.width / L.W, 0, 0, canvas.height / L.H, 0, 0);
  if (ui.shake) {
    const k = 1 - (now - ui.shake.t0) / ui.shake.dur;
    if (k <= 0) ui.shake = null;
    else ctx.translate((Math.random() - 0.5) * ui.shake.mag * k * 2, (Math.random() - 0.5) * ui.shake.mag * k * 2);
  }
  drawBackground();
  drawStageFrame();
  drawBoard(now);
  if (!st) { drawDecor(now); drawTitleStage(now); }
  else { drawStage(now); drawPieces(now); }
  drawParticles(dt);
  if (st) drawEvent(now);
  requestAnimationFrame(draw);
}

// ---------- コマの移動 ----------
async function walk(pid, a, b, msPerStep = 130) {
  if (a === b) { ui.vpos[pid] = b; return; }
  const steps = Math.abs(b - a);
  const dur = spd(msPerStep * steps);
  ui.anim.set(pid, { a, b, t0: performance.now(), dur });
  for (let i = 0; i < Math.min(steps, 12); i++) setTimeout(sfx.step, (dur / steps) * (i + 1) - 20);
  await sleepRaw(dur);
  ui.anim.delete(pid);
  ui.vpos[pid] = b;
}
const syncView = () => { ui.vpos = st.players.map(p => p.pos); ui.anim.clear(); };

// ---------- 手元画面 ----------
function setPhase(text) { $('phase').textContent = text; }
function clearControls() { $('controls').replaceChildren(); }
function addHint(text, cls = 'hint') {
  const p = document.createElement('p'); p.className = cls; p.textContent = text;
  $('controls').append(p); return p;
}
function addButton(text, onClick, cls = '', parent = $('controls')) {
  const b = document.createElement('button'); b.textContent = text; b.className = cls;
  b.addEventListener('click', onClick); parent.append(b); return b;
}
function logLine(text) {
  const li = document.createElement('li'); li.textContent = `R${st.round} ${text}`;
  $('log').prepend(li);
}
function renderMine() {
  const ul = $('mine'); ul.replaceChildren();
  const mine = [...st.items].filter(([, it]) => it.owner === 0).sort((a, b) => a[0] - b[0]);
  if (!mine.length) { const li = document.createElement('li'); li.textContent = 'なし'; ul.append(li); }
  for (const [sq, it] of mine) {
    const li = document.createElement('li');
    li.textContent = `${sq}マス目: ${CARD_LABEL[it.type]}(${it.target === 0 ? '自分の先' : st.players[it.target].name + 'の先'})`;
    ul.append(li);
  }
  const dc = deckCounts(st);
  $('deck').textContent = st.deckDef.fake ? `山札: ワナ${dc.trap} 宝箱${dc.treasure} 見せかけ${dc.fake}` : `山札: ワナ${dc.trap} 宝箱${dc.treasure}`;
}

function cardButton(type, selected, disabled, onClick) {
  const b = document.createElement('button');
  b.className = `card${selected ? ' sel' : ''}`;
  b.disabled = disabled;
  const icon = document.createElement('span'); icon.className = `icon icon-${type}`;
  const name = document.createElement('span'); name.textContent = CARD_LABEL[type];
  b.append(icon, name);
  b.addEventListener('click', onClick);
  return b;
}

function canvasPoint(ev) {
  // 枠線の内側を基準に、論理座標へ直す
  return { x: (ev.offsetX * L.W) / canvas.clientWidth, y: (ev.offsetY * L.H) / canvas.clientHeight };
}

function placementUI(resolve) {
  clearControls();
  const me = st.players[0];
  const left = placeLimit(st) - placedCount(st, 0);
  setPhase(left > 0 ? `仕掛けを伏せよう(あと${left}個)` : '伏せ終わりました');
  const wrap = document.createElement('div'); wrap.className = 'cards';
  me.hand.forEach((type, i) => {
    wrap.append(cardButton(type, ui.selected === i, left <= 0, () => {
      ui.selected = ui.selected === i ? null : i;
      ui.valid = ui.selected === null ? null : validSquares(st, 0, me.hand[i]);
      placementUI(resolve);
    }));
  });
  $('controls').append(wrap);
  if (ui.selected !== null) {
    const t = me.hand[ui.selected];
    addHint(t === 'treasure' ? '光っているマスをタップ。宝箱は自分の先にも置けます(マスの色=だれの先か)。' :
      t === 'fake' ? '光っているマスをタップ。見せかけは配信画面にワナとして映りますが、何も起きません。' :
      '光っているマスをタップ。マスの色が、ワナを踏ませたい相手です。');
  } else if (left > 0) {
    addHint('札を選んで、盤面の光るマスに伏せます。置かずに進めてもかまいません。');
  }
  addButton(left > 0 ? '置かずに進む' : 'サイコロへ進む', () => { ui.selected = null; ui.valid = null; resolve(); }, left > 0 ? 'big' : 'primary big');
  canvas.onclick = ev => {
    if (ui.selected === null) return;
    const { x, y } = canvasPoint(ev);
    const sq = squareAt(x, y);
    if (sq === null || !ui.valid?.has(sq)) return;
    if (place(st, 0, ui.selected, sq)) {
      sfx.place();
      burst(sq, [C.wood, C.sub], 10, 0.4);
      logLine(`${sq}マス目に${CARD_LABEL[st.items.get(sq).type]}を置いた`);
      ui.selected = null; ui.valid = null;
      renderMine();
      placementUI(resolve);
    }
  };
}

function waitHumanPlacement() {
  return new Promise(resolve => placementUI(resolve)).finally(() => { canvas.onclick = null; });
}

function waitHumanRoll() {
  return new Promise(resolve => {
    clearControls();
    setPhase('あなたの番です');
    addButton('サイコロを振る', () => { clearControls(); resolve(); }, 'primary big');
  });
}

function waitHumanChoice() {
  return new Promise(resolve => {
    clearControls();
    setPhase('どちらの目で進む?');
    const row = document.createElement('div'); row.className = 'dice-choice';
    st.dice.forEach((d, i) => {
      const dest = destination(st, 0, d);
      const it = st.items.get(dest);
      const note = dest >= TUNE.goal ? 'ゴール!' : it && it.owner === 0 ? `自分の${CARD_LABEL[it.type]}` : it ? '伏せマス' : `${dest}マス目`;
      const b = document.createElement('button');
      const big = document.createElement('b'); big.textContent = String(d);
      const small = document.createElement('small'); small.textContent = note;
      b.append(big, small);
      b.addEventListener('click', () => { clearControls(); setPhase('移動中…'); resolve(i); });
      row.append(b);
    });
    $('controls').append(row);
    addHint('盤面で光っている2つのマスが行き先です。');
  });
}

// ---------- 進行 ----------
async function resolveLanding(mover, idx) {
  const die = st.dice[idx];
  const from = mover.pos;
  const dest = destination(st, mover.id, die);
  const it = st.items.get(dest);
  const before = st.players.map(p => p.pos);
  ui.chosen = idx;
  await sleep(350);
  ui.dice = null; ui.chosen = null;
  // 伏せマスの手前で一度止まって「来る来る」
  const suspense = it && dest < TUNE.goal;
  await walk(mover.id, from, suspense ? dest - 1 : dest);
  if (suspense) {
    ui.pulse = dest;
    ui.stageMsg = it.owner === mover.id ? `${mover.name}が自分の仕掛けへ…` : `${mover.name}が伏せマスへ…!`;
    sfx.kuru();
    if (it.owner === 0 && mover.id !== 0) {
      clearControls();
      setPhase('あなたの仕掛けへ向かっています!');
      addHint(`${mover.name}が${dest}マス目(あなたの${CARD_LABEL[it.type]})に向かっています`, 'alert');
    }
    await sleep(1300);
    ui.pulse = null; ui.stageMsg = null;
    await walk(mover.id, dest - 1, dest, 200);
  }
  const ev = move(st, idx);
  renderMine();
  const m = st.players[ev.mover];
  if (ev.item) {
    const o = ownerName(ev.item.owner);
    const ago = roundsAgo(ev.item);
    if (ev.effect === 'trap') {
      sfx.trap(); burst(dest, [C.trap, '#ff8787', C.hilite], 70, 1.2); shake(12, 500);
      announce('ワナ!', [`${o}のワナ(${ago})`, `${m.name} ${TUNE.trapBack}マス戻る / ${o} ${ev.ownerGain}マス進む`], C.trap, 'big');
      logLine(`${m.name}が${o}のワナを踏んだ(${ago})`);
      await sleep(700);
      const owner = ev.item.owner;
      await Promise.all([walk(m.id, dest, ev.to, 170), walk(owner, before[owner], st.players[owner].pos, 170)]);
      await sleep(900);
    } else if (ev.effect === 'self') {
      sfx.self(); burst(dest, ['#ff922b', C.trap, C.text], 70, 1.2); shake(14, 600);
      announce('自爆!', [`${m.name}が自分のワナを踏んだ(${ago})`, `${TUNE.selfTrapBack}マス戻る`], '#ff922b', 'big');
      logLine(`${m.name}が自爆した`);
      await sleep(700);
      await walk(m.id, dest, ev.to, 170);
      await sleep(900);
    } else if (ev.effect === 'neutral') {
      sfx.trap(); burst(dest, [C.mischief, '#d0bfff'], 40, 0.9); shake(6, 350);
      announce('いたずら!', [`ダンジョンのワナ`, `${m.name} ${TUNE.neutralBack}マス戻る`], C.mischief, 'mid');
      logLine(`${m.name}がいたずらに引っかかった`);
      await sleep(600);
      await walk(m.id, dest, ev.to, 170);
      await sleep(700);
    } else if (ev.effect === 'steal' || ev.effect === 'collect') {
      sfx.treasure(); burst(dest, [C.gold, C.hilite, C.chest], ev.effect === 'steal' ? 70 : 40, 1);
      if (ev.effect === 'steal') {
        shake(6, 300);
        announce('横取り!', [`${o}の宝箱を${m.name}が横取り(${ago})`, `${TUNE.treasureGain}マス進む`], C.gold, 'big');
        logLine(`${m.name}が${o}の宝箱を横取りした`);
      } else {
        announce('回収!', [`${m.name}が自分の宝箱を開けた`, `${TUNE.treasureGain}マス進む`], C.gold, 'mid');
        logLine(`${m.name}が自分の宝箱を回収した`);
      }
      await sleep(600);
      await walk(m.id, dest, ev.to, 150);
      await sleep(800);
    } else if (ev.effect === 'fake') {
      sfx.fake(); burst(dest, [C.mischief], 16, 0.4);
      announce('見せかけ', [`${o}の見せかけでした(${ago})`, '何も起きない'], C.mischief, 'small');
      logLine(`${m.name}が${o}の見せかけを踏んだ`);
      await sleep(1100);
    }
  } else if (ev.nearMiss) {
    announce('ニアミス', [`${m.name}のとなりにワナが…`], '#74c0fc', 'small');
    logLine(`${m.name}がワナのとなりに止まった`);
    await sleep(1000);
  } else {
    logLine(`${m.name}が${ev.die}で${ev.to}マス目へ`);
    await sleep(250);
  }
  syncView();
  if (st.over && st.endReason === 'goal') {
    sfx.goal(); burst(TUNE.goal, [C.gold, C.hilite, '#4dabf7', '#69db7c', '#f783ac'], 120, 1.4);
    announce('ゴール!', [`${st.players[st.winner].name}の勝ち`], C.gold, 'big');
    await sleep(2200);
  }
}

function roundsAgo(it) {
  const n = st.round - it.round;
  return n === 0 ? 'このラウンドに設置' : `${n}ラウンド前に設置`;
}
function ownerName(owner) {
  return owner === NEUTRAL ? 'ダンジョンのいたずら' : st.players[owner].name;
}

async function runGame(game) {
  let lastRound = 0;
  while (!game.over && st === game) {
    if (st.phase === 'place') {
      if (st.round !== lastRound) {
        lastRound = st.round;
        if (st.round === TUNE.maxRounds) {
          sfx.final();
          announce('最終ラウンド', ['ここで決着がつかなければ、一番進んでいる人の勝ち'], C.gold, 'mid');
          await sleep(1500);
        }
      }
      ui.botsDone = false;
      await waitHumanPlacement();
      ui.botsDone = true;
      const evs = endPlacement(st);
      renderMine();
      clearControls();
      setPhase('移動フェーズ');
      if (evs.some(e => e.kind === 'neutral-placed')) {
        announce('いたずら', ['ダンジョンがワナを1つ仕掛けた…'], C.mischief, 'small');
        await sleep(1300);
      }
      continue;
    }
    const mover = currentMover(st);
    let idx;
    if (mover.isBot) {
      clearControls();
      setPhase(`${mover.name}の番`);
      await sleep(450);
      rollDice(st); sfx.dice();
      ui.dice = st.dice.map(d => ({ die: d, dest: destination(st, mover.id, d) }));
      await sleep(1100); // 迷う時間
      idx = botChooseDie(st, mover.id);
    } else {
      await waitHumanRoll();
      rollDice(st); sfx.dice();
      ui.dice = st.dice.map(d => ({ die: d, dest: destination(st, 0, d) }));
      idx = await waitHumanChoice();
    }
    await resolveLanding(mover, idx);
  }
  if (st === game) showResult();
}

function showPanel(id) {
  for (const k of ['title', 'play', 'result']) $(k).classList.toggle('hidden', k !== id);
}

function showResult() {
  clearControls();
  ui.podiumT0 = performance.now();
  const w = st.players[st.winner];
  $('resultTitle').textContent = st.endReason === 'goal' ? `${w.name}がゴール!` : `${TUNE.maxRounds}ラウンド終了。${w.name}の勝ち`;
  const rank = $('rankList'); rank.replaceChildren();
  for (const p of ranking(st)) {
    const li = document.createElement('li');
    li.textContent = `${p.name}(${p.pos}マス目 / ワナ命中${p.stats.trapHits} 横取り${p.stats.steals} 自爆${p.stats.selfDestructs})`;
    rank.append(li);
  }
  const aw = $('awardList'); aw.replaceChildren();
  const list = awards(st);
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'なし'; aw.append(li); }
  for (const a of list) {
    const li = document.createElement('li');
    li.textContent = `${a.title}: ${a.who.join('、')}(${a.count}回)`;
    aw.append(li);
  }
  const rp = $('replayList'); rp.replaceChildren();
  for (const ev of st.log.filter(e => e.item || e.nearMiss)) {
    const li = document.createElement('li');
    const m = st.players[ev.mover].name;
    const o = ev.item ? ownerName(ev.item.owner) : '';
    const set = ev.item ? `(R${ev.item.round}に設置)` : '';
    const text = {
      trap: `${m}が${o}のワナを踏んだ`,
      self: `${m}が自分のワナで自爆した`,
      neutral: `${m}がダンジョンのいたずらに引っかかった`,
      steal: `${m}が${o}の宝箱を横取りした`,
      collect: `${m}が自分の宝箱を回収した`,
      fake: `${m}が${o}の見せかけを踏んだ`,
    }[ev.effect] ?? `${m}がワナのとなりに止まった(ニアミス)`;
    li.textContent = `R${ev.round} ${ev.dest}マス目: ${text}${set}`;
    rp.append(li);
  }
  showPanel('result');
}

// ---------- タイトル ----------
function setupTitle() {
  const box = $('modes');
  const desc = () => { $('modeDesc').textContent = MODE_DESC[document.querySelector('input[name=mode]:checked').value]; };
  Object.entries(MODES).forEach(([key, m], i) => {
    const lab = document.createElement('label');
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'mode'; r.value = key; r.checked = i === 0;
    r.addEventListener('change', desc);
    const b = document.createElement('span'); b.textContent = m.label;
    lab.append(r, b); box.append(lab);
  });
  desc();
  $('start').addEventListener('click', start);
  $('again').addEventListener('click', () => { st = null; showPanel('title'); });
}

function start() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  st = createGame({ humanName: $('name').value, botCount: Number($('bots').value), mode });
  Object.assign(ui, { selected: null, valid: null, dice: null, chosen: null, pulse: null, stageMsg: null, event: null, particles: [], shake: null });
  syncView();
  $('log').replaceChildren();
  renderMine();
  showPanel('play');
  tone(1, 0.01, 'sine', 0.0001); // 最初のクリックで音を使えるようにする
  runGame(st);
}

applyLayout();
new ResizeObserver(applyLayout).observe(canvas);
phoneQuery.addEventListener('change', applyLayout);
window.addEventListener('resize', applyLayout);
setupTitle();
requestAnimationFrame(draw);

// 自動テスト用(?debug を付けたときだけ): 置けるマスの1つ目の、canvas 左上からの表示座標を返す
if (new URLSearchParams(location.search).has('debug')) {
  window.__validFirst = () => {
    const sq = ui.valid && [...ui.valid.keys()][0];
    if (sq === undefined || sq === null) return null;
    const { x, y } = cellCenter(sq);
    return { x: canvas.clientLeft + (x * canvas.clientWidth) / L.W, y: canvas.clientTop + (y * canvas.clientHeight) / L.H };
  };
  window.__eventOn = () => !!ui.event && performance.now() < ui.event.until;
}
