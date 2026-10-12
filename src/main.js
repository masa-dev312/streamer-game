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

const $ = id => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

let st = null;
const ui = {
  selected: null,       // 手札の何枚目を選んでいるか
  valid: null,          // 置けるマス
  dice: null,           // [{ die, dest }]
  pulse: null,          // 「来る来る」中のマス
  banner: null,         // { lines, color, until }
  announce: null,       // 上部のお知らせ
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
  dice: () => { tone(400, 0.05); tone(500, 0.05, 'square', 0.05, 0.06); },
  kuru: () => { for (let i = 0; i < 6; i++) tone(300 + i * 60, 0.09, 'triangle', 0.05, i * 0.13); },
  trap: () => { tone(220, 0.25, 'sawtooth', 0.07); tone(150, 0.3, 'sawtooth', 0.07, 0.15); },
  self: () => { tone(500, 0.1, 'sawtooth'); tone(250, 0.1, 'sawtooth', 0.05, 0.1); tone(120, 0.4, 'sawtooth', 0.07, 0.2); },
  treasure: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, i * 0.08)); },
  fake: () => { tone(440, 0.1, 'sine'); tone(330, 0.2, 'sine', 0.05, 0.12); },
  goal: () => { [523, 659, 784, 659, 784, 1046].forEach((f, i) => tone(f, 0.15, 'triangle', 0.07, i * 0.12)); },
  final: () => { [392, 392, 523].forEach((f, i) => tone(f, 0.18, 'square', 0.06, i * 0.2)); },
};

const sleep = ms => new Promise(r => setTimeout(r, $('fast').checked ? ms * 0.25 : ms));

// ---------- 盤面の座標 ----------
const COLS = 9, CW = 96, CH = 74, OX = (960 - COLS * CW) / 2, OY = 76;
function cellXY(sq) {
  const row = Math.floor(sq / COLS);
  const c = sq % COLS;
  const col = row % 2 === 0 ? c : COLS - 1 - c;
  return { x: OX + col * CW, y: OY + row * CH };
}
function squareAt(px, py) {
  for (let sq = 0; sq <= TUNE.goal; sq++) {
    const { x, y } = cellXY(sq);
    if (px >= x && px < x + CW && py >= y && py < y + CH) return sq;
  }
  return null;
}

// ---------- 描画 ----------
function roundsAgo(it) {
  const n = st.round - it.round;
  return n === 0 ? 'このラウンドに設置' : `${n}ラウンド前に設置`;
}
function ownerName(owner) {
  return owner === NEUTRAL ? 'ダンジョンのいたずら' : st.players[owner].name;
}

function drawItem(it, x, y, reveal) {
  const cx = x + CW / 2, cy = y + CH / 2 + 4;
  const ownerColor = it.owner === NEUTRAL ? '#b197fc' : st.players[it.owner].color;
  // 配信画面では見せかけはワナと同じ見た目(終了後の全公開でだけ正体を出す)
  const looksLike = it.type === 'fake' && !reveal ? 'trap' : it.type;
  ctx.lineWidth = 3;
  ctx.strokeStyle = ownerColor;
  if (looksLike === 'trap') {
    ctx.fillStyle = it.owner === NEUTRAL ? '#5f3dc4' : '#c92a2a';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? 9 : 20, a = (Math.PI / 4) * i;
      ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    label(it.owner === NEUTRAL ? 'いたずら' : 'ワナ', cx, cy + 30, '#fff', 11);
  } else if (looksLike === 'treasure') {
    ctx.fillStyle = '#f59f00';
    ctx.fillRect(cx - 16, cy - 11, 32, 22); ctx.strokeRect(cx - 16, cy - 11, 32, 22);
    label('宝箱', cx, cy + 30, '#fff', 11);
  } else {
    ctx.fillStyle = '#7950f2';
    ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    label('見せかけ', cx, cy + 30, '#fff', 11);
  }
}

