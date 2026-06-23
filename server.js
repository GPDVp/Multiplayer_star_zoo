// =============================================
// server.js - بدون IP Ban
// =============================================
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const server = new WebSocket.Server({
    port: process.env.PORT || 10000,
    perMessageDeflate: true,
    maxPayload: 65536,
    clientTracking: true
});

// ============================================================
// ✅ SKIP IP BAN - بدون محدودیت IP
// ============================================================
function isBanned(ip) {
    return false;  // ← همیشه false برگردان
}

const players = new Map();
const pendingRequests = new Map();
const rooms = new Map();

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleString();
    console.log(`[${timestamp}] ${message}`);
}

function sendToPlayer(playerId, message) {
    const player = players.get(playerId);
    if (!player || !player.online) return false;
    
    try {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
            return true;
        }
    } catch (e) {
        log(`Send failed: ${e.message}`, 'error');
    }
    return false;
}

server.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || '0.0.0.0';
    log(`🔗 New connection from ${ip}`, 'info');
    
    // ✅ بدون IP Ban
    // if (isBanned(ip)) { ... }
    
    let player_id = null;
    let authenticated = false;
    let pingTimeout = null;
    let pongReceived = true;
    
    function resetPingTimeout() {
        if (pingTimeout) clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            if (!pongReceived) {
                log(`⏰ Ping timeout`, 'warn');
                ws.terminate();
                return;
            }
            pongReceived = false;
            try { ws.ping(); } catch(e) { ws.terminate(); }
            resetPingTimeout();
        }, 30000);
    }
    
    ws.on('pong', () => {
        pongReceived = true;
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            switch (msg.type) {
                case 'auth':
                    player_id = msg.player_id;
                    const character = msg.character;
                    
                    if (players.has(player_id) && players.get(player_id).online) {
                        ws.send(JSON.stringify({
                            type: 'auth_fail',
                            reason: 'Player already online'
                        }));
                        return;
                    }
                    
                    players.set(player_id, {
                        ws: ws,
                        online: true,
                        character: character,
                        room: null,
                        connectedAt: Date.now(),
                        ip: ip
                    });
                    
                    authenticated = true;
                    
                    ws.send(JSON.stringify({
                        type: 'auth_ok',
                        player_id: player_id,
                        character: character,
                        server_time: Date.now(),
                        online_count: players.size
                    }));
                    
                    log(`✅ ${player_id} authenticated`, 'success');
                    
                    // Notify others
                    for (const [id, player] of players) {
                        if (id !== player_id && player.online) {
                            sendToPlayer(id, {
                                type: 'friend_online',
                                player_id: player_id,
                                character: character,
                                timestamp: Date.now()
                            });
                        }
                    }
                    
                    resetPingTimeout();
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                    
                case 'friend_request':
                    const target = players.get(msg.to_id);
                    if (target && target.online) {
                        target.ws.send(JSON.stringify({
                            type: 'friend_request',
                            from_id: msg.from_id,
                            character: msg.character,
                            timestamp: Date.now()
                        }));
                        ws.send(JSON.stringify({
                            type: 'friend_request_sent',
                            to_id: msg.to_id,
                            timestamp: Date.now()
                        }));
                        log(`📩 Request from ${msg.from_id} to ${msg.to_id}`, 'info');
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Player is offline',
                            code: 'PLAYER_OFFLINE'
                        }));
                    }
                    break;
                    
                case 'friend_request_accepted':
                    const from_id = msg.from_id;
                    const to_id = msg.to_id;
                    
                    const fromPlayer = players.get(from_id);
                    const toPlayer = players.get(to_id);
                    
                    if (fromPlayer && fromPlayer.online && toPlayer && toPlayer.online) {
                        const room_id = 'room_' + crypto.randomBytes(8).toString('hex');
                        const room = new Set();
                        room.add(from_id);
                        room.add(to_id);
                        rooms.set(room_id, room);
                        
                        fromPlayer.room = room_id;
                        toPlayer.room = room_id;
                        
                        sendToPlayer(from_id, {
                            type: 'friend_request_accepted',
                            from_id: to_id,
                            character: toPlayer.character,
                            room_id: room_id,
                            timestamp: Date.now()
                        });
                        
                        sendToPlayer(to_id, {
                            type: 'friend_request_accepted',
                            from_id: from_id,
                            character: fromPlayer.character,
                            room_id: room_id,
                            timestamp: Date.now()
                        });
                        
                        log(`🎮 Room ${room_id} created`, 'success');
                    }
                    break;
                    
                case 'friend_request_rejected':
                    const reject_target = players.get(msg.from_id);
                    if (reject_target && reject_target.online) {
                        sendToPlayer(msg.from_id, {
                            type: 'friend_request_rejected',
                            from_id: msg.to_id,
                            timestamp: Date.now()
                        });
                    }
                    break;
                    
                case 'sync_character':
                    const player = players.get(player_id);
                    if (player) {
                        player.character = msg.character;
                        if (player.room && rooms.has(player.room)) {
                            const room = rooms.get(player.room);
                            for (const id of room) {
                                if (id !== player_id) {
                                    sendToPlayer(id, {
                                        type: 'sync_character',
                                        character: msg.character,
                                        player_id: player_id,
                                        timestamp: Date.now()
                                    });
                                }
                            }
                        }
                    }
                    break;
                    
                case 'disconnect':
                    if (player_id) {
                        const p = players.get(player_id);
                        if (p) {
                            p.online = false;
                            if (p.room && rooms.has(p.room)) {
                                const room = rooms.get(p.room);
                                room.delete(player_id);
                                if (room.size === 0) rooms.delete(p.room);
                            }
                        }
                        players.delete(player_id);
                        log(`👋 ${player_id} disconnected`, 'info');
                    }
                    ws.close(1000, 'client_disconnect');
                    break;
                    
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type'
                    }));
            }
            
        } catch (error) {
            log(`Error: ${error.message}`, 'error');
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });
    
    ws.on('close', () => {
        if (pingTimeout) clearTimeout(pingTimeout);
        if (player_id) {
            const p = players.get(player_id);
            if (p) {
                p.online = false;
                if (p.room && rooms.has(p.room)) {
                    const room = rooms.get(p.room);
                    room.delete(player_id);
                    if (room.size === 0) rooms.delete(p.room);
                }
                players.delete(player_id);
                log(`👋 ${player_id} disconnected`, 'info');
            }
        }
    });
    
    ws.on('error', (error) => {
        log(`WebSocket error: ${error.message}`, 'error');
    });
});

// ============================================================
// ✅ HTTP Stats (بدون IP محدودیت)
// ============================================================
const http = require('http');
const httpServer = http.createServer((req, res) => {
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            players: players.size,
            rooms: rooms.size,
            timestamp: Date.now()
        }));
    } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const HTTP_PORT = parseInt(process.env.PORT || 10000) + 1;
httpServer.listen(HTTP_PORT, () => {
    log(`📊 HTTP stats on port ${HTTP_PORT}`, 'info');
});

log(`🚀 Server running on port ${process.env.PORT || 10000}`, 'success');