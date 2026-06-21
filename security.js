// =============================================
// security.js - Security Module
// =============================================
const fs = require('fs');
const path = require('path');

// ============================================================
// ✅ CONFIGURATION
// ============================================================
const SECURITY_CONFIG = {
    RATE_LIMIT: {
        window_ms: 60000,
        max_requests: 20
    },
    ID_VALIDATION: {
        min_length: 7,
        max_length: 7,
        format: /^[a-zA-Z0-9]{3}_[a-zA-Z0-9]{3}$/
    },
    MESSAGE_VALIDATION: {
        max_size: 65536,
        allowed_types: [
            'auth', 'ping', 'friend_request', 'friend_request_accepted',
            'friend_request_rejected', 'sync_character', 'get_online_players',
            'leave_room', 'disconnect'
        ]
    }
};

// ============================================================
// ✅ IP BAN MANAGER
// ============================================================
class IPBanManager {
    constructor() {
        this.bannedIPs = new Map();
        this.banFile = path.join(__dirname, 'bans.json');
        this.loadBans();
    }
    
    loadBans() {
        try {
            if (fs.existsSync(this.banFile)) {
                const data = fs.readFileSync(this.banFile, 'utf8');
                const json = JSON.parse(data);
                for (const [ip, banData] of Object.entries(json)) {
                    this.bannedIPs.set(ip, banData);
                }
            }
        } catch (error) {}
    }
    
    saveBans() {
        try {
            const data = {};
            for (const [ip, banData] of this.bannedIPs) {
                data[ip] = banData;
            }
            fs.writeFileSync(this.banFile, JSON.stringify(data, null, 2));
        } catch (error) {}
    }
    
    isBanned(ip) {
        if (!this.bannedIPs.has(ip)) return false;
        const banData = this.bannedIPs.get(ip);
        if (Date.now() > banData.expiresAt) {
            this.bannedIPs.delete(ip);
            this.saveBans();
            return false;
        }
        return true;
    }
    
    banIP(ip, reason = 'Violation', duration = 300000) {
        this.bannedIPs.set(ip, {
            reason: reason,
            bannedAt: Date.now(),
            expiresAt: Date.now() + duration
        });
        this.saveBans();
    }
}

// ============================================================
// ✅ RATE LIMITER
// ============================================================
class RateLimiter {
    constructor() {
        this.requests = new Map();
        this.ipRequests = new Map();
    }
    
    check(playerId, ip) {
        const now = Date.now();
        
        // IP rate limit
        if (ip) {
            const ipData = this.ipRequests.get(ip);
            if (ipData) {
                if (now - ipData.timestamp > SECURITY_CONFIG.RATE_LIMIT.window_ms) {
                    this.ipRequests.set(ip, { count: 1, timestamp: now });
                } else if (ipData.count >= SECURITY_CONFIG.RATE_LIMIT.max_requests * 2) {
                    return { allowed: false, reason: 'IP rate limit exceeded' };
                } else {
                    ipData.count++;
                }
            } else {
                this.ipRequests.set(ip, { count: 1, timestamp: now });
            }
        }
        
        // Player rate limit
        const data = this.requests.get(playerId);
        if (data) {
            if (now - data.timestamp > SECURITY_CONFIG.RATE_LIMIT.window_ms) {
                this.requests.set(playerId, { count: 1, timestamp: now });
                return { allowed: true };
            }
            if (data.count >= SECURITY_CONFIG.RATE_LIMIT.max_requests) {
                return { allowed: false, reason: 'Rate limit exceeded' };
            }
            data.count++;
            return { allowed: true };
        }
        
        this.requests.set(playerId, { count: 1, timestamp: now });
        return { allowed: true };
    }
}

// ============================================================
// ✅ ID VALIDATOR
// ============================================================
class IDValidator {
    constructor() {
        this.usedIds = new Set();
        this.idFile = path.join(__dirname, 'ids.json');
        this.loadIds();
    }
    
    loadIds() {
        try {
            if (fs.existsSync(this.idFile)) {
                const data = fs.readFileSync(this.idFile, 'utf8');
                const json = JSON.parse(data);
                if (json.ids) {
                    for (const id of json.ids) {
                        this.usedIds.add(id);
                    }
                }
            }
        } catch (error) {}
    }
    
