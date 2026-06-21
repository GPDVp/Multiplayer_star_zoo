// =============================================
// server.js - Main WebSocket Server
// =============================================
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Import security module
const {
    IPBanManager,
    RateLimiter,
    IDValidator,
    MessageValidator,
    ConnectionManager,
    SecurityLogger,
    SECURITY_CONFIG
} = require('./security.js');

// ============================================================
// ✅ SECTION 1: CONFIGURATION
// ============================================================
const CONFIG = {
    PORT: process.env.PORT || 10000,
    MAX_PLAYERS: 100,
    MAX_ROOM_SIZE: 2,
    PING_INTERVAL: 30000,
    HEARTBEAT_INTERVAL: 15000,
    IDS_FILE: path.join(__dirname, 'ids.json')
};

// ============================================================
// ✅ SECTION 2: INITIALIZE SECURITY MODULES
// ============================================================
const ipBanManager = new IPBanManager();
const rateLimiter = new RateLimiter();
const idValidator = new IDValidator();
const messageValidator = new MessageValidator();
const connectionManager = new ConnectionManager();
const securityLogger = new SecurityLogger();

// ============================================================
// ✅ SECTION 3: DATA STORAGE
// ============================================================
const players = new Map();
const pendingRequests = new Map();
const rooms = new Map();

// ============================================================
// ✅ SECTION 4: LOGGING
// ============================================================
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleString('fa-IR');
    const colors = {
        info: '\x1b[36m',
        success: '\x1b[32m',
        error: '\x1b[31m',
        warn: '\x1b[33m',
        reset: '\x1b[0m'
    };
    console.log(`${colors[type]}[${timestamp}]${colors.reset} ${message}`);
}

// ============================================================
// ✅ SECTION 5: UTILITY FUNCTIONS
// ============================================================
function generateRoomId() {
    return 'room_' + crypto.randomBytes(8).toString('hex');
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
        log(`Send to ${playerId} failed: ${e.message}`, 'error');
    }
    return false;
}

// ============================================================
// ✅ SECTION 6: WEB SOCKET SERVER
// ============================================================
const server = new WebSocket.Server({
    port: CONFIG.PORT,
    perMessageDeflate: true,
    maxPayload: 65536,
    clientTracking: true
});

