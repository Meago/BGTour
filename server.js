'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('./engine');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tournaments.json');
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY = 64 * 1024;
const rooms = new Map();
const streams = new Map();

function readDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of parsed.rooms || []) {
      try {
        const tournament = room.tournament;
        if (!tournament) continue;
        if (!tournament.settings) {
          tournament.settings = cleanSettings({ rounds: tournament.totalRounds || 5, timePerPlayerSec: 0 });
        } else {
          tournament.settings = cleanSettings(tournament.settings);
        }
        tournament.totalRounds = tournament.settings.unlimitedRounds ? null : tournament.settings.rounds;
        if (tournament.status === 'complete' && !tournament.finishReason) tournament.finishReason = 'schedule';
        room.games ||= {};
        room.seats ||= {};
        room.revision ||= 1;
        for (const game of Object.values(room.games)) {
          game.timePerPlayerSec = Number(game.timePerPlayerSec ?? tournament.settings.timePerPlayerSec) || 0;
          game.clock ||= { w: game.timePerPlayerSec, b: game.timePerPlayerSec };
          if (game.clockStartedAt && !game.over && game.turn) {
            const cutoff = room.updatedAt || Date.now();
            game.clock[game.turn] = remainingClock(game, game.turn, cutoff);
          }
          // Preserve the saved balance, but do not charge time while the server is offline.
          game.clockStartedAt = !game.over && game.timePerPlayerSec && game.turn ? Date.now() : null;
          delete game.pendingDouble;
          delete game.cube;
        }
        if (Date.now() - (room.updatedAt || room.createdAt || Date.now()) < 1000 * 60 * 60 * 24 * 21) {
          rooms.set(tournament.code, room);
        }
      } catch (error) {
        console.error('Skipping an invalid saved tournament:', error.message);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read saved tournaments:', error.message);
  }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, rooms: [...rooms.values()] }));
    fs.renameSync(temp, DATA_FILE);
  } catch (error) {
    console.error('Could not save tournaments:', error.message);
  }
}
function normalizeCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function makeCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += alphabet[crypto.randomInt(alphabet.length)];
    code = `PIP-${suffix}`;
  } while (rooms.has(code));
  return code;
}
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function safeName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}
function safeTournamentName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 34) || 'Backgammon Night';
}
function makePlayer(name, isHost = false) {
  return {
    id: crypto.randomUUID(), name, elo: 1200, wins: 0, losses: 0, points: 0,
    opponents: [], byes: 0, isHost
  };
}
function getRoom(code) {
  const normalized = normalizeCode(code);
  for (const room of rooms.values()) if (normalizeCode(room.tournament.code) === normalized) return room;
  return null;
}
function playerForToken(room, token) {
  if (!room || !token) return null;
  const playerId = room.seats[tokenHash(token)];
  return playerId ? room.tournament.players.find(player => player.id === playerId) || null : null;
}
function requireSeat(room, token) {
  const player = playerForToken(room, token);
  if (!player) throw httpError(401, 'המושב הזה לא מזוהה. אפשר להצטרף מחדש ללובי עם השם שלך.');
  return player;
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function findMatch(room, matchId) {
  for (const round of room.tournament.rounds) {
    const match = round.matches.find(item => item.id === matchId);
    if (match) return match;
  }
  return null;
}
function currentRound(tournament) { return tournament.rounds[tournament.rounds.length - 1] || null; }
function playerById(tournament, id) { return tournament.players.find(player => player.id === id) || null; }
function sideForPlayer(game, playerId) {
  if (game.whiteId === playerId) return 'w';
  if (game.blackId === playerId) return 'b';
  return null;
}
function currentPlayerId(game) { return game.turn === 'w' ? game.whiteId : game.turn === 'b' ? game.blackId : null; }

function rankPlayers(tournament) {
  function buchholz(player) {
    return (player.opponents || []).reduce((sum, opponentId) => sum + (playerById(tournament, opponentId)?.points || 0), 0);
  }
  return [...tournament.players].sort((a, b) => {
    if (tournament.finishReason === 'host-early') {
      return b.points - a.points || b.elo - a.elo || buchholz(b) - buchholz(a) || b.wins - a.wins || a.name.localeCompare(b.name);
    }
    return b.points - a.points || b.wins - a.wins || buchholz(b) - buchholz(a) || b.elo - a.elo || a.name.localeCompare(b.name);
  });
}
const TIME_PRESETS = new Set([0, 60, 180, 300, 600, 900, 1800]);
function cleanSettings(input = {}) {
  const unlimitedRounds = input.unlimitedRounds === true || input.rounds === 'unlimited';
  const rounds = unlimitedRounds ? null : Number(input.rounds ?? 5);
  const timePerPlayerSec = Number(input.timePerPlayerSec ?? 0);
  if (!unlimitedRounds && (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000)) {
    throw httpError(400, 'יש לבחור בין סיבוב אחד ל־1,000 סיבובים, או לבחור במספר סיבובים ללא הגבלה.');
  }
  if (!TIME_PRESETS.has(timePerPlayerSec)) throw httpError(400, 'יש לבחור אחת מאפשרויות הזמן הקבועות לכל שחקן.');
  return { rounds, unlimitedRounds, timePerPlayerSec };
}
function pairCost(a, b) {
  return Math.abs(a.points - b.points) * 100 + Math.abs(a.elo - b.elo) * 0.05 + Math.random() * 0.01;
}
function makeRound(room) {
  const tournament = room.tournament;
  const number = tournament.rounds.length + 1;
  let pool = rankPlayers(tournament);
  let bye = null;
  if (pool.length % 2) {
    const byeCandidates = [...pool].sort((a, b) => a.byes - b.byes || a.points - b.points || a.elo - b.elo);
    bye = byeCandidates[0];
    pool = pool.filter(player => player.id !== bye.id);
  }

  const pairs = [];
  while (pool.length) {
    const first = pool.shift();
    let candidates = pool.filter(player => !first.opponents.includes(player.id));
    if (!candidates.length) candidates = pool;
    candidates.sort((a, b) => pairCost(first, a) - pairCost(first, b));
    const second = candidates[0];
    pool = pool.filter(player => player.id !== second.id);
    pairs.push([first, second]);
  }

  const matches = pairs.map(([a, b], index) => {
    a.opponents.push(b.id); b.opponents.push(a.id);
    const match = { id: `r${number}t${index + 1}`, round: number, table: index + 1, p1: a.id, p2: b.id, status: 'live', result: null };
    room.games[match.id] = engine.createGame(match, tournament.settings.timePerPlayerSec);
    return match;
  });
  if (bye) {
    bye.byes++;
    bye.points += 0.5;
    matches.push({
      id: `r${number}t${matches.length + 1}`, round: number, table: matches.length + 1,
      p1: bye.id, p2: null, status: 'complete', result: { bye: true, points: 0.5 }
    });
  }
  tournament.rounds.push({ number, matches });
  tournament.currentRound = number;
  tournament.status = 'live';
  return tournament.rounds[tournament.rounds.length - 1];
}
function updateElo(a, b, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
  const change = Math.round(24 * (scoreA - expectedA));
  a.elo += change;
  b.elo -= change;
}
function remainingClock(game, side, now = Date.now()) {
  if (!game.timePerPlayerSec) return null;
  const saved = Number(game.clock?.[side] ?? game.timePerPlayerSec);
  if (game.over || game.turn !== side || !game.clockStartedAt) return Math.max(0, saved);
  return Math.max(0, saved - Math.max(0, now - game.clockStartedAt) / 1000);
}
function settleClock(game) {
  if (!game.timePerPlayerSec || !game.turn || !game.clockStartedAt) return;
  game.clock[game.turn] = remainingClock(game, game.turn);
  game.clockStartedAt = null;
}
function startClock(game) { game.clockStartedAt = game.timePerPlayerSec ? Date.now() : null; }
function switchTurn(game, side) {
  settleClock(game);
  engine.endTurn(game, side);
  startClock(game);
}
function expireGame(room, match, game) {
  if (!match || match.status !== 'live' || !game || game.over || !game.timePerPlayerSec || !game.clockStartedAt || !game.turn) return false;
  const loserSide = game.turn;
  if (remainingClock(game, loserSide) > 0) return false;
  const loser = playerById(room.tournament, currentPlayerId(game));
  game.clock[loserSide] = 0;
  game.clockStartedAt = null;
  finishMatch(room, match, game, engine.otherSide(loserSide), 1, 'time');
  game.message = `${loser?.name || 'השחקן'} אזל הזמן. ${playerById(room.tournament, game.winnerId)?.name || 'היריב'} ניצח/ה.`;
  return true;
}
function tickClocks() {
  for (const room of rooms.values()) {
    let changed = false;
    for (const [matchId, game] of Object.entries(room.games)) {
      const match = findMatch(room, matchId);
      if (expireGame(room, match, game)) changed = true;
    }
    if (changed) commit(room);
  }
}
function finishMatch(room, match, game, winnerSide, scorePoints, reason) {
  if (match.status === 'complete' || match.status === 'void') return;
  settleClock(game);
  game.clockStartedAt = null;
  const winnerId = winnerSide === 'w' ? game.whiteId : game.blackId;
  const loserId = winnerSide === 'w' ? game.blackId : game.whiteId;
  const winner = playerById(room.tournament, winnerId);
  const loser = playerById(room.tournament, loserId);
  if (!winner || !loser) throw httpError(500, 'לא ניתן למצוא את שחקני השולחן.');
  winner.wins++;
  winner.points += 1;
  loser.losses++;
  updateElo(winner, loser, 1);
  const multiplier = Math.max(1, Math.round(scorePoints));
  const finalScorePoints = reason === 'time' ? 1 : multiplier;
  match.status = 'complete';
  match.result = { winnerId, loserId, scorePoints: finalScorePoints, multiplier: finalScorePoints, reason, at: Date.now() };
  game.over = true;
  game.winnerId = winnerId;
  game.finalScore = { scorePoints: finalScorePoints, multiplier: finalScorePoints, reason };
  game.message = reason === 'time'
    ? `${winner.name} ניצח/ה בניצחון על זמן.`
    : `${winner.name} ניצח/ה במשחק · ${finalScorePoints} ${finalScorePoints === 1 ? 'נקודה' : 'נקודות'} בשש-בש.`;
  const round = currentRound(room.tournament);
  if (round && round.matches.every(item => item.status === 'complete') && !room.tournament.settings.unlimitedRounds && room.tournament.currentRound >= room.tournament.totalRounds) {
    room.tournament.status = 'complete';
    room.tournament.finishReason = 'schedule';
    room.tournament.completedAt = Date.now();
  }
}
function gameForSeat(room, matchId, playerId) {
  const match = findMatch(room, matchId);
  const game = room.games[matchId];
  if (!match || !game || !match.p2 || match.status !== 'live') throw httpError(404, 'השולחן הזה אינו פעיל.');
  if (match.p1 !== playerId && match.p2 !== playerId) throw httpError(403, 'אינך יושב/ת בשולחן הזה.');
  if (expireGame(room, match, game)) { commit(room); throw httpError(409, 'הזמן שלך אזל והתוצאה נרשמה.'); }
  if (game.over) throw httpError(409, 'המשחק הזה כבר הסתיים.');
  return { match, game };
}
function assertTurn(game, playerId) {
  if (currentPlayerId(game) !== playerId) throw httpError(403, 'זה לא התור שלך בשולחן הזה.');
}
function pushUndo(game) {
  game.undoStack.push({
    board: engine.copyBoard(game.board),
    candidates: game.candidates.map(path => path.map(move => ({ ...move }))),
    movesPlayed: game.movesPlayed,
    moveLogLength: game.moveLog.length,
    message: game.message
  });
}
function formatMove(from, to) {
  const source = from === 'bar' ? 'בר' : String(Number(from) + 1);
  const destination = to === 'off' ? 'מחוץ ללוח' : String(Number(to) + 1);
  return `${source}/${destination}`;
}
function handleNoMoves(room, game, side) {
  const player = playerById(room.tournament, side === 'w' ? game.whiteId : game.blackId);
  game.message = `${player?.name || 'השחקן/ית'} לא יכול/ה לבצע מהלך חוקי. התור עובר.`;
  game.lastMove = { type: 'pass', playerId: player?.id, at: Date.now() };
  switchTurn(game, side);
}
function prepareDice(room, game, side, dice) {
  const total = engine.setDice(game, side, dice);
  if (game.timePerPlayerSec && !game.clockStartedAt) startClock(game);
  if (!total) handleNoMoves(room, game, side);
  else {
    const player = playerById(room.tournament, side === 'w' ? game.whiteId : game.blackId);
    game.message = `${player?.name || 'השחקן/ית'} הטיל/ה ${dice[0]} ו־${dice[1]}.`;
  }
  return total;
}
function rollGame(room, game, playerId) {
  if (game.over) throw httpError(409, 'השולחן אינו זמין להטלה.');
  if (game.opening) {
    if (game.rolled) throw httpError(409, 'ההטלה הפותחת כבר בוצעה.');
    let [white, black] = engine.rollPair();
    while (white === black) [white, black] = engine.rollPair();
    game.opening = false;
    const startingSide = white > black ? 'w' : 'b';
    const starter = playerById(room.tournament, startingSide === 'w' ? game.whiteId : game.blackId);
    game.message = `הטלה פותחת: ${white}–${black}. ${starter?.name || 'השחקן/ית'} מתחיל/ה.`;
    game.lastRoll = { white, black, opening: true };
    prepareDice(room, game, startingSide, [white, black]);
    if (!game.turnMaxMoves) game.message = `ל${starter?.name || 'השחקן/ית'} אין מהלך חוקי בפתיחה. התור עובר.`;
    return;
  }
  assertTurn(game, playerId);
  if (game.rolled) throw httpError(409, 'כבר הטלת קוביות בתור הזה.');
  const dice = engine.rollPair();
  game.lastRoll = { dice: dice.slice(), opening: false };
  const player = playerById(room.tournament, playerId);
  game.message = `${player?.name || 'השחקן/ית'} הטיל/ה ${dice[0]} ו־${dice[1]}.`;
  prepareDice(room, game, game.turn, dice);
}
function moveGame(room, match, game, playerId, payload) {
  assertTurn(game, playerId);
  if (!game.rolled) throw httpError(409, 'יש להטיל קוביות לפני שמזיזים כלי.');
  const from = payload.from === 'bar' ? 'bar' : Number(payload.from);
  const to = payload.to === 'off' ? 'off' : Number(payload.to);
  if ((from !== 'bar' && (!Number.isInteger(from) || from < 0 || from > 23)) || (to !== 'off' && (!Number.isInteger(to) || to < 0 || to > 23))) {
    throw httpError(400, 'המהלך אינו תקין.');
  }
  const legal = engine.nextMoves(game);
  const matches = legal.filter(move => String(move.from) === String(from) && String(move.to) === String(to));
  if (!matches.length) throw httpError(400, 'המהלך אינו חוקי לפי תוצאת הקוביות.');
  const matchingPaths = game.candidates.filter(path => path.length && String(path[0].from) === String(from) && String(path[0].to) === String(to));
  if (!matchingPaths.length) throw httpError(400, 'המהלך יפר את רצף המהלכים החוקי.');

  pushUndo(game);
  const side = game.turn;
  const selectedMove = matches[0];
  game.candidates = matchingPaths.map(path => path.slice(1));
  const effect = engine.applyBoardMove(game.board, side, selectedMove);
  game.movesPlayed++;
  const player = playerById(room.tournament, playerId);
  const moveRecord = { playerId, name: player?.name || 'שחקן/ית', from, to, die: selectedMove.die, hit: effect.hit, at: Date.now() };
  game.moveLog.push(moveRecord);
  game.lastMove = moveRecord;
  if (effect.hit) game.message = `${player?.name || 'השחקן/ית'} פגע/ה בכלי בודד והחזיר/ה אותו לבר.`;
  else if (effect.bearOff) game.message = `${player?.name || 'השחקן/ית'} הוציא/ה כלי מנקודה ${from + 1}.`;
  else game.message = `${player?.name || 'השחקן/ית'} שיחק/ה ${formatMove(from, to)} בקובייה ${selectedMove.die}.`;

  if (game.board.off[side] === 15) {
    const multiplier = engine.gameMultiplier(game.board, side);
    finishMatch(room, match, game, side, multiplier, 'bear-off');
    return;
  }
  if (game.candidates.every(path => path.length === 0)) {
    switchTurn(game, side);
    game.message = `${player?.name || 'השחקן/ית'} סיים/ה את התור.`;
  }
}
function undoGame(room, game, playerId) {
  assertTurn(game, playerId);
  if (!game.rolled || !game.undoStack.length || game.over) throw httpError(409, 'אין מהלך שאפשר לבטל.');
  const snapshot = game.undoStack.pop();
  game.board = engine.copyBoard(snapshot.board);
  game.candidates = snapshot.candidates.map(path => path.map(move => ({ ...move })));
  game.movesPlayed = snapshot.movesPlayed;
  game.moveLog = game.moveLog.slice(0, snapshot.moveLogLength);
  game.message = snapshot.message;
  game.lastMove = game.moveLog[game.moveLog.length - 1] || null;
}
function publicGame(game, viewerId) {
  if (!game) return null;
  const side = sideForPlayer(game, viewerId);
  const canAct = !!side && game.turn === side && !game.over;
  const serverNow = Date.now();
  return {
    matchId: game.matchId, whiteId: game.whiteId, blackId: game.blackId,
    board: game.board, turn: game.turn, turnPlayerId: currentPlayerId(game), mySide: side,
    opening: game.opening, rolled: game.rolled, diceShown: game.diceShown,
    turnMaxMoves: game.turnMaxMoves, movesPlayed: game.movesPlayed,
    undoAvailable: canAct && game.rolled && game.undoStack.length > 0,
    legalMoves: side && game.turn === side && game.rolled && !game.over ? engine.nextMoves(game) : [],
    clockRemaining: { w: remainingClock(game, 'w', serverNow), b: remainingClock(game, 'b', serverNow) },
    timePerPlayerSec: game.timePerPlayerSec, clockRunning: !!game.clockStartedAt,
    serverNow, over: game.over, void: !!game.void,
    winnerId: game.winnerId, finalScore: game.finalScore, message: game.message,
    lastMove: game.lastMove, moveLog: (game.moveLog || []).slice(-12),
    lastRoll: game.lastRoll || null
  };
}
function snapshot(room, token) {
  const viewer = playerForToken(room, token);
  const games = {};
  for (const [matchId, game] of Object.entries(room.games)) games[matchId] = publicGame(game, viewer?.id || null);
  return { tournament: room.tournament, games, viewerId: viewer?.id || null, revision: room.revision, serverNow: Date.now() };
}
function broadcast(room) {
  const set = streams.get(room.tournament.code);
  if (!set) return;
  const event = `event: update\ndata: ${JSON.stringify({ revision: room.revision })}\n\n`;
  for (const response of [...set]) {
    try { response.write(event); } catch { set.delete(response); }
  }
}
function commit(room) {
  room.revision = (room.revision || 0) + 1;
  room.updatedAt = Date.now();
  persist();
  broadcast(room);
}
function makeRoom(name, hostName, settings = {}) {
  const code = makeCode();
  const host = makePlayer(hostName, true);
  const token = randomToken();
  const tournamentSettings = cleanSettings(settings);
  const tournament = {
    id: crypto.randomUUID(), code, name: safeTournamentName(name), status: 'lobby',
    format: 'Swiss-style', totalRounds: tournamentSettings.unlimitedRounds ? null : tournamentSettings.rounds, currentRound: 0, createdAt: Date.now(),
    settings: tournamentSettings, hostId: host.id,
    players: [host], rounds: []
  };
  const room = { tournament, games: {}, seats: { [tokenHash(token)]: host.id }, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
  rooms.set(code, room);
  persist();
  return { room, token, playerId: host.id };
}
function addSeat(room, name) {
  if (room.tournament.status !== 'lobby') throw httpError(409, 'הטורניר כבר התחיל. בקשו מהמארח/ת לפתוח חדר חדש.');
  if (room.tournament.players.some(player => player.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'השם הזה כבר תפוס בלובי. יש לבחור שם אחר.');
  const player = makePlayer(name, false);
  const token = randomToken();
  room.tournament.players.push(player);
  room.seats[tokenHash(token)] = player.id;
  commit(room);
  return { player, token };
}
function startTournament(room) {
  if (room.tournament.status !== 'lobby') throw httpError(409, 'הטורניר כבר התחיל.');
  if (room.tournament.players.length < 2) throw httpError(409, 'כדי להתחיל צריך לפחות שני שחקנים.');
  for (const player of room.tournament.players) {
    // Ratings belong to this tournament only; every event starts from the same baseline.
    player.elo = 1200; player.wins = 0; player.losses = 0; player.points = 0;
    player.opponents = []; player.byes = 0;
  }
  room.tournament.totalRounds = room.tournament.settings.unlimitedRounds ? null : room.tournament.settings.rounds;
  room.tournament.rounds = [];
  room.tournament.currentRound = 0;
  room.tournament.finishReason = null;
  room.tournament.completedAt = null;
  room.games = {};
  makeRound(room);
}
function nextRound(room) {
  const tournament = room.tournament;
  if (tournament.status !== 'live') throw httpError(409, 'הטורניר אינו מאפשר פתיחת סיבוב חדש.');
  const round = currentRound(tournament);
  if (!round || round.matches.some(match => match.status !== 'complete')) throw httpError(409, 'כל המשחקים בסיבוב הנוכחי צריכים להסתיים קודם.');
  if (!tournament.settings.unlimitedRounds && tournament.currentRound >= tournament.totalRounds) {
    tournament.status = 'complete'; tournament.finishReason = 'schedule'; tournament.completedAt = Date.now();
    return;
  }
  makeRound(room);
}
function updateSettings(room, settings) {
  if (room.tournament.status !== 'lobby') throw httpError(409, 'הגדרות הטורניר ננעלות אחרי תחילת הסיבוב הראשון.');
  room.tournament.settings = cleanSettings(settings);
  room.tournament.totalRounds = room.tournament.settings.unlimitedRounds ? null : room.tournament.settings.rounds;
}
function finishTournament(room) {
  const tournament = room.tournament;
  if (!['lobby', 'live'].includes(tournament.status)) throw httpError(409, 'אפשר לסיים טורניר פתוח בלבד.');
  // Resolve any clock that had already expired before the host's finish request.
  if (tournament.status === 'live') {
    for (const round of tournament.rounds) {
      for (const match of round.matches) {
        if (match.status === 'live') expireGame(room, match, room.games[match.id]);
      }
    }
  }
  if (tournament.status !== 'live' && tournament.status !== 'lobby') return;
  let voidedGames = 0;
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.status !== 'live') continue;
      match.status = 'void'; match.result = { void: true, reason: 'host-ended', at: Date.now() };
      const game = room.games[match.id];
      if (game) {
        settleClock(game);
        game.over = true; game.void = true; game.winnerId = null; game.finalScore = null;
        game.clockStartedAt = null;
        game.message = 'המארח/ת סיים/ה את הטורניר. המשחק הלא גמור בוטל ואינו משפיע על הנקודות או על הדירוג.';
      }
      voidedGames++;
    }
  }
  tournament.status = 'complete';
  tournament.finishReason = 'host-early';
  tournament.completedAt = Date.now();
  tournament.earlyFinishSummary = {
    voidedGames,
    completedTables: tournament.rounds.flatMap(round => round.matches).filter(match => match.status === 'complete' && match.p2).length,
    roundsStarted: tournament.currentRound
  };
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(httpError(413, 'הבקשה גדולה מדי.')); request.destroy(); }
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(httpError(400, 'גוף הבקשה חייב להיות JSON תקין.')); }
    });
    request.on('error', reject);
  });
}
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(payload);
}
function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8', '.ico':'image/x-icon' })[ext] || 'application/octet-stream';
}
function serveStatic(request, response, urlPath) {
  let requested = decodeURIComponent(urlPath.split('?')[0]);
  if (requested === '/') requested = '/index.html';
  const allowed = new Set(['/index.html', '/styles.css', '/app.js']);
  if (!allowed.has(requested)) { response.writeHead(404); response.end('Not found'); return; }
  const file = path.join(ROOT, requested.slice(1));
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff' });
    if (request.method === 'HEAD') response.end(); else response.end(data);
  });
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'pip-and-crown', rooms: rooms.size });

  if (request.method === 'POST' && url.pathname === '/api/tournaments') {
    const body = await readBody(request);
    const hostName = safeName(body.hostName);
    if (!hostName) throw httpError(400, 'נא להזין את שם המארח/ת.');
    const { room, token, playerId } = makeRoom(body.name, hostName, body.settings || {});
    return sendJson(response, 201, { ...snapshot(room, token), token, playerId });
  }

  if (parts[0] !== 'api' || parts[1] !== 'tournaments' || !parts[2]) throw httpError(404, 'נתיב ה־API לא נמצא.');
  const room = getRoom(parts[2]);
  if (!room) throw httpError(404, 'חדר הטורניר לא נמצא. כדאי לבדוק את הקוד עם המארח/ת.');
  const code = room.tournament.code;
  const token = url.searchParams.get('token') || request.headers['x-seat-token'] || '';

  if (parts.length === 3 && request.method === 'GET') return sendJson(response, 200, snapshot(room, token));
  if (parts[3] === 'events' && request.method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(`event: update\ndata: ${JSON.stringify({ revision: room.revision })}\n\n`);
    let set = streams.get(code);
    if (!set) streams.set(code, set = new Set());
    set.add(response);
    const heartbeat = setInterval(() => { try { response.write(': ping\n\n'); } catch {} }, 25000);
    request.on('close', () => { clearInterval(heartbeat); set.delete(response); if (!set.size) streams.delete(code); });
    return;
  }
  if (parts[3] === 'join' && parts.length === 4 && request.method === 'POST') {
    const body = await readBody(request);
    const name = safeName(body.name);
    if (!name) throw httpError(400, 'נא להזין את השם שיופיע בטבלה.');
    const joined = addSeat(room, name);
    return sendJson(response, 201, { ...snapshot(room, joined.token), token: joined.token, playerId: joined.player.id });
  }
  if (request.method !== 'POST') throw httpError(405, 'השיטה הזו אינה מורשית.');
  const body = await readBody(request);
  const actor = requireSeat(room, body.token || token || request.headers['x-seat-token']);

  if (parts[3] === 'settings' && parts.length === 4) {
    if (actor.id !== room.tournament.hostId) throw httpError(403, 'רק המארח/ת יכול/ה לשנות את הגדרות הטורניר.');
    updateSettings(room, body.settings || body); commit(room);
    return sendJson(response, 200, snapshot(room, body.token || token));
  }
  if (parts[3] === 'start' && parts.length === 4) {
    if (actor.id !== room.tournament.hostId) throw httpError(403, 'רק המארח/ת יכול/ה להתחיל את הטורניר.');
    startTournament(room); commit(room);
    return sendJson(response, 200, snapshot(room, body.token || token));
  }
  if (parts[3] === 'finish' && parts.length === 4) {
    if (actor.id !== room.tournament.hostId) throw httpError(403, 'רק המארח/ת יכול/ה לסיים את הטורניר.');
    finishTournament(room); commit(room);
    return sendJson(response, 200, snapshot(room, body.token || token));
  }
  if (parts[3] === 'round' && parts[4] === 'next' && parts.length === 5) {
    if (actor.id !== room.tournament.hostId) throw httpError(403, 'רק המארח/ת יכול/ה לפתוח את הסיבוב הבא.');
    nextRound(room); commit(room);
    return sendJson(response, 200, snapshot(room, body.token || token));
  }
  if (parts[3] === 'matches' && parts[4]) {
    const matchId = parts[4];
    const { match, game } = gameForSeat(room, matchId, actor.id);
    const action = parts[5];
    if (action === 'roll' && parts.length === 6) {
      rollGame(room, game, actor.id); commit(room);
      return sendJson(response, 200, snapshot(room, body.token || token));
    }
    if (action === 'move' && parts.length === 6) {
      moveGame(room, match, game, actor.id, body); commit(room);
      return sendJson(response, 200, snapshot(room, body.token || token));
    }
    if (action === 'undo' && parts.length === 6) {
      undoGame(room, game, actor.id); commit(room);
      return sendJson(response, 200, snapshot(room, body.token || token));
    }
  }
  throw httpError(404, 'נתיב ה־API לא נמצא.');
}

readDatabase();
const clockTicker = setInterval(tickClocks, 250);
clockTicker.unref();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405); response.end('Method not allowed'); return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    sendJson(response, error.status || 500, { error: error.status ? error.message : 'אירעה שגיאה בלתי צפויה בשרת.' });
    if (!error.status) console.error(error.stack || error);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pip & Crown listening on http://0.0.0.0:${PORT}`);
  console.log('Tournament Elo is room-scoped; no accounts are created.');
});
