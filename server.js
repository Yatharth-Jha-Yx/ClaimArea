const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const turf = require('@turf/turf');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(__dirname));

// Serve the game at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'geoquest_Version4.html'));
});

// Gemini lore proxy — keeps the API key server-side
app.post('/api/generate-lore', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'Lore generation not configured on server' });
    }

    const { prompt, center, area, player } = req.body;
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            }
        );
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('No content from Gemini');
        res.json({ text });
    } catch (err) {
        console.error('Gemini API error:', err.message);
        res.status(500).json({ error: 'Failed to generate lore' });
    }
});

// ─── In-memory room store ────────────────────────────────────────────────────

const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function playerColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 45%)`;
}

function roomSnapshot(room) {
    return {
        players: [...room.players.values()].map(p => ({
            name: p.name,
            color: p.color,
            score: p.score
        })),
        territories: [...room.territories.values()]
    };
}

// ─── Socket.IO event handling ─────────────────────────────────────────────────

io.on('connection', (socket) => {

    // ── Create a new room (player becomes host) ──────────────────────────────
    socket.on('room:create', ({ playerName }) => {
        if (!playerName || typeof playerName !== 'string') return;

        const code = generateRoomCode();
        const player = {
            socketId: socket.id,
            name: playerName,
            color: playerColor(playerName),
            score: 0,
            activePath: [],
            joinedAt: Date.now()
        };

        const room = {
            code,
            hostSocketId: socket.id,
            players: new Map([[socket.id, player]]),
            territories: new Map()
        };

        rooms.set(code, room);
        socket.data.roomCode = code;
        socket.data.playerName = playerName;
        socket.join(code);

        socket.emit('room:joined', {
            code,
            roomState: roomSnapshot(room),
            isHost: true
        });

        console.log(`[${code}] Created by ${playerName}`);
    });

    // ── Join an existing room ─────────────────────────────────────────────────
    socket.on('room:join', ({ code, playerName }) => {
        if (!code || !playerName) return;

        const room = rooms.get(code.toUpperCase());
        if (!room) {
            socket.emit('error', { message: `Room "${code}" not found.` });
            return;
        }

        // Reject duplicate names in same room
        const nameTaken = [...room.players.values()].some(p => p.name === playerName);
        if (nameTaken) {
            socket.emit('error', { message: `Name "${playerName}" is already taken in this room.` });
            return;
        }

        const player = {
            socketId: socket.id,
            name: playerName,
            color: playerColor(playerName),
            score: 0,
            activePath: [],
            joinedAt: Date.now()
        };

        room.players.set(socket.id, player);
        socket.data.roomCode = code.toUpperCase();
        socket.data.playerName = playerName;
        socket.join(code.toUpperCase());

        // Tell the joiner the full room state
        socket.emit('room:joined', {
            code: room.code,
            roomState: roomSnapshot(room),
            isHost: false
        });

        // Tell everyone else
        socket.to(room.code).emit('room:player_joined', {
            player: { name: playerName, color: player.color }
        });

        console.log(`[${room.code}] ${playerName} joined (${room.players.size} players)`);
    });

    // ── Sync active path ──────────────────────────────────────────────────────
    socket.on('path:update', ({ path }) => {
        const room = rooms.get(socket.data.roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        player.activePath = Array.isArray(path) ? path : [];

        // Broadcast to everyone else in the room
        socket.to(room.code).emit('path:updated', {
            playerName: player.name,
            path: player.activePath
        });
    });

    // ── Delete active path ────────────────────────────────────────────────────
    socket.on('path:delete', () => {
        const room = rooms.get(socket.data.roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        player.activePath = [];

        socket.to(room.code).emit('path:deleted', { playerName: player.name });
    });

    // ── Claim a territory ─────────────────────────────────────────────────────
    socket.on('territory:claim', ({ id, coords, center, area }) => {
        const room = rooms.get(socket.data.roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        // Server-side validation with Turf.js
        const validation = validateTerritory(room, coords, area);
        if (!validation.valid) {
            socket.emit('territory:claim_rejected', { reason: validation.reason });
            return;
        }

        const territory = {
            id,
            coords,
            center,
            area: validation.serverArea,
            owner: player.name,
            timestamp: new Date().toISOString(),
            lore: null
        };

        room.territories.set(id, territory);

        // Award points
        const points = Math.max(1, Math.round(validation.serverArea / 100));
        player.score += points;

        // Clear their active path
        player.activePath = [];
        socket.to(room.code).emit('path:deleted', { playerName: player.name });

        // Broadcast the confirmed territory to everyone in the room
        io.to(room.code).emit('territory:captured', {
            territory,
            captorName: player.name,
            points
        });

        console.log(`[${room.code}] ${player.name} captured territory ${id} (${Math.round(validation.serverArea)}m², +${points}pts)`);
    });

    // ── Path interception ─────────────────────────────────────────────────────
    socket.on('path:intercept', ({ targetPlayer }) => {
        const room = rooms.get(socket.data.roomCode);
        if (!room) return;

        const interceptor = room.players.get(socket.id);
        if (!interceptor || interceptor.activePath.length < 2) return;

        // Find the target player
        const victim = [...room.players.values()].find(p => p.name === targetPlayer);
        if (!victim || victim.activePath.length < 2) return;

        // Re-validate the intersection server-side
        try {
            const interceptorLine = turf.lineString(interceptor.activePath.map(p => [p.lng, p.lat]));
            const victimLine = turf.lineString(victim.activePath.map(p => [p.lng, p.lat]));
            const intersection = turf.lineIntersect(interceptorLine, victimLine);

            if (intersection.features.length === 0) {
                // False positive from client — no actual intersection
                return;
            }
        } catch (e) {
            return;
        }

        // Wipe the victim's path
        victim.activePath = [];

        // Intercept bonus for the interceptor
        interceptor.score += 10;

        // Find the victim's socket to notify them directly
        const victimSocketEntry = [...room.players.entries()].find(([, p]) => p.name === targetPlayer);
        const victimSocketId = victimSocketEntry ? victimSocketEntry[0] : null;

        // Notify both players
        io.to(room.code).emit('path:intercepted', {
            interceptorName: interceptor.name,
            victimName: targetPlayer
        });

        if (victimSocketId) {
            // Make sure victim's path is cleared on their side too
            io.to(victimSocketId).emit('path:deleted', { playerName: targetPlayer });
        }

        console.log(`[${room.code}] ${interceptor.name} intercepted ${targetPlayer}`);
    });

    // ── Disconnect / leave ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        const leavingName = player.name;
        room.players.delete(socket.id);

        if (room.players.size === 0) {
            rooms.delete(roomCode);
            console.log(`[${roomCode}] Empty room deleted`);
            return;
        }

        let newHostName = null;

        // Elect new host if the leaving player was the host
        if (socket.id === room.hostSocketId) {
            const nextHost = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
            room.hostSocketId = nextHost.socketId;
            newHostName = nextHost.name;
            io.to(roomCode).emit('room:host_changed', { newHostName });
            console.log(`[${roomCode}] Host changed to ${newHostName}`);
        }

        io.to(roomCode).emit('room:player_left', {
            playerName: leavingName,
            newHostName
        });

        // Clean up their path from other clients' views
        io.to(roomCode).emit('path:deleted', { playerName: leavingName });

        console.log(`[${roomCode}] ${leavingName} left (${room.players.size} remaining)`);
    });
});

// ─── Territory validation ─────────────────────────────────────────────────────

function validateTerritory(room, coords, clientArea) {
    try {
        // coords are [lat, lng] pairs (Leaflet format) — convert to GeoJSON [lng, lat]
        const ring = coords.map(([lat, lng]) => [lng, lat]);

        // Close the ring if not already closed
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push(first);
        }

        if (ring.length < 4) {
            return { valid: false, reason: 'Not enough points' };
        }

        const polygon = turf.polygon([ring]);
        const serverArea = turf.area(polygon);

        if (serverArea < 100) {
            return { valid: false, reason: 'Territory too small (min 100m²)' };
        }

        if (Math.abs(serverArea - clientArea) > clientArea * 0.2) {
            return { valid: false, reason: 'Area mismatch — possible tamper' };
        }

        // Check overlap with existing territories
        for (const existing of room.territories.values()) {
            try {
                const existingRing = existing.coords.map(([lat, lng]) => [lng, lat]);
                const existingFirst = existingRing[0];
                const existingLast = existingRing[existingRing.length - 1];
                if (existingFirst[0] !== existingLast[0] || existingFirst[1] !== existingLast[1]) {
                    existingRing.push(existingFirst);
                }
                const existingPoly = turf.polygon([existingRing]);
                const overlap = turf.intersect(polygon, existingPoly);
                if (overlap) {
                    const overlapArea = turf.area(overlap);
                    if (overlapArea > serverArea * 0.5) {
                        return { valid: false, reason: 'Overlaps an existing territory' };
                    }
                }
            } catch (_) {
                // Skip malformed existing territory
            }
        }

        return { valid: true, serverArea };
    } catch (err) {
        return { valid: false, reason: 'Invalid polygon geometry' };
    }
}

// ─── Periodic room cleanup (rooms older than 2h with 0 players) ───────────────

setInterval(() => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [code, room] of rooms.entries()) {
        if (room.players.size === 0 || (room.createdAt && room.createdAt < twoHoursAgo)) {
            rooms.delete(code);
        }
    }
}, 10 * 60 * 1000);

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`GeoQuest server running on http://localhost:${PORT}`);
    console.log(`Open geoquest_Version4.html in your browser via the server URL above.`);
});