function label(text, x, y, color, size = 14, align = 'center', weight = 'normal') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "Hiragino Sans","Noto Sans JP","WenQuanYi Zen Hei",sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function draw(now) {
  ctx.clearRect(0, 0, 960, 540);
  ctx.fillStyle = '#0d0b14';
  ctx.fillRect(0, 0, 960, 540);
  if (!st) { requestAnimationFrame(draw); return; }

  // 上部: モードのバッジ・ラウンド・山札
  const badge = MODES[st.mode].badge;
  ctx.fillStyle = st.mode === 'hide' ? '#495057' : '#e8590c';
  ctx.fillRect(16, 12, 190, 30);
  label(badge, 111, 27, '#fff', 15, 'center', 'bold');
  const final = st.round === TUNE.maxRounds && !st.over;
  label(`ラウンド ${Math.min(st.round, TUNE.maxRounds)} / ${TUNE.maxRounds}${final ? '  最終ラウンド!' : ''}`,
    226, 27, final ? '#ffd43b' : '#ece9f5', 15, 'left', 'bold');
  const dc = deckCounts(st);
  const deckText = st.deckDef.fake ? `山札 ワナ${dc.trap} 宝箱${dc.treasure} 見せかけ${dc.fake}` : `山札 ワナ${dc.trap} 宝箱${dc.treasure}`;
  label(deckText, 944, 27, '#a7a1bd', 13, 'right');
  label('ルール: 伏せた仕掛けを置き合い、サイコロ2個から1つ選んで進む。ゴールに最初に着いた人が勝ち', 480, 56, '#a7a1bd', 12);

  // 道
  ctx.strokeStyle = '#2b2640'; ctx.lineWidth = 10;
  ctx.beginPath();
  for (let sq = 0; sq <= TUNE.goal; sq++) {
    const { x, y } = cellXY(sq);
    sq ? ctx.lineTo(x + CW / 2, y + CH / 2) : ctx.moveTo(x + CW / 2, y + CH / 2);
  }
  ctx.stroke();

  // マス
  const pulseOn = Math.floor(now / 180) % 2 === 0;
  for (let sq = 0; sq <= TUNE.goal; sq++) {
    const { x, y } = cellXY(sq);
    const isGoal = sq === TUNE.goal;
    ctx.fillStyle = isGoal ? '#5c4a00' : sq === 0 ? '#1f3b2c' : '#1d1a29';
    ctx.fillRect(x + 4, y + 4, CW - 8, CH - 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#3a3550';
    if (ui.valid?.has(sq)) { ctx.strokeStyle = '#51cf66'; ctx.lineWidth = 3; }
    const diceHit = ui.dice?.find(d => d.dest === sq);
    if (diceHit) { ctx.strokeStyle = pulseOn ? '#ffd43b' : '#fab005'; ctx.lineWidth = 4; }
    if (ui.pulse === sq) { ctx.strokeStyle = pulseOn ? '#ff6b6b' : '#ffd43b'; ctx.lineWidth = 6; }
    ctx.strokeRect(x + 4, y + 4, CW - 8, CH - 8);
    label(isGoal ? 'ゴール' : sq === 0 ? 'スタート' : String(sq), x + 10, y + 14, '#6f6a85', 11, 'left');
    if (diceHit) label(`${diceHit.die}の目`, x + CW - 10, y + 14, '#ffd43b', 13, 'right', 'bold');

    const it = st.items.get(sq);
    if (it) {
      if (st.over || visibleOnStream(st.mode, it, st.players)) drawItem(it, x, y, st.over);
      else {
        ctx.fillStyle = '#343a40';
        ctx.fillRect(x + CW / 2 - 16, y + CH / 2 - 12, 32, 32);
        label('?', x + CW / 2, y + CH / 2 + 4, '#ced4da', 20, 'center', 'bold');
      }
    }
  }

  // コマ
  const bySq = new Map();
  for (const p of st.players) bySq.set(p.pos, [...(bySq.get(p.pos) ?? []), p]);
  for (const [sq, ps] of bySq) {
    const { x, y } = cellXY(sq);
    ps.forEach((p, i) => {
      const px = x + 22 + (i % 2) * 52, py = y + 30 + Math.floor(i / 2) * 26;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = currentMover(st)?.id === p.id ? '#fff' : '#000'; ctx.lineWidth = 2; ctx.stroke();
      label(Array.from(p.name.replace('ボット:', ''))[0], px, py + 1, '#000', 12, 'center', 'bold');
    });
  }

  // 下部: 参加者
  const w = 960 / st.players.length;
  st.players.forEach((p, i) => {
    const x = i * w;
    ctx.fillStyle = '#1a1726'; ctx.fillRect(x + 4, 470, w - 8, 64);
    ctx.fillStyle = p.color; ctx.fillRect(x + 4, 470, 6, 64);
    label(p.name, x + 18, 488, '#ece9f5', 15, 'left', 'bold');
    let status = `${p.pos}マス目`;
    if (st.phase === 'place') status += placedCount(st, p.id) >= placeLimit(st) || (p.isBot && ui.botsDone) ? '  置き終えた' : '  仕掛け中…';
    if (currentMover(st)?.id === p.id) status += '  ← 手番';
    label(status, x + 18, 512, '#a7a1bd', 13, 'left');
  });

  // お知らせ・演出
  if (ui.announce) {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 230, 960, 60);
    label(ui.announce, 480, 260, '#ffd43b', 26, 'center', 'bold');
  }
  if (ui.banner && now < ui.banner.until) {
    const h = 40 + ui.banner.lines.length * 34;
    ctx.fillStyle = 'rgba(10,8,20,.88)'; ctx.fillRect(120, 270 - h / 2, 720, h);
    ctx.strokeStyle = ui.banner.color; ctx.lineWidth = 4; ctx.strokeRect(120, 270 - h / 2, 720, h);
    ui.banner.lines.forEach((t, i) => label(t, 480, 270 - h / 2 + 38 + i * 34, i ? '#ece9f5' : ui.banner.color, i ? 18 : 30, 'center', 'bold'));
  }
  requestAnimationFrame(draw);
}

