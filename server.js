// =============================================
// server.js - COMPLETE FIXED VERSION
// =============================================
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const server = new WebSocket.Server({ port: process.env.PORT || 10000 });
const IDS_FILE = path.join(__dirname, 'ids.json');

function loadUsedIds() {
    try {
        if (fs.existsSync(IDS_FILE)) {
            const data = fs.readFileSync(IDS_FILE, 'utf8');
            const json = JSON.parse(data);
            return new Set(json.ids || []);
        }
    } catch (error) {
        console.error('❌ Error loading IDs:', error.message);
    }
    return new Set();
}

function saveUsedIds(ids) {
    try {
        const data = JSON.stringify({ ids: Array.from(ids), lastUpdated: Date.now() }, null, 2);
        fs.writeFileSync(IDS_FILE, data, 'utf8');
        console.log(`💾 Saved ${ids.size} IDs to file`);
    } catch (error) {
        console.error('❌ Error saving IDs:', error.message);
    }
}

const usedIds = loadUsedIds();
const players = new Map();

console.log(`📊 Loaded ${usedIds.size} existing IDs from file`);

setInterval(() => {
    saveUsedIds(usedIds);
}, 300000);

server.on('connection', (ws) => {
    let player_id = null;
    let character = null;
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'auth') {
                player_id = msg.player_id;
                character = msg.character;
                
                if (!usedIds.has(player_id)) {
                    usedIds.add(player_id);
                    saveUsedIds(usedIds);
                }
                
                players.set(player_id, { ws, online: true, character });
                ws.send(JSON.stringify({ type: 'auth_ok' }));
                console.log(`✅ ${player_id} authenticated as ${character}`);
                console.log(`📊 Total players: ${players.size} | Total IDs: ${usedIds.size}`);
                
                for (const [id, player] of players) {
                    if (id !== player_id && player.online) {
                        player.ws.send(JSON.stringify({
                            type: 'friend_online',
                            player_id: player_id,
                            character: character
                        }));
                    }
                }
            }
            else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            else if (msg.type === 'sync_character') {
                const char_id = msg.character;
                if (player_id) {
                    const player = players.get(player_id);
                    if (player) {
                        player.character = char_id;
                        console.log(`🔄 ${player_id} changed character to ${char_id}`);
                        
                        for (const [id, p] of players) {
                            if (id !== player_id && p.online && p.connected_friend === player_id) {
                                p.ws.send(JSON.stringify({
                                    type: 'sync_character',
                                    character: char_id
                                }));
                            }
                        }
                    }
                }
            }
            else if (msg.type === 'friend_request') {
                const target = players.get(msg.to_id);
                if (target && target.online) {
                    target.ws.send(JSON.stringify({
                        type: 'friend_request',
                        from_id: msg.from_id,
                        character: msg.character
                    }));
                    ws.send(JSON.stringify({ type: 'friend_request_sent' }));
                    console.log(`📩 Request from ${msg.from_id} to ${msg.to_id}`);
                } else {
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Friend is offline or does not exist' 
                    }));
                    console.log(`❌ Request to ${msg.to_id} failed - not online`);
                }
            }
            else if (msg.type === 'friend_request_accepted') {
                const acceptor = players.get(msg.from_id);  // کاربر B (قبول کننده)
                const requester = players.get(msg.to_id);   // کاربر A (درخواست دهنده)
                
                console.log(`📥 Accepting request - Acceptor: ${msg.from_id}, Requester: ${msg.to_id}`);
                console.log(`📥 Acceptor character: ${acceptor ? acceptor.character : 'null'}`);
                console.log(`📥 Requester character: ${requester ? requester.character : 'null'}`);
                console.log(`📥 Received character: ${msg.character}`);
                
                // ============================================================
                // ✅ ارسال به کاربر A (درخواست‌دهنده) - کاراکتر کاربر B
                // ============================================================
                if (requester && requester.online) {
                    const charToSend = msg.character;  // کاراکتر کاربر B
                    requester.ws.send(JSON.stringify({
                        type: 'friend_request_accepted',
                        from_id: msg.from_id,
                        character: charToSend
                    }));
                    console.log(`📤 Sent to ${msg.to_id} (requester): character ${charToSend}`);
                    
                    // ذخیره ارتباط
                    requester.connected_friend = msg.from_id;
                } else {
                    console.log(`❌ Requester ${msg.to_id} not found or offline`);
                }
                
                // ============================================================
                // ✅ ارسال به کاربر B (قبول‌کننده) - کاراکتر کاربر A
                // ============================================================
                if (acceptor && acceptor.online) {
                    const charToSend = requester ? requester.character : 'King';  // کاراکتر کاربر A
                    acceptor.ws.send(JSON.stringify({
                        type: 'friend_request_accepted',
                        from_id: msg.to_id,
                        character: charToSend
                    }));
                    console.log(`📤 Sent to ${msg.from_id} (acceptor): character ${charToSend}`);
                    
                    // ذخیره ارتباط
                    acceptor.connected_friend = msg.to_id;
                } else {
                    console.log(`❌ Acceptor ${msg.from_id} not found or offline`);
                }
                
                console.log(`🎮 ${msg.from_id} accepted request from ${msg.to_id}`);
            }
            else if (msg.type === 'friend_request_rejected') {
                const target = players.get(msg.from_id);
                if (target && target.online) {
                    target.ws.send(JSON.stringify({
                        type: 'friend_request_rejected',
                        from_id: msg.to_id
                    }));
                    console.log(`❌ ${msg.to_id} rejected request from ${msg.from_id}`);
                }
            }
            else if (msg.type === 'check_id') {
                const id_to_check = msg.id;
                const is_used = usedIds.has(id_to_check);
                ws.send(JSON.stringify({
                    type: 'id_check_result',
                    id: id_to_check,
                    is_used: is_used
                }));
                console.log(`🔍 ID check: ${id_to_check} is ${is_used ? 'used' : 'available'}`);
            }
            
        } catch(e) { 
            console.error('❌ Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        if (player_id) {
            players.delete(player_id);
            for (const [id, player] of players) {
                if (player.online) {
                    player.ws.send(JSON.stringify({
                        type: 'friend_offline',
                        player_id: player_id
                    }));
                }
            }
            console.log(`❌ ${player_id} disconnected`);
            console.log(`📊 Total players: ${players.size} | Total IDs: ${usedIds.size}`);
            saveUsedIds(usedIds);
        }
    });
});

setInterval(() => {
    console.log(`📊 STATS | Players: ${players.size} | IDs: ${usedIds.size} | Connections: ${server.clients.size}`);
}, 60000);

process.on('SIGINT', () => {
    console.log('🛑 Saving IDs before shutdown...');
    saveUsedIds(usedIds);
    
    for (const [id, player] of players) {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.close(1000, 'server_shutdown');
        }
    }
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

console.log('🚀 Server running on port', process.env.PORT || 10000);
console.log(`📁 ID storage: ${IDS_FILE}`);
console.log(`📊 Initial IDs loaded: ${usedIds.size}`);