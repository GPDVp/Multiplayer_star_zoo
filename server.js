// =============================================
// server.js - RENDER OPTIMIZED VERSION
// اولویت: ارسال درخواست دوستی و نمایش کاراکتر
// =============================================
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const server = new WebSocket.Server({ port: PORT });

// ============================================================
// ذخیره‌سازی IDها در مسیر موقت Render
// ============================================================
const IDS_FILE = path.join(process.env.RENDER ? '/tmp' : __dirname, 'ids.json');

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
        const data = JSON.stringify({ 
            ids: Array.from(ids), 
            lastUpdated: Date.now() 
        }, null, 2);
        fs.writeFileSync(IDS_FILE, data, 'utf8');
        console.log(`💾 Saved ${ids.size} IDs to file`);
        return true;
    } catch (error) {
        console.error('❌ Error saving IDs:', error.message);
        return false;
    }
}

// ============================================================
// مقداردهی اولیه
// ============================================================
const usedIds = loadUsedIds();
const players = new Map();

console.log(`📁 ID storage path: ${IDS_FILE}`);
console.log(`📊 Loaded ${usedIds.size} existing IDs from file`);

// ذخیره خودکار هر ۵ دقیقه
setInterval(() => {
    if (usedIds.size > 0) {
        saveUsedIds(usedIds);
    }
}, 300000);

