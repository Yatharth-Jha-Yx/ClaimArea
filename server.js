const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const turf = require('@turf/turf');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_NAME_LEN = 20;
const MAX_PATH_POINTS = 2000;
const MIN_TERRITORY_AREA_M2 = 100;
// Long enough that every phone locking for a while doesn't wipe the game
const EMPTY_ROOM_GRACE_MS = 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '100kb' }));

const GAME_FILE = path.join(__dirname, 'geoquest_Version4.html');
app.get(['/', '/geoquest_Version4.html'], (req, res) => res.sendFile(GAME_FILE));

// Gemini lore proxy keeps the API key server-side
app.post('/api/generate-lore', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'Lore generation not configured on server (set GEMINI_API_KEY)' });
    }
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 4000) : '';
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            }
        );
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error(data.error?.message || 'No content from Gemini');
        res.json({ text });
    } catch (err) {
        console.error('Gemini API error:', err.message);
        res.status(502).json({ error: 'Failed to generate lore' });
    }
});

// ─── Input sanitizing ─────────────────────────────────────────────────────────

function cleanName(name) {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim().slice(0, MAX_NAME_LEN);
    return trimmed || null;
}

function cleanId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

const isLat = v => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = v => Number.isFinite(v) && v >= -180 && v <= 180;

function cleanPath(p) {
    if (!Array.isArray(p)) return [];
    return p.slice(-MAX_PATH_POINTS)
        .filter(pt => pt && isLat(pt.lat) && isLng(pt.lng))
        .map(pt => ({ lat: pt.lat, lng: pt.lng }));
}

function cleanLatLngRing(coords) {
    if (!Array.isArray(coords) || coords.length < 4 || coords.length > MAX_PATH_POINTS) return null;
    for (const c of coords) {
        if (!Array.isArray(c) || !isLat(c[0]) || !isLng(c[1])) return null;
    }
    return coords.map(([lat, lng]) => [lat, lng]);
}

// ─── Rooms ────────────────────────────────────────────────────────────────────

const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

// Must match PLAYER_COLORS in geoquest_Version4.html
const PLAYER_COLORS = ['#4C8DF6', '#F28B30', '#1FB5A3', '#E5484D', '#8E6CF0', '#E8B020', '#2BA8E0', '#46B864', '#E25CA8', '#7C8B9E'];

function hashColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

// Hand out distinct colors within a room so players are easy to tell apart on the map
function pickColor(room, name) {
    const used = new Set([...room.players.values()].map(p => p.color));
    return PLAYER_COLORS.find(c => !used.has(c)) || hashColor(name);
}

function hostName(room) {
    return room.players.get(room.hostSocketId)?.name || null;
}

function roomSnapshot(room) {
    return {
        hostName: hostName(room),
        players: [...room.players.values()].map(p => ({ name: p.name, color: p.color, score: p.score })),
        territories: [...room.territories.values()],
        activePaths: [...room.players.values()]
            .filter(p => p.activePath.length > 1)
            .map(p => ({ playerName: p.name, path: p.activePath }))
    };
}

function getContext(socket) {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    return player ? { room, player } : null;
}

function addPlayer(socket, room, name, playerId) {
    // Same browser tab reconnecting: carry over its score and color, and drop the stale socket
    let score = 0;
    let color = null;
    for (const [sid, p] of room.players) {
        if (playerId && p.playerId === playerId) {
            score = p.score;
            color = p.color;
            room.players.delete(sid);
            if (room.hostSocketId === sid) room.hostSocketId = socket.id;
            io.sockets.sockets.get(sid)?.disconnect(true);
        }
    }

    // Returning after leaving or closing the tab: restore by name
    if (color === null) {
        const retired = room.retired.get(name);
        if (retired) {
            score = retired.score;
            color = retired.color;
            room.retired.delete(name);
        }
    }
    const colorTaken = [...room.players.values()].some(p => p.color === color);

    const player = {
        socketId: socket.id,
        playerId,
        name,
        color: color && !colorTaken ? color : pickColor(room, name),
        score,
        activePath: [],
        joinedAt: Date.now()
    };
    room.players.set(socket.id, player);
    room.emptySince = null;
    if (!room.players.has(room.hostSocketId)) room.hostSocketId = socket.id;

    socket.data.roomCode = room.code;
    socket.join(room.code);
    return player;
}