server.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    
    // Check if IP is banned
    if (ipBanManager.isBanned(ip)) {
        log(`🚫 Blocked banned IP: ${ip}`, 'warn');
        ws.close(1000, 'banned');
        return;
    }
    
    let player_id = null;
    let authenticated = false;
    let pingTimeout = null;
    let pongReceived = true;
    
    // ===== Ping/Pong Management =====
    function resetPingTimeout() {
        if (pingTimeout) clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            if (!pongReceived) {
                log(`⏰ Ping timeout for ${player_id || 'unknown'}`, 'warn');
                ws.terminate();
                return;
            }
            pongReceived = false;
            try {
                ws.ping();
                resetPingTimeout();
            } catch (e) {
                ws.terminate();
            }
        }, CONFIG.PING_INTERVAL);
    }
    
    // ===== WebSocket Events =====
    ws.on('pong', () => {
        pongReceived = true;
        if (player_id) {
            connectionManager.updateActivity(player_id);
        }
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            // Validate message
            const validation = messageValidator.validate(msg);
            if (!validation.valid) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: validation.reason,
                    code: 'INVALID_MESSAGE'
                }));
                return;
            }
            
            // Rate limiting (skip for auth)
            if (player_id && msg.type !== 'auth') {
                const rateCheck = rateLimiter.check(player_id, ip);
                if (!rateCheck.allowed) {
                    securityLogger.logRateLimit(player_id, ip);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: rateCheck.reason,
                        code: 'RATE_LIMIT'
                    }));
                    return;
                }
            }
            
            // ===== Message Router =====
            switch (msg.type) {
                case 'auth':
                    handleAuth(ws, msg, ip);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                    
                case 'friend_request':
                    handleFriendRequest(ws, msg);
                    break;
                    
                case 'friend_request_accepted':
                    handleFriendAccepted(ws, msg);
                    break;
                    
                case 'friend_request_rejected':
                    handleFriendRejected(ws, msg);
                    break;
                    
                case 'sync_character':
                    handleSyncCharacter(ws, msg);
                    break;
                    
                case 'get_online_players':
                    handleGetOnlinePlayers(ws, msg);
                    break;
                    
                case 'leave_room':
                    handleLeaveRoom(ws, msg);
                    break;
                    
                case 'disconnect':
                    handleDisconnect(ws, msg);
                    break;
                    
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type',
                        code: 'UNKNOWN_TYPE'
                    }));
            }
            
        } catch (error) {
            log(`Error: ${error.message}`, 'error');
            securityLogger.logError(error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format',
                code: 'INVALID_FORMAT'
            }));
        }
    });
    
    ws.on('close', (code, reason) => {
        if (pingTimeout) clearTimeout(pingTimeout);
        if (player_id) {
            handlePlayerDisconnect(player_id);
        }
        log(`🔌 Connection closed (${code}: ${reason || 'normal'})`, 'info');
    });
    
    ws.on('error', (error) => {
        log(`WebSocket error: ${error.message}`, 'error');
        if (player_id) {
            handlePlayerDisconnect(player_id);
        }
        ws.close(1011, 'server_error');
    });
    
    // ===== Handler Functions =====
    function handleAuth(ws, msg, ip) {
        const playerId = msg.player_id;
        const character = msg.character;
        
        // Validate ID format
        const formatCheck = idValidator.isValidFormat(playerId);
        if (!formatCheck.valid) {
            ws.send(JSON.stringify({
                type: 'auth_fail',
                reason: formatCheck.reason,
                code: 'INVALID_ID'
            }));
            securityLogger.logAuth(playerId, ip, false, formatCheck.reason);
            return;
        }
        
        // Check if already online
        if (players.has(playerId) && players.get(playerId).online) {
            ws.send(JSON.stringify({
                type: 'auth_fail',
                reason: 'Player already online',
                code: 'ALREADY_ONLINE'
            }));
            securityLogger.logAuth(playerId, ip, false, 'Already online');
            return;
        }
        
        // Register ID if new
        if (idValidator.isUnique(playerId)) {
            idValidator.registerId(playerId);
        }
        
        // Add connection
        const connResult = connectionManager.addConnection(playerId, ip, ws);
        if (!connResult.success) {
            ws.send(JSON.stringify({
                type: 'auth_fail',
                reason: connResult.reason,
                code: 'CONNECTION_LIMIT'
            }));
            return;
        }
        
        player_id = playerId;
        authenticated = true;
        
        // Create player data
        players.set(playerId, {
            ws: ws,
            online: true,
            character: character,
            room: null,
            connectedAt: Date.now(),
            lastActive: Date.now(),
            lastPong: Date.now(),
            ip: ip
        });
        
        // Send auth success
        ws.send(JSON.stringify({
            type: 'auth_ok',
            player_id: playerId,
            character: character,
            server_time: Date.now(),
            online_count: players.size
        }));
        
        securityLogger.logAuth(playerId, ip, true);
        log(`✅ ${playerId} authenticated as ${character}`, 'success');
        log(`📊 Total players: ${players.size}`, 'info');
        
        // Notify other players
        for (const [id, player] of players) {
            if (id !== playerId && player.online) {
                sendToPlayer(id, {
                    type: 'friend_online',
                    player_id: playerId,
                    character: character,
                    timestamp: Date.now()
                });
            }
        }
        
        // Reset ping
        pongReceived = true;
        resetPingTimeout();
    }
    
    function handleFriendRequest(ws, msg) {
        if (!authenticated || !player_id) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Not authenticated',
                code: 'NOT_AUTH'
            }));
            return;
        }
        
        const to_id = msg.to_id;
        const from_id = msg.from_id;
        
        // Validate ID format
        const formatCheck = idValidator.isValidFormat(to_id);
        if (!formatCheck.valid) {
            ws.send(JSON.stringify({
                type: 'error',
                message: formatCheck.reason,
                code: 'INVALID_ID'
            }));
            return;
        }
        
        if (to_id === from_id) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Cannot send to yourself',
                code: 'SELF_REQUEST'
            }));
            return;
        }
        
        // Check if already connected
        if (pendingRequests.has(from_id) && pendingRequests.get(from_id) === to_id) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Request already pending',
                code: 'REQUEST_PENDING'
            }));
            return;
        }
        
        const toPlayer = players.get(to_id);
        if (!toPlayer || !toPlayer.online) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Player is offline',
                code: 'PLAYER_OFFLINE'
            }));
            return;
        }
        
        // Send request
        const sent = sendToPlayer(to_id, {
            type: 'friend_request',
            from_id: from_id,
            character: msg.character,
            timestamp: Date.now()
        });
        
        if (sent) {
            pendingRequests.set(from_id, to_id);
            sendToPlayer(from_id, {
                type: 'friend_request_sent',
                to_id: to_id,
                timestamp: Date.now()
            });
            log(`📩 Request from ${from_id} to ${to_id}`, 'info');
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to send',
                code: 'SEND_FAILED'
            }));
        }
    }
    
    function handleFriendAccepted(ws, msg) {
        if (!authenticated || !player_id) return;
        
        const accept_from = msg.from_id;
        const accept_to = msg.to_id;
        const accept_character = msg.character;
        
        if (!pendingRequests.has(accept_from) || pendingRequests.get(accept_from) !== accept_to) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'No pending request',
                code: 'NO_PENDING'
            }));
            return;
        }
        
        const fromPlayer = players.get(accept_from);
        const toPlayer = players.get(accept_to);
        
        if (!fromPlayer || !fromPlayer.online || !toPlayer || !toPlayer.online) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Player offline',
                code: 'PLAYER_OFFLINE'
            }));
            pendingRequests.delete(accept_from);
            return;
        }
        
        // Create room
        const room_id = generateRoomId();
        const room = new Set();
        room.add(accept_from);
        room.add(accept_to);
        rooms.set(room_id, room);
        
        fromPlayer.room = room_id;
        toPlayer.room = room_id;
        
        // Notify both players
        sendToPlayer(accept_from, {
            type: 'friend_request_accepted',
            from_id: accept_to,
            to_id: accept_from,
            character: toPlayer.character,
            room_id: room_id,
            timestamp: Date.now()
        });
        
        sendToPlayer(accept_to, {
            type: 'friend_request_accepted',
            from_id: accept_from,
            to_id: accept_to,
            character: fromPlayer.character,
            room_id: room_id,
            timestamp: Date.now()
        });
        
        pendingRequests.delete(accept_from);
        log(`🎮 Room ${room_id} created (${accept_from} ↔ ${accept_to})`, 'success');
    }
    
    function handleFriendRejected(ws, msg) {
        if (!authenticated || !player_id) return;
        
        const reject_from = msg.from_id;
        const reject_to = msg.to_id;
        
        if (pendingRequests.has(reject_from) && pendingRequests.get(reject_from) === reject_to) {
            sendToPlayer(reject_from, {
                type: 'friend_request_rejected',
                from_id: reject_to,
                timestamp: Date.now()
            });
            pendingRequests.delete(reject_from);
            log(`❌ Request from ${reject_from} rejected`, 'warn');
        }
    }
    
    function handleSyncCharacter(ws, msg) {
        if (!authenticated || !player_id) return;
        
        const player = players.get(player_id);
        if (player) {
            player.character = msg.character;
            
            // Notify room members
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
    }
    
    function handleGetOnlinePlayers(ws, msg) {
        if (!authenticated || !player_id) return;
        
        const onlineList = [];
        for (const [id, player] of players) {
            if (id !== player_id && player.online) {
                onlineList.push({
                    player_id: id,
                    character: player.character
                });
            }
        }
        
        ws.send(JSON.stringify({
            type: 'online_players_list',
            players: onlineList,
            count: onlineList.length,
            timestamp: Date.now()
        }));
    }
    
    function handleLeaveRoom(ws, msg) {
        if (!authenticated || !player_id) return;
        
        const player = players.get(player_id);
        if (player && player.room && rooms.has(player.room)) {
            const roomId = player.room;
            const room = rooms.get(roomId);
            room.delete(player_id);
            
            if (room.size === 0) {
                rooms.delete(roomId);
            }
            
            player.room = null;
            
            for (const id of room) {
                sendToPlayer(id, {
                    type: 'room_member_left',
                    player_id: player_id,
                    room_id: roomId,
                    timestamp: Date.now()
                });
            }
            
            ws.send(JSON.stringify({
                type: 'room_left',
                room_id: roomId,
                timestamp: Date.now()
            }));
        }
    }
    
    function handleDisconnect(ws, msg) {
        if (player_id) {
            handlePlayerDisconnect(player_id);
        }
        ws.close(1000, 'client_disconnect');
    }
    
    function handlePlayerDisconnect(playerId) {
        const player = players.get(playerId);
        if (!player) return;
        
        player.online = false;
        
        // Remove from room
        if (player.room && rooms.has(player.room)) {
            const room = rooms.get(player.room);
            room.delete(playerId);
            if (room.size === 0) {
                rooms.delete(player.room);
            }
        }
        
        // Notify others
        for (const [id, p] of players) {
            if (id !== playerId && p.online) {
                sendToPlayer(id, {
                    type: 'friend_offline',
                    player_id: playerId,
                    timestamp: Date.now()
                });
            }
        }
        
        pendingRequests.delete(playerId);
        connectionManager.removeConnection(playerId);
        
        log(`👋 ${playerId} disconnected`, 'info');
    }
});

