const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

let categories = JSON.parse(fs.readFileSync('./categories.json', 'utf8'));
fs.watchFile('./categories.json', () => {
    try {
        categories = JSON.parse(fs.readFileSync('./categories.json', 'utf8'));
    } catch (e) { console.log("JSON Error."); }
});

let gameRooms = {};

function generateCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function calculateScores(code) {
    const room = gameRooms[code];
    let bestGuessDiff = 999;
    const giver = room.players[room.gameState.giverIndex];

    // Reset lastGain for everyone before calculating
    room.players.forEach(p => p.lastGain = 0);

    // Calculate Guesser scores
    Object.keys(room.gameState.guesses).forEach(id => {
        const diff = Math.abs(room.gameState.targetValue - room.gameState.guesses[id].angle);
        if (diff < bestGuessDiff) bestGuessDiff = diff;

        let pts = 0;
        if (diff <= 4) pts = 3;       
        else if (diff <= 12) pts = 2; 
        else if (diff <= 20) pts = 1; 

        const p = room.players.find(pl => pl.id === id);
        if (p) {
            p.score += pts;
            p.lastGain = pts; // Track what they just earned
        }
    });

    // GIVER REWARD LOGIC
    if (giver) {
        let giverPts = 0;
        if (bestGuessDiff <= 4) giverPts = 3;
        else if (bestGuessDiff <= 12) giverPts = 2;
        else if (bestGuessDiff <= 20) giverPts = 1;
        
        giver.score += giverPts;
        giver.lastGain = giverPts;
    }
}

function startNewRound(code) {
    const room = gameRooms[code];
    if (!room || room.players.length === 0) return;
    room.gameState.guesses = {};
    room.gameState.clue = "";
    room.gameState.targetValue = Math.floor(Math.random() * 160) + 10;
    room.gameState.category = categories[Math.floor(Math.random() * categories.length)];
    
    // Clear lastGain when a new round starts
    room.players.forEach(p => {
        p.lastGain = 0;
        p.role = 'Guesser'; 
    });

    room.players[room.gameState.giverIndex].role = 'Giver';
    
    room.players.forEach(p => io.to(p.id).emit('assigned-role', p.role));

    io.to(code).emit('game-transition', { 
        category: room.gameState.category, 
        round: room.gameState.currentRound,
        totalRounds: room.gameState.maxRounds,
        players: room.players,
        gameStarted: true
    });
    io.to(room.players[room.gameState.giverIndex].id).emit('secret-target', room.gameState.targetValue);
}

io.on('connection', (socket) => {
    socket.on('create-room', (username) => {
        const code = generateCode();
        socket.join(code);
        gameRooms[code] = {
            players: [{ id: socket.id, name: username, role: 'Guesser', score: 0, lastGain: 0 }],
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
            room.players.push({ id: socket.id, name: username, role: 'Guesser', score: 0, lastGain: 0 });
            socket.emit('joined-successfully', c);
            io.to(c).emit('update-lobby', room.players);
        }
    });

    socket.on('start-game', (code) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.gameStarted = true;
        room.gameState.currentRound = 1;
        room.gameState.maxRounds = room.players.length * 3;
        startNewRound(code);
    });

    socket.on('next-round', (code) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.giverIndex = (room.gameState.giverIndex + 1) % room.players.length;
        room.gameState.currentRound++;
        if (room.gameState.currentRound <= room.gameState.maxRounds) startNewRound(code);
        else io.to(code).emit('game-over', room.players);
    });

    socket.on('submit-clue', ({ code, clue }) => {
        const room = gameRooms[code];
        if (room) { room.gameState.clue = clue; io.to(code).emit('clue-received', clue); }
    });

    socket.on('submit-guess', ({ code, angle }) => {
        const room = gameRooms[code];
        if (!room) return;
        room.gameState.guesses[socket.id] = { angle: angle };
        const numGuessers = room.players.filter(p => p.role === 'Guesser').length;
        if (Object.keys(room.gameState.guesses).length >= numGuessers) {
            calculateScores(code);
            io.to(code).emit('reveal-all', { 
                target: room.gameState.targetValue, 
                guesses: Object.entries(room.gameState.guesses).map(([id, g]) => ({
                    name: room.players.find(p => p.id === id)?.name || "Unknown",
                    angle: g.angle
                })), 
                players: room.players 
            });
        }
    });

    socket.on('reroll-category', (code) => {
        const room = gameRooms[code];
        if (room && !room.gameState.clue) {
            room.gameState.category = categories[Math.floor(Math.random() * categories.length)];
            io.to(code).emit('category-updated', room.gameState.category);
        }
    });
});

// This tells the game: "Use the port Render gives me, otherwise use 3000"
const PORT = process.env.PORT || 3000;

http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});