function leaveRoom(socket) {
    const ctx = getContext(socket);
    socket.data.roomCode = null;
    if (!ctx) return;
    const { room, player } = ctx;

    room.players.delete(socket.id);
    room.retired.set(player.name, { score: player.score, color: player.color });
    socket.leave(room.code);

    if (room.players.size === 0) {
        room.emptySince = Date.now();
        console.log(`[${room.code}] Empty, kept for rejoin`);
        return;
    }

    let newHostName = null;
    if (socket.id === room.hostSocketId) {
        const nextHost = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.hostSocketId = nextHost.socketId;
        newHostName = nextHost.name;
        io.to(room.code).emit('room:host_changed', { newHostName });
        console.log(`[${room.code}] Host changed to ${newHostName}`);
    }

    io.to(room.code).emit('path:deleted', { playerName: player.name });
    io.to(room.code).emit('room:player_left', { playerName: player.name, newHostName });
    console.log(`[${room.code}] ${player.name} left (${room.players.size} remaining)`);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    // A bad payload from one client must never take the server down for everyone
    const on = (event, handler) => socket.on(event, (payload) => {
        try {
            handler(payload && typeof payload === 'object' ? payload : {});
        } catch (err) {
            console.error(`Error handling ${event}:`, err);
        }
    });

    on('room:create', ({ playerName, playerId }) => {
        const name = cleanName(playerName);
        if (!name) return socket.emit('error', { message: 'Please enter a name.' });

        leaveRoom(socket);
        const room = {
            code: generateRoomCode(),
            hostSocketId: socket.id,
            players: new Map(),
            territories: new Map(),
            retired: new Map(), // name → { score, color } of players who left
            emptySince: null
        };
        rooms.set(room.code, room);
        addPlayer(socket, room, name, cleanId(playerId));

        socket.emit('room:joined', { code: room.code, roomState: roomSnapshot(room), isHost: true });
        console.log(`[${room.code}] Created by ${name}`);
    });

    on('room:join', ({ code, playerName, playerId }) => {
        const name = cleanName(playerName);
        if (!name) return socket.emit('error', { message: 'Please enter a name.' });
        if (typeof code !== 'string') return socket.emit('error', { message: 'Invalid room code.' });

        const room = rooms.get(code.trim().toUpperCase());
        if (!room) return socket.emit('room:not_found', { code });

        const id = cleanId(playerId);
        const nameTaken = [...room.players.values()].some(p => p.name === name && !(id && p.playerId === id));
        if (nameTaken) {
            return socket.emit('error', { message: `Name "${name}" is already taken in this room.` });
        }

        if (socket.data.roomCode !== room.code) leaveRoom(socket);
        const player = addPlayer(socket, room, name, id);

        socket.emit('room:joined', {
            code: room.code,
            roomState: roomSnapshot(room),
            isHost: room.hostSocketId === socket.id
        });
        socket.to(room.code).emit('room:player_joined', {
            player: { name: player.name, color: player.color, score: player.score }
        });
        console.log(`[${room.code}] ${name} joined (${room.players.size} players)`);
    });

    on('room:leave', () => leaveRoom(socket));

    on('path:update', ({ path: p }) => {
        const ctx = getContext(socket);
        if (!ctx) return;
        ctx.player.activePath = cleanPath(p);
        socket.to(ctx.room.code).emit('path:updated', {
            playerName: ctx.player.name,
            path: ctx.player.activePath
        });
    });

    on('path:delete', () => {
        const ctx = getContext(socket);
        if (!ctx) return;
        ctx.player.activePath = [];
        socket.to(ctx.room.code).emit('path:deleted', { playerName: ctx.player.name });
    });

    on('territory:claim', ({ id, coords, center, area }) => {
        const ctx = getContext(socket);
        if (!ctx) return;
        const { room, player } = ctx;

        const territoryId = cleanId(id);
        const ring = cleanLatLngRing(coords);
        if (!territoryId || !ring || room.territories.has(territoryId)) {
            return socket.emit('territory:claim_rejected', { id, reason: 'Invalid territory' });
        }

        const validation = validateTerritory(room, ring, Number(area));
        if (!validation.valid) {
            return socket.emit('territory:claim_rejected', { id: territoryId, reason: validation.reason });
        }

        const territory = {
            id: territoryId,
            coords: ring,
            center: validation.center,
            area: validation.serverArea,
            owner: player.name,
            color: player.color,
            timestamp: new Date().toISOString(),
            lore: null
        };
        room.territories.set(territoryId, territory);

        const points = Math.max(1, Math.round(validation.serverArea / 100));
        player.score += points;

        player.activePath = [];
        socket.to(room.code).emit('path:deleted', { playerName: player.name });

        io.to(room.code).emit('territory:captured', {
            territory,
            captorName: player.name,
            points,
            captorScore: player.score
        });
        console.log(`[${room.code}] ${player.name} captured ${territoryId} (${Math.round(validation.serverArea)}m², +${points})`);
    });

    on('path:intercept', ({ targetPlayer, path: p }) => {
        const ctx = getContext(socket);
        if (!ctx) return;
        const { room, player: interceptor } = ctx;

        // Use the interceptor's latest path; the periodic sync can lag by a second
        const latest = cleanPath(p);
        if (latest.length > 1) interceptor.activePath = latest;
        if (interceptor.activePath.length < 2) return;

        const victim = [...room.players.values()].find(pl => pl.name === targetPlayer);
        if (!victim || victim === interceptor || victim.activePath.length < 2) return;

        const interceptorLine = turf.lineString(interceptor.activePath.map(pt => [pt.lng, pt.lat]));
        const victimLine = turf.lineString(victim.activePath.map(pt => [pt.lng, pt.lat]));
        if (turf.lineIntersect(interceptorLine, victimLine).features.length === 0) return;

        victim.activePath = [];
        interceptor.score += 10;

        io.to(room.code).emit('path:deleted', { playerName: victim.name });
        io.to(room.code).emit('path:intercepted', {
            interceptorName: interceptor.name,
            victimName: victim.name,
            interceptorScore: interceptor.score
        });
        console.log(`[${room.code}] ${interceptor.name} intercepted ${victim.name}`);
    });

    socket.on('disconnect', () => {
        try {
            leaveRoom(socket);
        } catch (err) {
            console.error('Error handling disconnect:', err);
        }
    });
});

