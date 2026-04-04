const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));

// Load Categories
let categories = JSON.parse(fs.readFileSync('./categories.json', 'utf8'));
fs.watchFile('./categories.json', () => {
    try { categories = JSON.parse(fs.readFileSync('./categories.json', 'utf8')); } catch (e) { console.log("JSON Error."); }
});

let gameRooms = {};

function generateCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function calculateScores(code) {
    const room = gameRooms[code];
    if (!room) return;
    let bestGuessDiff = 999;
    const giver = room.players[room.gameState.giverIndex];
    room.players.forEach(p => p.lastGain = 0);

    Object.keys(room.gameState.guesses).forEach(id => {
        const diff = Math.abs(room.gameState.targetValue - room.gameState.guesses[id].angle);
        if (diff < bestGuessDiff) bestGuessDiff = diff;
        let pts = 0;
        if (diff <= 4) pts = 3; else if (diff <= 12) pts = 2; else if (diff <= 20) pts = 1;
        const p = room.players.find(pl => pl.id === id);
        if (p) { p.score += pts; p.lastGain = pts; }
    });

    if (giver) {
        let giverPts = 0;
        if (bestGuessDiff <= 4) giverPts = 3; else if (bestGuessDiff <= 12) giverPts = 2; else if (bestGuessDiff <= 20) giverPts = 1;
        giver.score += giverPts; giver.lastGain = giverPts;
    }
}

function startNewRound(code) {
    const room = gameRooms[code];
    if (!room || room.players.length === 0) return;

    room.gameState.guesses = {};
    room.gameState.clue = "";
    room.gameState.targetValue = Math.floor(Math.random() * 160) + 10;
    room.gameState.category = categories[Math.floor(Math.random() * categories.length)];
    
    room.players.forEach(p => { p.lastGain = 0; p.role = 'Guesser'; p.isSpectator = false; });
    if (room.gameState.giverIndex >= room.players.length) room.gameState.giverIndex = 0;
    const currentGiver = room.players[room.gameState.giverIndex];
    currentGiver.role = 'Giver';

    room.players.forEach(p => io.to(p.id).emit('assigned-role', p.role));
    io.to(code).emit('game-transition', { 
        category: room.gameState.category, 
        round: room.gameState.currentRound,
        totalRounds: room.gameState.maxRounds,
        players: room.players,
        gameStarted: true
    });
    io.to(currentGiver.id).emit('secret-target', room.gameState.targetValue);
}

io.on('connection', (socket) => {
    socket.on('create-room', (username) => {
        const code = generateCode();
        socket.join(code);
        gameRooms[code] = {
            players: [{ id: socket.id, name: username, role: 'Guesser', score: 0, lastGain: 0, isSpectator: false }],
            gameState: { gameStarted: false, giverIndex: 0, clue: "", category: [], guesses: {}, currentRound: 0, maxRounds: 0, targetValue: 0 }
        };
        socket.emit('room-created', code);
        io.to(code).emit('update-lobby', gameRooms[code].players);
    });

    socket.on('join-room', ({ code, username }) => {
        const c = code.toUpperCase();
        const room = gameRooms[c];
        if (room) {
            socket.join(c);
            const isMidGame = room.gameState.gameStarted;
            const newPlayer = { id: socket.id, name: username, role: isMidGame ? 'Spectator' : 'Guesser', score: 0, lastGain: 0, isSpectator: isMidGame };
            room.players.push(newPlayer);
            socket.emit('joined-successfully', c);
            if (isMidGame) {
                socket.emit('assigned-role', 'Spectator');
                socket.emit('game-transition', { category: room.gameState.category, round: room.gameState.currentRound, totalRounds: room.gameState.maxRounds, players: room.players, gameStarted: true });
                if(room.gameState.clue) socket.emit('clue-received', room.gameState.clue);
            }
            io.to(c).emit('update-lobby', room.players);
        }
    });

    socket.on('start-game', (code) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.gameStarted = true;
        room.gameState.currentRound = 1;
        room.gameState.maxRounds = room.players.length * 3;
        room.gameState.giverIndex = 0;
        room.players.forEach(p => p.score = 0);
        startNewRound(code);
    });

    socket.on('reroll-category', (code) => {
        const room = gameRooms[code];
        if (room && room.gameState.gameStarted && !room.gameState.clue) {
            room.gameState.category = categories[Math.floor(Math.random() * categories.length)];
            io.to(code).emit('category-updated', room.gameState.category);
        }
    });

    socket.on('submit-clue', ({ code, clue }) => {
        const room = gameRooms[code];
        if (room) { room.gameState.clue = clue; io.to(code).emit('clue-received', clue); }
    });

    socket.on('submit-guess', ({ code, angle }) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.guesses[socket.id] = { angle: angle };
        const activeGuessers = room.players.filter(p => !p.isSpectator && p.role === 'Guesser').length;
        if (Object.keys(room.gameState.guesses).length >= activeGuessers) {
            calculateScores(code);
            io.to(code).emit('reveal-all', { 
                target: room.gameState.targetValue, 
                guesses: Object.entries(room.gameState.guesses).map(([id, g]) => ({ name: room.players.find(p => p.id === id)?.name || "Unknown", angle: g.angle })), 
                players: room.players 
            });
        }
    });

    socket.on('next-round', (code) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.giverIndex = (room.gameState.giverIndex + 1) % room.players.length;
        room.gameState.currentRound++;
        if (room.gameState.currentRound <= room.gameState.maxRounds) startNewRound(code);
        else io.to(code).emit('game-over', room.players);
    });

    socket.on('end-game', (code) => {
        const room = gameRooms[code];
        if (room) io.to(code).emit('game-over', room.players);
    });

    socket.on('disconnect', () => {
        for (const code in gameRooms) {
            const room = gameRooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const wasGiver = (room.players[playerIndex].role === 'Giver');
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) { delete gameRooms[code]; return; }
                io.to(code).emit('update-lobby', room.players);
                if (playerIndex === 0 && room.players[0]) io.to(room.players[0].id).emit('you-are-host');
                if (room.gameState.gameStarted && wasGiver) {
                    io.to(code).emit('notification', "The Giver left! Resetting round...");
                    room.gameState.giverIndex = room.gameState.giverIndex % room.players.length;
                    setTimeout(() => { startNewRound(code); }, 2000);
                }
                break;
            }
        }
    });
});

// Deep linking for Render
app.get('/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    if (code.length === 4) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.redirect('/');
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });
