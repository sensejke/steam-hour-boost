import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Account } from './types';
import { encrypt, decrypt } from './crypto';

const activeClients: Map<string, SteamUser> = new Map();
const accountsToReconnect: Map<string, Account> = new Map();
const reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

// Directory for storing login tokens (no guard needed after first login)
const TOKENS_DIR = path.join(__dirname, '../data/tokens');

// Encryption key - will be set from bot config
let encryptionKey: string = '';

export function setEncryptionKey(key: string): void {
    encryptionKey = key;
}

// Ensure tokens directory exists
if (!fs.existsSync(TOKENS_DIR)) {
    fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

// Clean old cache files (sentry, machine tokens) - keep only .token files
function cleanCache(): void {
    if (!fs.existsSync(TOKENS_DIR)) return;
    
    const files = fs.readdirSync(TOKENS_DIR);
    let cleaned = 0;
    
    for (const file of files) {
        const filePath = path.join(TOKENS_DIR, file);
        const stat = fs.statSync(filePath);
        
        // Skip our encrypted token files
        if (file.endsWith('.token')) continue;
        
        // Delete sentry files, machine auth tokens, and other steam-user cache
        // Also delete files older than 7 days
        const isOld = Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000;
        const isCacheFile = file.includes('sentry') || file.includes('machine') || file.endsWith('.bin');
        
        if (isCacheFile || isOld) {
            try {
                if (stat.isDirectory()) {
                    fs.rmSync(filePath, { recursive: true });
                } else {
                    fs.unlinkSync(filePath);
                }
                cleaned++;
            } catch (e) {
                // Ignore errors
            }
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} cache files`);
    }
}

// Clean cache on startup and every 6 hours
cleanCache();
setInterval(cleanCache, 6 * 60 * 60 * 1000);

function saveToken(username: string, token: string): void {
    if (!encryptionKey) return;
    const tokenPath = path.join(TOKENS_DIR, `${username}.token`);
    const encrypted = encrypt(JSON.stringify({ refreshToken: token }), encryptionKey);
    fs.writeFileSync(tokenPath, encrypted, 'utf8');
}

function loadToken(username: string): string | null {
    if (!encryptionKey) return null;
    const tokenPath = path.join(TOKENS_DIR, `${username}.token`);
    if (!fs.existsSync(tokenPath)) return null;
    
    try {
        const encrypted = fs.readFileSync(tokenPath, 'utf8');
        const decrypted = decrypt(encrypted, encryptionKey);
        const data = JSON.parse(decrypted);
        return data.refreshToken || null;
    } catch (e) {
        console.log(`⚠️ Invalid/corrupted token for ${username}`);
        fs.unlinkSync(tokenPath);
        return null;
    }
}

function deleteToken(username: string): void {
    const tokenPath = path.join(TOKENS_DIR, `${username}.token`);
    if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
    }
}

// Check if account has saved token (can auto-reconnect)
export function hasToken(username: string): boolean {
    return loadToken(username) !== null;
}

// Notification callback - will be set by bot
let notifyCallback: ((userId: number, message: string) => void) | null = null;

export function setNotifyCallback(callback: (userId: number, message: string) => void): void {
    notifyCallback = callback;
}

function notify(account: Account, message: string): void {
    if (notifyCallback && account.ownerId) {
        notifyCallback(account.ownerId, message);
    }
}

// Reconnect delay after disconnect (wait for user to finish playing)
const RECONNECT_DELAY = 60 * 60 * 1000; // 1 hour

async function getGameName(appId: number): Promise<string> {
    try {
        const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
        const data = response.data;
        if (data[appId].success) {
            return data[appId].data.name;
        }
    } catch (error) {
        // Silently fail
    }
    return 'Unknown';
}

type GuardCallback = (type: 'mobile' | 'email') => Promise<string>;

function scheduleReconnect(account: Account): void {
    // Don't schedule if already scheduled
    if (reconnectTimers.has(account.username)) {
        console.log(`⏰ Reconnect already scheduled for ${account.username}`);
        return;
    }
    
    // Can auto-reconnect if: has token OR has shared secret OR no guard
    const tokenExists = hasToken(account.username);
    const canAutoReconnect = tokenExists || account.sharedSecret || account.guardType === 'none';
    
    if (!canAutoReconnect) {
        console.log(`⚠️ ${account.username} has no token yet, can't auto-reconnect`);
        return;
    }

    console.log(`⏰ Scheduling reconnect for ${account.username} in ${RECONNECT_DELAY / 1000 / 60} minutes...`);
    accountsToReconnect.set(account.username, account);

    const timer = setTimeout(async () => {
        console.log(`🔄 Auto-reconnecting ${account.username}...`);
        reconnectTimers.delete(account.username);
        const acc = accountsToReconnect.get(account.username);
        accountsToReconnect.delete(account.username);
        
        if (acc) {
            if (isOnline(acc.username)) {
                console.log(`✅ ${acc.username} is already online, skipping reconnect`);
                return;
            }
            const result = await login(acc);
            if (result.success) {
                notify(acc, `✅ *${acc.username}* автоматически переподключён!`);
            } else {
                console.log(`❌ Reconnect failed for ${acc.username}: ${result.error}`);
                // If still playing elsewhere, wait another hour
                if (result.error?.includes('LoggedInElsewhere')) {
                    console.log(`🎮 User still playing, will retry in 1 hour`);
                    scheduleReconnect(acc);
                }
            }
        }
    }, RECONNECT_DELAY);

    reconnectTimers.set(account.username, timer);
    console.log(`✅ Timer set for ${account.username}`);
}

function cancelReconnect(username: string): void {
    const timer = reconnectTimers.get(username);
    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(username);
    }
    accountsToReconnect.delete(username);
}

