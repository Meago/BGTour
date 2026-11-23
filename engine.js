'use strict';

function otherSide(side) { return side === 'w' ? 'b' : 'w'; }

function initialBoard() {
  const points = Array.from({ length: 24 }, () => ({ w: 0, b: 0 }));
  // Standard 15-checker position, White moves toward point 1, Black toward point 24.
  points[23].w = 2; points[12].w = 5; points[7].w = 3; points[5].w = 5;
  points[0].b = 2; points[11].b = 5; points[16].b = 3; points[18].b = 5;
  return { points, bar: { w: 0, b: 0 }, off: { w: 0, b: 0 } };
}

function copyBoard(board) {
  return {
    points: board.points.map(point => ({ w: point.w, b: point.b })),
    bar: { w: board.bar.w, b: board.bar.b },
    off: { w: board.off.w, b: board.off.b }
  };
}

function allHome(board, side) {
  if (board.bar[side] > 0) return false;
  for (let point = 0; point < 24; point++) {
    const outsideHome = side === 'w' ? point >= 6 : point < 18;
    if (outsideHome && board.points[point][side] > 0) return false;
  }
  return true;
}

function legalMovesForDie(board, side, die) {
  const enemy = otherSide(side);
  const moves = [];
  const addMove = (from, to) => {
    if (to !== 'off' && board.points[to][enemy] >= 2) return;
    moves.push({ from, to, die });
  };

  // A checker on the bar has priority over every other checker.
  if (board.bar[side] > 0) {
    const to = side === 'w' ? 24 - die : die - 1;
    if (to >= 0 && to < 24) addMove('bar', to);
    return moves;
  }

  const bearingOff = allHome(board, side);
  for (let from = 0; from < 24; from++) {
    if (!board.points[from][side]) continue;
    const to = side === 'w' ? from - die : from + die;
    if (to >= 0 && to < 24) {
      addMove(from, to);
      continue;
    }
    if (!bearingOff) continue;

    if (side === 'w' && to < 0) {
      const exact = die === from + 1;
      const overshoot = die > from + 1 && !board.points.slice(from + 1).some(point => point.w > 0);
      if (exact || overshoot) addMove(from, 'off');
    } else if (side === 'b' && to >= 24) {
      const exact = die === 24 - from;
      const overshoot = die > 24 - from && !board.points.slice(0, from).some(point => point.b > 0);
      if (exact || overshoot) addMove(from, 'off');
    }
  }
  return moves;
}

function removeDie(dice, index) { return dice.slice(0, index).concat(dice.slice(index + 1)); }

function generateLegalSequences(board, side, dice) {
  const results = [];
  function walk(position, remaining, path) {
    if (!remaining.length) {
      results.push(path);
      return;
    }
    let canPlay = false;
    const tried = new Set();
    for (let index = 0; index < remaining.length; index++) {
      const die = remaining[index];
      if (tried.has(die)) continue;
      tried.add(die);
      const moves = legalMovesForDie(position, side, die);
      if (!moves.length) continue;
      canPlay = true;
      for (const move of moves) {
        const next = copyBoard(position);
        applyBoardMove(next, side, move);
        walk(next, removeDie(remaining, index), path.concat([{ ...move }]));
      }
    }
    if (!canPlay) results.push(path);
  }

  walk(copyBoard(board), dice.slice(), []);
  if (!results.length) return [[]];
  const maximumMoves = Math.max(...results.map(path => path.length));
  let best = results.filter(path => path.length === maximumMoves);
  const distinctDice = [...new Set(dice)].sort((a, b) => a - b);
  // If just one of two different dice can be used, play the higher one when possible.
  if (maximumMoves === 1 && distinctDice.length === 2) {
    const highDie = distinctDice[1];
    if (best.some(path => path.some(move => move.die === highDie))) {
      best = best.filter(path => path.some(move => move.die === highDie));
    }
  }
  const seen = new Set();
  return best.filter(path => {
    const key = path.map(move => `${move.from}>${move.to}:${move.die}`).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyBoardMove(board, side, move) {
  const enemy = otherSide(side);
  if (move.from === 'bar') board.bar[side]--;
  else board.points[move.from][side]--;
  if (move.to === 'off') {
    board.off[side]++;
    return { hit: false, bearOff: true };
  }
  let hit = false;
  if (board.points[move.to][enemy] === 1) {
    board.points[move.to][enemy] = 0;
    board.bar[enemy]++;
    hit = true;
  }
  board.points[move.to][side]++;
  return { hit, bearOff: false };
}

function rollPair() { return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]; }
function expandDice(dice) { return dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : dice.slice(); }
function nextMoves(game) { return (game.candidates || []).filter(path => path.length).map(path => path[0]); }

function createGame(match, timePerPlayerSec = 0) {
  return {
    matchId: match.id,
    whiteId: match.p1,
    blackId: match.p2,
    board: initialBoard(),
    turn: null,
    opening: true,
    rolled: false,
    diceShown: [],
    moveDice: [],
    candidates: [],
    turnMaxMoves: 0,
    movesPlayed: 0,
    selected: null,
    undoStack: [],
    moveLog: [],
    message: 'הטילו קובייה אחת כל אחד. התוצאה הגבוהה פותחת ומשחקת בשתי הקוביות.',
    timePerPlayerSec: Number(timePerPlayerSec) || 0,
    clock: { w: Number(timePerPlayerSec) || 0, b: Number(timePerPlayerSec) || 0 },
    clockStartedAt: null,
    over: false,
    winnerId: null,
    finalScore: null,
    lastMove: null,
    createdAt: Date.now()
  };
}

function setDice(game, side, dice) {
  game.turn = side;
  game.rolled = true;
  game.diceShown = dice.slice();
  game.moveDice = expandDice(dice);
  game.candidates = generateLegalSequences(game.board, side, game.moveDice);
  game.turnMaxMoves = game.candidates.length ? game.candidates[0].length : 0;
  game.movesPlayed = 0;
  game.selected = null;
  game.undoStack = [];
  return game.turnMaxMoves;
}

function endTurn(game, side) {
  game.turn = otherSide(side);
  game.rolled = false;
  game.diceShown = [];
  game.moveDice = [];
  game.candidates = [];
  game.turnMaxMoves = 0;
  game.movesPlayed = 0;
  game.selected = null;
  game.undoStack = [];
}

function gameMultiplier(board, winner) {
  const loser = otherSide(winner);
  if (board.off[loser] > 0) return 1;
  const winnerHome = winner === 'w' ? [0, 1, 2, 3, 4, 5] : [18, 19, 20, 21, 22, 23];
  const trapped = board.bar[loser] > 0 || winnerHome.some(point => board.points[point][loser] > 0);
  return trapped ? 3 : 2;
}

function pipCount(board, side) {
  let count = board.bar[side] * 25;
  board.points.forEach((point, index) => { count += point[side] * (side === 'w' ? index + 1 : 24 - index); });
  return count;
}

module.exports = {
  otherSide, initialBoard, copyBoard, allHome, legalMovesForDie, generateLegalSequences,
  applyBoardMove, rollPair, expandDice, nextMoves, createGame, setDice, endTurn,
  gameMultiplier, pipCount
};