// ============================================================
// مدیریت اتصالات
// ============================================================
server.on('connection', (ws) => {
    let player_id = null;
    let character = null;
    
    console.log('🔗 New client connected');
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            // ============================================================
            // احراز هویت
            // ============================================================
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
                
                // اطلاع به دوستان آنلاین
                for (const [id, player] of players) {
                    if (id !== player_id && player.online) {
                        try {
                            player.ws.send(JSON.stringify({
                                type: 'friend_online',
                                player_id: player_id,
                                character: character
                            }));
                        } catch (e) {
                            console.error(`❌ Error sending online notification:`, e.message);
                        }
                    }
                }
            }
            
            // ============================================================
            // Ping/Pong
            // ============================================================
            else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            
            // ============================================================
            // همگام‌سازی کاراکتر
            // ============================================================
            else if (msg.type === 'sync_character') {
                const char_id = msg.character;
                if (player_id) {
                    const player = players.get(player_id);
                    if (player) {
                        player.character = char_id;
                        console.log(`🔄 ${player_id} changed character to ${char_id}`);
                        
                        // ارسال به دوست متصل
                        for (const [id, p] of players) {
                            if (id !== player_id && p.online && p.connected_friend === player_id) {
                                try {
                                    p.ws.send(JSON.stringify({
                                        type: 'sync_character',
                                        character: char_id
                                    }));
                                    console.log(`📤 Synced character to ${id}`);
                                } catch (e) {
                                    console.error(`❌ Error syncing character:`, e.message);
                                }
                            }
                        }
                    }
                }
            }
            
            // ============================================================
            // ارسال درخواست دوستی (اولویت اصلی)
            // ============================================================
            else if (msg.type === 'friend_request') {
                const target = players.get(msg.to_id);
                if (target && target.online) {
                    try {
                        target.ws.send(JSON.stringify({
                            type: 'friend_request',
                            from_id: msg.from_id,
                            character: msg.character
                        }));
                        ws.send(JSON.stringify({ type: 'friend_request_sent' }));
                        console.log(`📩 Friend request from ${msg.from_id} to ${msg.to_id}`);
                    } catch (e) {
                        console.error(`❌ Error sending request:`, e.message);
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Failed to send request' 
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Friend is offline or does not exist' 
                    }));
                    console.log(`❌ Request to ${msg.to_id} failed - not online`);
                }
            }
            
            // ============================================================
            // پذیرش درخواست دوستی (اولویت اصلی - نمایش کاراکتر)
            // ============================================================
            else if (msg.type === 'friend_request_accepted') {
                const acceptor = players.get(msg.from_id);  // کاربر B (قبول‌کننده)
                const requester = players.get(msg.to_id);   // کاربر A (درخواست‌دهنده)
                
                console.log(`📥 Accepting friend request - Acceptor: ${msg.from_id}, Requester: ${msg.to_id}`);
                console.log(`📥 Acceptor character: ${acceptor ? acceptor.character : 'null'}`);
                console.log(`📥 Requester character: ${requester ? requester.character : 'null'}`);
                
                // ============================================================
                // ارسال به کاربر A (درخواست‌دهنده) - کاراکتر کاربر B
                // ============================================================
                if (requester && requester.online) {
                    const charToSend = acceptor ? acceptor.character : 'King';
                    try {
                        requester.ws.send(JSON.stringify({
                            type: 'friend_request_accepted',
                            from_id: msg.from_id,
                            character: charToSend
                        }));
                        console.log(`📤 Sent to ${msg.to_id} (requester): character ${charToSend}`);
                        requester.connected_friend = msg.from_id;
                    } catch (e) {
                        console.error(`❌ Error sending to requester:`, e.message);
                    }
                } else {
                    console.log(`❌ Requester ${msg.to_id} not found or offline`);
                }
                
                // ============================================================
                // ارسال به کاربر B (قبول‌کننده) - کاراکتر کاربر A
                // ============================================================
                if (acceptor && acceptor.online) {
                    const charToSend = requester ? requester.character : 'Queen';
                    try {
                        acceptor.ws.send(JSON.stringify({
                            type: 'friend_request_accepted',
                            from_id: msg.to_id,
                            character: charToSend
                        }));
                        console.log(`📤 Sent to ${msg.from_id} (acceptor): character ${charToSend}`);
                        acceptor.connected_friend = msg.to_id;
                    } catch (e) {
                        console.error(`❌ Error sending to acceptor:`, e.message);
                    }
                } else {
                    console.log(`❌ Acceptor ${msg.from_id} not found or offline`);
                }
                
                console.log(`🎮 ${msg.from_id} accepted request from ${msg.to_id}`);
            }
            
            // ============================================================
            // رد درخواست دوستی
            // ============================================================
            else if (msg.type === 'friend_request_rejected') {
                const target = players.get(msg.from_id);
                if (target && target.online) {
                    try {
                        target.ws.send(JSON.stringify({
                            type: 'friend_request_rejected',
                            from_id: msg.to_id
                        }));
                        console.log(`❌ ${msg.to_id} rejected request from ${msg.from_id}`);
                    } catch (e) {
                        console.error(`❌ Error sending rejection:`, e.message);
                    }
                }
            }
            
            // ============================================================
            // بررسی ID
            // ============================================================
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
            console.error('❌ Error processing message:', e.message);
        }
    });
    
    // ============================================================
    // قطع اتصال
    // ============================================================
    ws.on('close', () => {
        if (player_id) {
            players.delete(player_id);
            
            // اطلاع به دوستان
            for (const [id, player] of players) {
                if (player.online) {
                    if (player.connected_friend === player_id) {
                        player.connected_friend = null;
                    }
                    try {
                        player.ws.send(JSON.stringify({
                            type: 'friend_offline',
                            player_id: player_id
                        }));
                    } catch (e) {
                        console.error(`❌ Error sending offline notification:`, e.message);
                    }
                }
            }
            console.log(`❌ ${player_id} disconnected`);
            console.log(`📊 Total players: ${players.size} | Total IDs: ${usedIds.size}`);
            saveUsedIds(usedIds);
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
    });
});

// ============================================================
// آمار سرور
// ============================================================
setInterval(() => {
    console.log(`📊 STATS | Players: ${players.size} | IDs: ${usedIds.size} | Connections: ${server.clients.size}`);
}, 60000);

// ============================================================
// مدیریت خاموشی
// ============================================================
process.on('SIGINT', () => {
    console.log('🛑 Saving IDs before shutdown...');
    saveUsedIds(usedIds);
    
    for (const [id, player] of players) {
        if (player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.close(1000, 'server_shutdown');
            } catch (e) {
                console.error(`❌ Error closing connection:`, e.message);
            }
        }
    }
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// ============================================================
// راه‌اندازی سرور
// ============================================================
console.log('🚀 Server running on port', PORT);
console.log(`📁 ID storage: ${IDS_FILE}`);
console.log(`📊 Initial IDs loaded: ${usedIds.size}`);
console.log(`🌐 WebSocket URL: wss://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}:${PORT}`);