export function login(account: Account, guardCallback?: GuardCallback): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
        // Cancel any pending reconnect
        cancelReconnect(account.username);

        // Disconnect existing session if any
        const existing = activeClients.get(account.username);
        if (existing) {
            existing.removeAllListeners();
            existing.logOff();
            activeClients.delete(account.username);
        }

        const steamUser = new SteamUser({
            dataDirectory: TOKENS_DIR, // Store sentry files here
            autoRelogin: true
        });

        const logOnOptions: any = {
            rememberPassword: true,
            machineName: 't.me/sensejke' // Looks like a normal PC
        };

        // Try to use saved refresh token first (encrypted)
        const savedToken = loadToken(account.username);
        if (savedToken) {
            console.log(`🔑 Using saved token for ${account.username}`);
            logOnOptions.refreshToken = savedToken;
            // Don't set accountName or password with refresh token!
        } else {
            // No token - use password login
            logOnOptions.accountName = account.username;
            logOnOptions.password = account.password;
            
            // If shared secret provided, generate 2FA code
            if (account.sharedSecret) {
                logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(account.sharedSecret);
            }
        }

        steamUser.logOn(logOnOptions);

        const timeout = setTimeout(() => {
            steamUser.removeAllListeners();
            resolve({ success: false, error: 'Login timeout (30s)' });
        }, 30000);

        steamUser.on('error', (error) => {
            clearTimeout(timeout);
            console.error(`🔴 Error logging in ${account.username}:`, error.message);
            
            // Remove from active clients - account is not online!
            activeClients.delete(account.username);
            
            // If token is invalid, delete it and retry with password
            if (error.message.includes('InvalidPassword') || error.message.includes('AccessDenied') || error.message.includes('Expired')) {
                deleteToken(account.username);
                console.log(`🗑 Deleted invalid token for ${account.username}`);
            }
            
            steamUser.removeAllListeners();
            
            // Schedule reconnect for temporary errors
            if (error.message.includes('LoggedInElsewhere') || error.message.includes('LogonSessionReplaced') || error.message.includes('RateLimitExceeded')) {
                scheduleReconnect(account);
            }
            
            resolve({ success: false, error: error.message });
        });

        // Save refresh token when received (encrypted)
        steamUser.on('refreshToken', (token) => {
            console.log(`💾 Saving encrypted token for ${account.username}`);
            saveToken(account.username, token);
        });

        // Handle Steam Guard (mobile 2FA)
        steamUser.on('steamGuard', async (domain, callback) => {
            console.log(`🛡 Steam Guard required for ${account.username}, domain: ${domain}`);

            if (guardCallback) {
                const guardType = domain ? 'email' : 'mobile';
                const code = await guardCallback(guardType);
                if (code) {
                    callback(code);
                } else {
                    clearTimeout(timeout);
                    steamUser.removeAllListeners();
                    resolve({ success: false, error: 'Steam Guard code not provided' });
                }
            } else {
                clearTimeout(timeout);
                steamUser.removeAllListeners();
                resolve({ success: false, error: 'Steam Guard required but no callback' });
            }
        });

        steamUser.on('loggedOn', async () => {
            clearTimeout(timeout);
            console.log(`🟢 Logged in: ${account.username}`);

            activeClients.set(account.username, steamUser);
            steamUser.setPersona(SteamUser.EPersonaState[account.status]);

            await playGames(steamUser, account);
            resolve({ success: true });
        });

        // Handle disconnect - auto reconnect!
        steamUser.on('disconnected', (eresult, msg) => {
            console.log(`⚠️ ${account.username} disconnected: ${msg || eresult}`);
            activeClients.delete(account.username);
            
            // Notify user
            notify(account, `⚠️ *${account.username}* отключился: ${msg || eresult}\n\n🔄 Попытка переподключения через 1 час...`);
            
            // Schedule auto-reconnect
            scheduleReconnect(account);
        });

        // Handle "playing elsewhere" - someone started playing on the account
        steamUser.on('playingState', (blocked, playingApp) => {
            if (blocked) {
                console.log(`🎮 ${account.username} blocked - user is playing app ${playingApp}, waiting...`);
                // Don't spam reconnects - just wait for unblock event
            } else {
                console.log(`✅ ${account.username} unblocked - resuming games`);
                // User stopped playing, resume our games
                playGames(steamUser, account);
            }
        });
    });
}