function banner(lines, color, ms = 1800) {
  ui.banner = { lines, color, until: performance.now() + ($('fast').checked ? ms * 0.35 : ms) };
}

// ---------- 手元画面 ----------
function setPhase(text) { $('phase').textContent = text; }
function clearControls() { $('controls').replaceChildren(); }
function addHint(text, cls = 'hint') {
  const p = document.createElement('p'); p.className = cls; p.textContent = text;
  $('controls').append(p); return p;
}
function addButton(text, onClick, cls = '') {
  const b = document.createElement('button'); b.textContent = text; b.className = cls;
  b.addEventListener('click', onClick); $('controls').append(b); return b;
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
}

function placementUI(resolve) {
  clearControls();
  const me = st.players[0];
  const left = placeLimit(st) - placedCount(st, 0);
  setPhase(`仕掛けフェーズ: あと${left}個置けます`);
  addHint('手札を選び、配信画面の緑の枠のマスをクリックして伏せて置きます。置かずに締め切ってもかまいません。');
  const wrap = document.createElement('div'); wrap.className = 'cards';
  me.hand.forEach((type, i) => {
    const b = document.createElement('button');
    b.textContent = CARD_LABEL[type];
    b.className = `card-${type}${ui.selected === i ? ' sel' : ''}`;
    b.disabled = left <= 0;
    b.addEventListener('click', () => {
      ui.selected = ui.selected === i ? null : i;
      ui.valid = ui.selected === null ? null : validSquares(st, 0, me.hand[i]);
      placementUI(resolve);
    });
    wrap.append(b);
  });
  $('controls').append(wrap);
  if (ui.selected !== null) {
    const t = me.hand[ui.selected];
    addHint(t === 'treasure' ? '宝箱は自分を含む、だれのコマの先にも置けます。' :
      t === 'fake' ? '見せかけは配信画面にワナとして映りますが、何も起きません。' :
      'ワナは自分以外のコマの先に置けます。');
  }
  addButton('仕掛けを締め切る', () => { ui.selected = null; ui.valid = null; resolve(); }, 'primary');
  canvas.onclick = ev => {
    if (ui.selected === null) return;
    const r = canvas.getBoundingClientRect();
    const sq = squareAt((ev.clientX - r.left) * 960 / r.width, (ev.clientY - r.top) * 540 / r.height);
    if (sq === null || !ui.valid?.has(sq)) return;
    if (place(st, 0, ui.selected, sq)) {
      sfx.place();
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
    setPhase('あなたの手番');
    addButton('サイコロを2個振る', () => { clearControls(); resolve(); }, 'primary');
  });
}

function waitHumanChoice() {
  return new Promise(resolve => {
    clearControls();
    setPhase('どちらの目で進みますか?');
    addHint('配信画面で光っている2つのマスが行き先です。');
    st.dice.forEach((d, i) => {
      const dest = destination(st, 0, d);
      const it = st.items.get(dest);
      const mineNote = it && it.owner === 0 ? `(自分の${CARD_LABEL[it.type]})` : it ? '(伏せマス)' : '';
      addButton(`${d} で進む → ${dest}マス目${mineNote}`, () => { clearControls(); setPhase('移動中…'); resolve(i); });
    });
  });
}

