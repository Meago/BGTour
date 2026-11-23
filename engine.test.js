'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./engine');

function emptyBoard() {
  return { points: Array.from({ length: 24 }, () => ({ w: 0, b: 0 })), bar: { w: 0, b: 0 }, off: { w: 0, b: 0 } };
}
function total(board, side) {
  return board.points.reduce((sum, point) => sum + point[side], 0) + board.bar[side] + board.off[side];
}

test('standard opening position has fifteen checkers and 167 pips per side', () => {
  const board = engine.initialBoard();
  assert.equal(total(board, 'w'), 15);
  assert.equal(total(board, 'b'), 15);
  assert.equal(engine.pipCount(board, 'w'), 167);
  assert.equal(engine.pipCount(board, 'b'), 167);
});

test('all generated starting-roll sequences are legal and use the maximum dice', () => {
  const board = engine.initialBoard();
  for (const side of ['w', 'b']) {
    for (let first = 1; first <= 6; first++) {
      for (let second = 1; second <= 6; second++) {
        const dice = first === second ? [first, first, first, first] : [first, second];
        const paths = engine.generateLegalSequences(board, side, dice);
        const max = Math.max(...paths.map(path => path.length));
        for (const path of paths) {
          assert.equal(path.length, max);
          const next = engine.copyBoard(board);
          for (const move of path) {
            assert.ok(engine.legalMovesForDie(next, side, move.die).some(candidate =>
              String(candidate.from) === String(move.from) && String(candidate.to) === String(move.to)
            ));
            engine.applyBoardMove(next, side, move);
          }
          assert.equal(total(next, side), 15);
          assert.equal(total(next, engine.otherSide(side)), 15);
        }
      }
    }
  }
});

test('when only one die can be used, the higher die takes precedence', () => {
  const board = emptyBoard();
  board.points[5].w = 1; board.off.w = 14;
  board.points[4].b = 2; board.points[2].b = 2;
  const paths = engine.generateLegalSequences(board, 'w', [1, 2]);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].length, 1);
  assert.equal(paths[0][0].die, 2);
});

test('bar entry is forced and a blot is hit onto the bar', () => {
  const board = emptyBoard();
  board.bar.w = 1; board.off.w = 14; board.points[23].b = 2;
  const paths = engine.generateLegalSequences(board, 'w', [1, 2]);
  assert.equal(paths[0][0].from, 'bar');
  assert.equal(paths[0][0].to, 22);

  const hitBoard = emptyBoard();
  hitBoard.points[11].w = 1; hitBoard.points[10].b = 1;
  const result = engine.applyBoardMove(hitBoard, 'w', { from: 11, to: 10, die: 1 });
  assert.equal(result.hit, true);
  assert.equal(hitBoard.points[10].w, 1);
  assert.equal(hitBoard.points[10].b, 0);
  assert.equal(hitBoard.bar.b, 1);
});

test('bearing off requires a home board and overshoots only from the farthest checker', () => {
  const board = emptyBoard();
  board.off.w = 13; board.points[2].w = 1; board.points[4].w = 1;
  assert.equal(engine.allHome(board, 'w'), true);
  const sixes = engine.legalMovesForDie(board, 'w', 6);
  assert.deepEqual(sixes.map(move => [move.from, move.to]), [[4, 'off']]);
  assert.ok(engine.legalMovesForDie(board, 'w', 3).some(move => move.from === 2 && move.to === 'off'));
  board.points[8].w = 1;
  assert.equal(engine.allHome(board, 'w'), false);
  assert.ok(!engine.legalMovesForDie(board, 'w', 3).some(move => move.from === 2 && move.to === 'off'));
});

test('doubles can create four moves; gammon and backgammon multipliers are correct', () => {
  const board = emptyBoard();
  board.points[10].w = 1; board.off.w = 14;
  const paths = engine.generateLegalSequences(board, 'w', [1, 1, 1, 1]);
  assert.equal(paths[0].length, 4);

  const scoreBoard = emptyBoard();
  scoreBoard.off.w = 15;
  assert.equal(engine.gameMultiplier(scoreBoard, 'w'), 2);
  scoreBoard.points[3].b = 1;
  assert.equal(engine.gameMultiplier(scoreBoard, 'w'), 3);
  scoreBoard.points[3].b = 0; scoreBoard.bar.b = 1;
  assert.equal(engine.gameMultiplier(scoreBoard, 'w'), 3);
  scoreBoard.bar.b = 0; scoreBoard.off.b = 1;
  assert.equal(engine.gameMultiplier(scoreBoard, 'w'), 1);
});