    saveIds() {
        try {
            const data = {
                ids: Array.from(this.usedIds),
                lastUpdated: Date.now()
            };
            fs.writeFileSync(this.idFile, JSON.stringify(data, null, 2));
        } catch (error) {}
    }
    
    isValidFormat(id) {
        if (id.length !== SECURITY_CONFIG.ID_VALIDATION.max_length) {
            return { valid: false, reason: 'ID must be 7 characters' };
        }
        if (!SECURITY_CONFIG.ID_VALIDATION.format.test(id)) {
            return { valid: false, reason: 'Invalid ID format (xxx_xxx)' };
        }
        return { valid: true };
    }
    
    isUnique(id) {
        return !this.usedIds.has(id);
    }
    
    registerId(id) {
        this.usedIds.add(id);
        this.saveIds();
    }
}

// ============================================================
// ✅ MESSAGE VALIDATOR
// ============================================================
class MessageValidator {
    constructor() {
        this.allowedTypes = SECURITY_CONFIG.MESSAGE_VALIDATION.allowed_types;
    }
    
    validate(data) {
        if (typeof data !== 'object' || data === null) {
            return { valid: false, reason: 'Invalid message format' };
        }
        
        const size = JSON.stringify(data).length;
        if (size > SECURITY_CONFIG.MESSAGE_VALIDATION.max_size) {
            return { valid: false, reason: 'Message too large' };
        }
        
        if (!data.type) {
            return { valid: false, reason: 'Missing message type' };
        }
        
        if (!this.allowedTypes.includes(data.type)) {
            return { valid: false, reason: 'Invalid message type' };
        }
        
        return { valid: true };
    }
}

// ============================================================
// ✅ CONNECTION MANAGER
// ============================================================
class ConnectionManager {
    constructor() {
        this.connections = new Map();
        this.ipConnections = new Map();
    }
    
    addConnection(playerId, ip, ws) {
        if (this.ipConnections.has(ip)) {
            const ipData = this.ipConnections.get(ip);
            if (ipData.count >= 5) {
                return { success: false, reason: 'Too many connections' };
            }
            ipData.count++;
        } else {
            this.ipConnections.set(ip, { count: 1 });
        }
        
        this.connections.set(playerId, {
            ip: ip,
            ws: ws,
            connectedAt: Date.now(),
            lastActivity: Date.now()
        });
        
        return { success: true };
    }
    
    removeConnection(playerId) {
        const connection = this.connections.get(playerId);
        if (connection) {
            const ip = connection.ip;
            if (this.ipConnections.has(ip)) {
                const ipData = this.ipConnections.get(ip);
                ipData.count--;
                if (ipData.count <= 0) {
                    this.ipConnections.delete(ip);
                }
            }
            this.connections.delete(playerId);
        }
    }
    
    updateActivity(playerId) {
        const connection = this.connections.get(playerId);
        if (connection) {
            connection.lastActivity = Date.now();
        }
    }
}

// ============================================================
// ✅ SECURITY LOGGER
// ============================================================
class SecurityLogger {
    constructor() {
        this.logFile = path.join(__dirname, 'security.log');
    }
    
    log(event, data) {
        const timestamp = new Date().toISOString();
        const logEntry = JSON.stringify({
            timestamp: timestamp,
            event: event,
            data: data
        }) + '\n';
        
        try {
            fs.appendFileSync(this.logFile, logEntry);
        } catch (error) {}
    }
    
    logAuth(playerId, ip, success, reason = '') {
        this.log('AUTH', { playerId, ip, success, reason });
    }
    
    logRateLimit(playerId, ip) {
        this.log('RATE_LIMIT', { playerId, ip });
    }
    
    logError(error) {
        this.log('ERROR', { message: error.message, stack: error.stack });
    }
}

// ============================================================
// ✅ EXPORTS
// ============================================================
module.exports = {
    IPBanManager,
    RateLimiter,
    IDValidator,
    MessageValidator,
    ConnectionManager,
    SecurityLogger,
    SECURITY_CONFIG
};