// ---------- 進行 ----------
async function resolveLanding(mover, idx) {
  const dest = destination(st, mover.id, st.dice[idx]);
  const it = st.items.get(dest);
  ui.dice = null;
  // 「来る来る」: 進む目が決まってから発動までためる
  if (it && dest < TUNE.goal) {
    ui.pulse = dest;
    sfx.kuru();
    if (it.owner === 0 && mover.id !== 0) {
      clearControls();
      setPhase('あなたの仕掛けへ向かっています!');
      addHint(`${mover.name}が${dest}マス目(あなたの${CARD_LABEL[it.type]})に向かっています`, 'alert');
    }
    await sleep(1300);
    ui.pulse = null;
  } else {
    await sleep(350);
  }
  const ev = move(st, idx);
  renderMine();
  const m = st.players[ev.mover];
  if (ev.item) {
    const o = ownerName(ev.item.owner);
    const ago = roundsAgo(ev.item);
    if (ev.effect === 'trap') {
      sfx.trap();
      banner(['ワナ!', `${o}が${ago}`, `${m.name} ${TUNE.trapBack}マス戻る / ${o} ${ev.ownerGain}マス進む`], '#ff6b6b');
      logLine(`${m.name}が${o}のワナを踏んだ(${ago})`);
    } else if (ev.effect === 'self') {
      sfx.self();
      banner(['自爆!', `${m.name}が自分のワナを踏んだ(${ago})`, `${TUNE.selfTrapBack}マス戻る`], '#ff922b');
      logLine(`${m.name}が自爆した`);
    } else if (ev.effect === 'neutral') {
      sfx.trap();
      banner(['ダンジョンのいたずら!', `${m.name} ${TUNE.neutralBack}マス戻る`], '#b197fc');
      logLine(`${m.name}がいたずらに引っかかった`);
    } else if (ev.effect === 'steal') {
      sfx.treasure();
      banner(['横取り!', `${o}の宝箱を${m.name}が横取り(${ago})`, `${TUNE.treasureGain}マス進む`], '#fcc419');
      logLine(`${m.name}が${o}の宝箱を横取りした`);
    } else if (ev.effect === 'collect') {
      sfx.treasure();
      banner(['回収!', `${m.name}が自分の宝箱を回収`, `${TUNE.treasureGain}マス進む`], '#fcc419');
      logLine(`${m.name}が自分の宝箱を回収した`);
    } else if (ev.effect === 'fake') {
      sfx.fake();
      banner(['見せかけ!', `${o}の見せかけでした(${ago})`, '何も起きない'], '#b197fc');
      logLine(`${m.name}が${o}の見せかけを踏んだ`);
    }
    await sleep(2000);
  } else if (ev.nearMiss) {
    banner(['ニアミス!', `${m.name}のとなりにワナが…`], '#74c0fc', 1200);
    logLine(`${m.name}がワナのとなりに止まった`);
    await sleep(1200);
  } else {
    logLine(`${m.name}が${ev.die}で${ev.to}マス目へ`);
    await sleep(300);
  }
  if (st.over && st.endReason === 'goal') {
    sfx.goal();
    banner(['ゴール!', `${st.players[st.winner].name}の勝ち`], '#ffd43b', 2500);
    await sleep(2500);
  }
}

async function runGame() {
  let lastRound = 0;
  while (!st.over) {
    if (st.phase === 'place') {
      if (st.round !== lastRound) {
        lastRound = st.round;
        if (st.round === TUNE.maxRounds) {
          sfx.final();
          ui.announce = '最終ラウンド!';
          await sleep(1500);
          ui.announce = null;
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
        banner(['ダンジョンのいたずら', 'だれのものでもないワナが置かれた…'], '#b197fc', 1500);
        await sleep(1500);
      }
      continue;
    }
    const mover = currentMover(st);
    let idx;
    if (mover.isBot) {
      clearControls();
      setPhase(`${mover.name}の手番`);
      await sleep(500);
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
  showResult();
}

function showResult() {
  clearControls();
  setPhase('ゲーム終了');
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
  $('result').classList.remove('hidden');
}

// ---------- タイトル ----------
function setupTitle() {
  const box = $('modes');
  Object.entries(MODES).forEach(([key, m], i) => {
    const lab = document.createElement('label'); lab.className = 'mode';
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'mode'; r.value = key; r.checked = i === 0;
    const b = document.createElement('b'); b.textContent = ` ${m.label}`;
    const s = document.createElement('small'); s.textContent = MODE_DESC[key];
    lab.append(r, b, s); box.append(lab);
  });
  $('start').addEventListener('click', start);
  const again = () => {
    $('result').classList.add('hidden');
    $('title').classList.remove('hidden');
  };
  $('again').addEventListener('click', again);
  $('viewBoard').addEventListener('click', () => {
    $('result').classList.add('hidden');
    clearControls();
    setPhase('ゲーム終了: 全配置を公開中');
    addButton('結果を見る', () => $('result').classList.remove('hidden'));
    addButton('もう一度', again, 'primary');
  });
}

function start() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  st = createGame({ humanName: $('name').value, botCount: Number($('bots').value), mode });
  ui.selected = null; ui.valid = null; ui.dice = null; ui.pulse = null; ui.banner = null; ui.announce = null;
  $('log').replaceChildren();
  renderMine();
  $('title').classList.add('hidden');
  tone(1, 0.01, 'sine', 0.0001); // 最初のクリックで音を使えるようにする
  runGame();
}

setupTitle();
requestAnimationFrame(draw);

// 自動テスト用(?debug を付けたときだけ): 置けるマスの1つ目の画面座標を返す
if (new URLSearchParams(location.search).has('debug')) {
  window.__validFirst = () => {
    const sq = ui.valid && [...ui.valid.keys()][0];
    if (sq === undefined || sq === null) return null;
    const { x, y } = cellXY(sq);
    return { x: x + CW / 2, y: y + CH / 2 };
  };
}
