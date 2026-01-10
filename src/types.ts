export interface Account {
    username: string;
    password: string;
    sharedSecret?: string;
    guardType?: 'none' | 'mobile' | 'email' | 'secret';
    games: (number | string)[]; // number = AppID, string = custom game name
    status: 'Online' | 'Away' | 'Invisible' | 'Offline';
    ownerId: number; // Telegram user ID who owns this account
}

export interface Config {
    accounts: Account[];
}

export interface BotConfig {
    telegramToken: string;
    encryptionKey: string;
    allowedUsers: number[]; // Telegram user IDs allowed to use the bot
}