// Play games for account
async function playGames(steamUser: SteamUser, account: Account): Promise<void> {
    const gamesToPlay: any[] = [];
    
    // Find custom game name (string) - only first one works
    const customGame = account.games.find(g => typeof g === 'string');
    
    // Find AppIDs (numbers)
    const appIds = account.games.filter(g => typeof g === 'number') as number[];

    // If custom game name exists, add it as non-Steam game
    if (customGame) {
        gamesToPlay.push({
            game_id: '15190414816125648896',
            game_extra_info: customGame
        });
        console.log(`🎮 Custom: "${customGame}" for ${account.username}`);
    }

    // Add real Steam games by AppID
    for (const appId of appIds) {
        gamesToPlay.push(appId);
        const gameName = await getGameName(appId);
        console.log(`🕹️ ${gameName} (${appId}) for ${account.username}`);
    }

    steamUser.gamesPlayed(gamesToPlay);
}

// Check periodically if user stopped playing - removed, using playingState event instead

export function logout(username: string): boolean {
    // Cancel any pending reconnect
    cancelReconnect(username);
    
    const client = activeClients.get(username);
    if (client) {
        client.removeAllListeners();
        client.logOff();
        activeClients.delete(username);
        return true;
    }
    return false;
}

export function isOnline(username: string): boolean {
    return activeClients.has(username);
}

// Update games for a running account
export async function updateGames(username: string, games: (number | string)[]): Promise<boolean> {
    const client = activeClients.get(username);
    if (!client) return false;

    const gamesToPlay: any[] = [];
    
    // Find custom game name (string) - only first one works
    const customGame = games.find(g => typeof g === 'string');
    
    // Find AppIDs (numbers)
    const appIds = games.filter(g => typeof g === 'number') as number[];

    // If custom game name exists, add it as non-Steam game
    if (customGame) {
        gamesToPlay.push({
            game_id: '15190414816125648896',
            game_extra_info: customGame
        });
        console.log(`🎮 Updated custom: "${customGame}" for ${username}`);
    }

    // Add real Steam games by AppID
    for (const appId of appIds) {
        gamesToPlay.push(appId);
        const gameName = await getGameName(appId);
        console.log(`🕹️ Updated: ${gameName} (${appId}) for ${username}`);
    }

    client.gamesPlayed(gamesToPlay);
    return true;
}

export function isPendingReconnect(username: string): boolean {
    return reconnectTimers.has(username);
}

export function getActiveAccounts(): string[] {
    return Array.from(activeClients.keys());
}

export function getPendingReconnects(): string[] {
    return Array.from(reconnectTimers.keys());
}

export function logoutAll(): void {
    // Cancel all reconnects
    for (const username of reconnectTimers.keys()) {
        cancelReconnect(username);
    }
    
    for (const [username, client] of activeClients) {
        client.removeAllListeners();
        client.logOff();
        console.log(`🔴 Logged out: ${username}`);
    }
    activeClients.clear();
}

// Enable auto-reconnect for an account (call after successful login)
export function enableAutoReconnect(account: Account): void {
    accountsToReconnect.set(account.username, account);
}

// Disable auto-reconnect for an account
export function disableAutoReconnect(username: string): void {
    cancelReconnect(username);
}