// ─── Territory validation ─────────────────────────────────────────────────────

function toGeoJsonPolygon(latLngRing) {
    const ring = latLngRing.map(([lat, lng]) => [lng, lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return turf.polygon([ring]);
}

function validateTerritory(room, latLngRing, clientArea) {
    let polygon;
    try {
        polygon = toGeoJsonPolygon(latLngRing);
    } catch (_) {
        return { valid: false, reason: 'Invalid polygon geometry' };
    }

    const serverArea = turf.area(polygon);
    if (serverArea < MIN_TERRITORY_AREA_M2) {
        return { valid: false, reason: `Territory too small (min ${MIN_TERRITORY_AREA_M2}m²)` };
    }
    if (!Number.isFinite(clientArea) || Math.abs(serverArea - clientArea) > serverArea * 0.2) {
        return { valid: false, reason: 'Area mismatch' };
    }

    for (const existing of room.territories.values()) {
        try {
            const overlap = turf.intersect(polygon, toGeoJsonPolygon(existing.coords));
            if (overlap && turf.area(overlap) > serverArea * 0.5) {
                return { valid: false, reason: 'Overlaps an existing territory' };
            }
        } catch (_) {
            // Self-intersecting shapes can make intersect throw; skip that comparison
        }
    }

    const [lng, lat] = turf.centerOfMass(polygon).geometry.coordinates;
    return { valid: true, serverArea, center: [lat, lng] };
}

// ─── Room cleanup ─────────────────────────────────────────────────────────────

setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
            rooms.delete(code);
            console.log(`[${code}] Room closed`);
        }
    }
}, 30 * 1000);

server.listen(PORT, () => {
    console.log(`GeoQuest server running on http://localhost:${PORT}`);
});