// ============================================================
// ✅ SECTION 7: HEALTH CHECK
// ============================================================
setInterval(() => {
    const now = Date.now();
    for (const [id, player] of players) {
        if (player.online && player.ws.readyState === WebSocket.OPEN) {
            if (now - player.lastPong > CONFIG.HEARTBEAT_INTERVAL * 2) {
                log(`⚠️ ${id} stale connection`, 'warn');
                try {
                    player.ws.terminate();
                } catch (e) {}
                handlePlayerDisconnect(id);
            }
        }
    }
}, CONFIG.HEARTBEAT_INTERVAL);

// ============================================================
// ✅ SECTION 8: HTTP STATS
// ============================================================
const http = require('http');
const httpServer = http.createServer((req, res) => {
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            players: players.size,
            rooms: rooms.size,
            pending_requests: pendingRequests.size,
            timestamp: Date.now()
        }));
    } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            timestamp: Date.now()
        }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const HTTP_PORT = parseInt(CONFIG.PORT) + 1;
httpServer.listen(HTTP_PORT, () => {
    log(`📊 Stats endpoint on port ${HTTP_PORT}`, 'info');
});

// ============================================================
// ✅ SECTION 9: GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGINT', () => {
    log('🛑 Shutting down...', 'warn');
    saveUsedIds();
    server.close(() => {
        httpServer.close();
        process.exit(0);
    });
});

// ============================================================
// ✅ SECTION 10: SERVER READY
// ============================================================
log(`🚀 Server running on port ${CONFIG.PORT}`, 'success');
log(`📡 Connect with: wss://your-app.onrender.com`, 'info');