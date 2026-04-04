const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// Load Categories
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

    room.players.forEach(p => p.lastGain = 0);

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
            p.lastGain = pts;
        }
    });

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

// MAIN CONNECTION LOGIC
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

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

    // DISCONNECT LOGIC (Now correctly inside the connection block)
    socket.on('disconnect', () => {
        for (const code in gameRooms) {
            const room = gameRooms[code];
            const index = room.players.findIndex(p => p.id === socket.id);

            if (index !== -1) {
                room.players.splice(index, 1);
                console.log(`Player left. ${room.players.length} remains in ${code}`);

                if (room.players.length === 0) {
                    delete gameRooms[code];
                    console.log(`Room ${code} was empty and has been deleted.`);
                } else {
                    io.to(code).emit('update-lobby', room.players);
                    
                    // Send the host message to the new first player in line
                    if (room.players[0]) {
                        io.to(room.players[0].id).emit('you-are-host');
                    }
                }
                break; 
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
