import { SteamBoostBot } from './bot';
import { BotConfig } from './types';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(__dirname, '../bot-config.json');

function loadConfig(): BotConfig {
    // Priority 1: Environment variables (most secure)
    if (process.env.TELEGRAM_TOKEN && process.env.ENCRYPTION_KEY && process.env.ALLOWED_USERS) {
        console.log('📦 Loading config from environment variables');
        return {
            telegramToken: process.env.TELEGRAM_TOKEN,
            encryptionKey: process.env.ENCRYPTION_KEY,
            allowedUsers: process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim()))
        };
    }

    // Priority 2: Config file
    if (fs.existsSync(CONFIG_PATH)) {
        console.log('📦 Loading config from bot-config.json');
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }

    console.error('❌ No config found!');
    console.log('\nOption 1: Set environment variables:');
    console.log('  export TELEGRAM_TOKEN="your_bot_token"');
    console.log('  export ENCRYPTION_KEY="your_secret_key_min_16_chars"');
    console.log('  export ALLOWED_USERS="123456789,987654321"');
    console.log('\nOption 2: Create bot-config.json');
    process.exit(1);
}

async function main(): Promise<void> {
    console.log('🎮 Steam Hour Boost - Telegram Edition');
    console.log('======================================\n');

    const config = loadConfig();
    
    if (config.encryptionKey.length < 16) {
        console.error('❌ Encryption key must be at least 16 characters!');
        process.exit(1);
    }

    const bot = new SteamBoostBot(config);
    
    // Auto-start all accounts on boot
    await bot.startAutoBoost();
    
    console.log('\n✅ Bot is running! Send /help in Telegram.');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down...');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 Shutting down...');
        process.exit(0);
    });

    // Keep process alive
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled rejection:', reason);
    });
}

main().catch(console.error);
