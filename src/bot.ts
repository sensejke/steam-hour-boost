import TelegramBot from 'node-telegram-bot-api';
import { SecureStorage } from './storage';
import { login, logout, isOnline, getActiveAccounts, isPendingReconnect, getPendingReconnects, setEncryptionKey, hasToken, setNotifyCallback, updateGames } from './steamFunctions';
import { Account } from './types';
import { BotConfig } from './types';

interface PendingAccount {
    step: 'username' | 'password' | 'guard_type' | 'shared_secret' | 'games' | 'status';
    data: Partial<Account>;
}

interface PendingEdit {
    type: 'games';
    username: string;
}

export class SteamBoostBot {
    private bot: TelegramBot;
    private storage: SecureStorage;
    private config: BotConfig;
    private pendingAccounts: Map<number, PendingAccount> = new Map();
    private pendingEdits: Map<number, PendingEdit> = new Map();
    private pendingGuardCodes: Map<string, { resolve: (code: string) => void; userId: number }> = new Map();

    constructor(config: BotConfig) {
        this.config = config;
        this.bot = new TelegramBot(config.telegramToken, { polling: true });
        this.storage = new SecureStorage(config.encryptionKey);
        setEncryptionKey(config.encryptionKey); // Set encryption key for tokens
        
        // Set up notification callback
        setNotifyCallback((userId: number, message: string) => {
            this.bot.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch(() => {});
        });
        
        this.setupHandlers();
    }

    private isAllowed(userId: number): boolean {
        return this.config.allowedUsers.includes(userId);
    }

    private mainMenu(): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [
                [{ text: '➕ Добавить аккаунт', callback_data: 'add' }],
                [{ text: '📋 Мои аккаунты', callback_data: 'list' }],
                [{ text: '▶️ Запустить все', callback_data: 'startall' }, { text: '⏹ Остановить все', callback_data: 'stopall' }],
                [{ text: '📊 Статус', callback_data: 'status' }],
                [{ text: '❓ Помощь', callback_data: 'help' }]
            ]
        };
    }

    private backButton(callback: string = 'menu'): TelegramBot.InlineKeyboardMarkup {
        return {
            inline_keyboard: [[{ text: '◀️ Назад', callback_data: callback }]]
        };
    }

    private setupHandlers(): void {
        this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
        this.bot.onText(/\/menu/, (msg) => this.handleMenu(msg));
        this.bot.onText(/\/myid/, (msg) => this.handleMyId(msg));
        this.bot.onText(/\/guard_(\w+) (.+)/, (msg, match) => this.handleGuardCode(msg, match));
        
        this.bot.on('callback_query', (query) => this.handleCallback(query));
        this.bot.on('message', (msg) => this.handleMessage(msg));
    }

    private async handleStart(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId,
            `🎮 *Steam Hour Boost Bot*\n\n` +
            `Безопасная накрутка часов в Steam.\n` +
            `Все данные зашифрованы AES-256.\n\n` +
            `Выбери действие:`,
            { parse_mode: 'Markdown', reply_markup: this.mainMenu() }
        );
    }

    private async handleMenu(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId, '🎮 *Главное меню*', { parse_mode: 'Markdown', reply_markup: this.mainMenu() });
    }

    private async handleMyId(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;
        await this.bot.sendMessage(chatId, `🆔 Твой Telegram ID: \`${userId}\``, { parse_mode: 'Markdown', reply_markup: this.backButton() });
    }

    private async handleGuardCode(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
        const chatId = msg.chat.id;
        if (!match) return;
        
        const username = match[1];
        const code = match[2].trim();
        
        const pending = this.pendingGuardCodes.get(username);
        if (pending) {
            pending.resolve(code);
            this.pendingGuardCodes.delete(username);
            await this.bot.sendMessage(chatId, `✅ Код принят для ${username}`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏠 В меню', callback_data: 'menu' }]
                    ]
                }
            });
        } else {
            await this.bot.sendMessage(chatId, `⚠️ Код для ${username} не ожидается или истёк таймаут.`, {
                reply_markup: this.mainMenu()
            });
        }
        
        // Delete message with code
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
    }

    private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        const userId = query.from.id;
        const data = query.data;

        if (!chatId || !messageId || !data) return;
        await this.bot.answerCallbackQuery(query.id);

        if (!this.isAllowed(userId) && data !== 'menu') {
            await this.bot.editMessageText('⛔ У тебя нет доступа к этому боту.', { chat_id: chatId, message_id: messageId });
            return;
        }

        if (data === 'menu') {
            this.pendingAccounts.delete(userId);
            await this.bot.editMessageText('🎮 *Главное меню*', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.mainMenu() });
        } else if (data === 'add') {
            await this.startAddAccount(chatId, messageId, userId);
        } else if (data === 'list') {
            await this.showAccountList(chatId, messageId, userId);
        } else if (data === 'startall') {
            await this.handleStartAll(chatId, messageId, userId);
        } else if (data === 'stopall') {
            await this.handleStopAll(chatId, messageId, userId);
        } else if (data === 'status') {
            await this.showStatus(chatId, messageId, userId);
        } else if (data === 'help') {
            await this.showHelp(chatId, messageId);
        } else if (data.startsWith('acc_')) {
            const username = data.replace('acc_', '');
            await this.showAccountDetails(chatId, messageId, userId, username);
        } else if (data.startsWith('start_')) {
            const username = data.replace('start_', '');
            await this.startBoost(chatId, messageId, userId, username);
        } else if (data.startsWith('stop_')) {
            const username = data.replace('stop_', '');
            await this.stopBoost(chatId, messageId, userId, username);
        } else if (data.startsWith('delete_')) {
            const username = data.replace('delete_', '');
            await this.confirmDelete(chatId, messageId, username);
        } else if (data.startsWith('confirm_delete_')) {
            const username = data.replace('confirm_delete_', '');
            await this.deleteAccount(chatId, messageId, userId, username);
        } else if (data.startsWith('guard_')) {
            const guardType = data.replace('guard_', '');
            await this.handleGuardTypeSelection(chatId, messageId, userId, guardType);
        } else if (data.startsWith('status_')) {
            const status = data.replace('status_', '');
            await this.handleStatusSelection(chatId, messageId, userId, status);
        } else if (data.startsWith('editgames_')) {
            const username = data.replace('editgames_', '');
            await this.startEditGames(chatId, messageId, userId, username);
        }
    }

    private async startAddAccount(chatId: number, messageId: number, userId: number): Promise<void> {
        this.pendingAccounts.set(userId, { step: 'username', data: { ownerId: userId } });
        await this.bot.editMessageText(
            '➕ *Добавление аккаунта*\n\n📝 Введи *логин* Steam:',
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
        );
    }

    private async handleMessage(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;
        const text = msg.text;

        if (!userId || !text) return;
        
        // Skip commands
        if (text.startsWith('/')) return;

        // Check if user is in account adding flow
        const pending = this.pendingAccounts.get(userId);
        
        // Check if user is editing games
        const pendingEdit = this.pendingEdits.get(userId);
        if (pendingEdit && pendingEdit.type === 'games') {
            await this.handleEditGames(chatId, userId, text, pendingEdit.username);
            return;
        }
        
        if (!pending) {
            // Not in any flow - show start message
            await this.bot.sendMessage(chatId,
                '👋 Привет! Напиши /start чтобы открыть меню бота.',
                { reply_markup: this.mainMenu() }
            );
            return;
        }

        // Delete sensitive messages
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

        if (pending.step === 'username') {
            pending.data.username = text.trim();
            pending.step = 'password';
            await this.bot.sendMessage(chatId, '🔐 Введи *пароль*:', { parse_mode: 'Markdown', reply_markup: this.backButton() });
        } else if (pending.step === 'password') {
            pending.data.password = text.trim();
            pending.step = 'guard_type';
            await this.bot.sendMessage(chatId,
                '🛡 Выбери тип Steam Guard:',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📱 Мобильный (2FA код)', callback_data: 'guard_mobile' }],
                            [{ text: '📧 Email код', callback_data: 'guard_email' }],
                            [{ text: '🔑 Shared Secret (авто)', callback_data: 'guard_secret' }],
                            [{ text: '❌ Без Guard', callback_data: 'guard_none' }],
                            [{ text: '◀️ Назад', callback_data: 'menu' }]
                        ]
                    }
                }
            );
        } else if (pending.step === 'shared_secret') {
            pending.data.sharedSecret = text.trim();
            pending.step = 'games';
            await this.bot.sendMessage(chatId,
                '🎮 Введи *игры* через запятую:\n\n' +
                '• AppID (например: `730` для CS2)\n' +
                '• Или текст для кастомной игры: `t.me/sensejke`\n\n' +
                'Пример: `730, t.me/sensejke, 570`',
                { parse_mode: 'Markdown', reply_markup: this.backButton() }
            );
        } else if (pending.step === 'games') {
            const games: (number | string)[] = text.split(',').map(g => {
                const trimmed = g.trim();
                const num = parseInt(trimmed);
                return isNaN(num) ? trimmed : num;
            });
            pending.data.games = games;
            pending.step = 'status';
            await this.bot.sendMessage(chatId,
                '📊 Выбери статус:',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🟢 Online', callback_data: 'status_Online' }],
                            [{ text: '🟡 Away', callback_data: 'status_Away' }],
                            [{ text: '⚫ Invisible', callback_data: 'status_Invisible' }],
                            [{ text: '🔴 Offline', callback_data: 'status_Offline' }],
                            [{ text: '◀️ Назад', callback_data: 'menu' }]
                        ]
                    }
                }
            );
        }
    }

    private async handleGuardTypeSelection(chatId: number, messageId: number, userId: number, guardType: string): Promise<void> {
        const pending = this.pendingAccounts.get(userId);
        if (!pending) return;

        if (guardType === 'secret') {
            pending.step = 'shared_secret';
            await this.bot.editMessageText(
                '🔑 Введи *Shared Secret* (из maFile или SDA):',
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
            );
        } else if (guardType === 'mobile') {
            pending.data.guardType = 'mobile';
            pending.step = 'games';
            await this.bot.editMessageText(
                '📱 *Мобильный Guard*\n\n' +
                'При входе бот попросит ввести код из приложения Steam.\n\n' +
                '🎮 Теперь введи *игры* через запятую:\n' +
                '• AppID: `730` (CS2), `570` (Dota 2)\n' +
                '• Кастом: `t.me/sensejke`\n\n' +
                'Пример: `730, t.me/sensejke`',
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
            );
        } else if (guardType === 'email') {
            pending.data.guardType = 'email';
            pending.step = 'games';
            await this.bot.editMessageText(
                '📧 *Email Guard*\n\n' +
                'При входе бот попросит ввести код из письма.\n\n' +
                '🎮 Теперь введи *игры* через запятую:\n' +
                '• AppID: `730` (CS2), `570` (Dota 2)\n' +
                '• Кастом: `t.me/sensejke`\n\n' +
                'Пример: `730, t.me/sensejke`',
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
            );
        } else {
            pending.data.guardType = 'none';
            pending.step = 'games';
            await this.bot.editMessageText(
                '🎮 Введи *игры* через запятую:\n\n' +
                '• AppID: `730` (CS2), `570` (Dota 2)\n' +
                '• Кастом: `t.me/sensejke`\n\n' +
                'Пример: `730, t.me/sensejke`',
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
            );
        }
    }

    private async handleStatusSelection(chatId: number, messageId: number, userId: number, status: string): Promise<void> {
        const pending = this.pendingAccounts.get(userId);
        if (!pending || !pending.data.username || !pending.data.password || !pending.data.games) return;

        const account: Account = {
            username: pending.data.username,
            password: pending.data.password,
            sharedSecret: pending.data.sharedSecret,
            guardType: pending.data.guardType || 'none',
            games: pending.data.games,
            status: status as Account['status'],
            ownerId: userId
        };

        this.storage.addAccount(account);
        this.pendingAccounts.delete(userId);

        const gamesDisplay = account.games.map(g => typeof g === 'string' ? `"${g}"` : g).join(', ');
        
        await this.bot.editMessageText(
            `✅ *Аккаунт добавлен!*\n\n` +
            `👤 Логин: \`${account.username}\`\n` +
            `🎮 Игры: ${gamesDisplay}\n` +
            `📊 Статус: ${status}\n` +
            `🛡 Guard: ${account.guardType}`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '▶️ Запустить сейчас', callback_data: `start_${account.username}` }],
                        [{ text: '◀️ В меню', callback_data: 'menu' }]
                    ]
                }
            }
        );
    }

    private async showAccountList(chatId: number, messageId: number, userId: number): Promise<void> {
        const accounts = this.storage.loadAccounts().filter(a => a.ownerId === userId);

        if (accounts.length === 0) {
            await this.bot.editMessageText('📭 У тебя нет добавленных аккаунтов.',
                { chat_id: chatId, message_id: messageId, reply_markup: this.backButton() });
            return;
        }

        const buttons = accounts.map(acc => {
            const online = isOnline(acc.username);
            const emoji = online ? '🟢' : '🔴';
            return [{ text: `${emoji} ${acc.username}`, callback_data: `acc_${acc.username}` }];
        });
        buttons.push([{ text: '◀️ Назад', callback_data: 'menu' }]);

        await this.bot.editMessageText('📋 *Твои аккаунты:*\n\nВыбери аккаунт для управления:',
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }

    private async showAccountDetails(chatId: number, messageId: number, userId: number, username: string): Promise<void> {
        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.editMessageText('❌ Аккаунт не найден.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton('list') });
            return;
        }

        const online = isOnline(username);
        const pending = isPendingReconnect(username);
        const tokenSaved = hasToken(username);
        
        let statusEmoji = '🔴 Оффлайн';
        if (online) statusEmoji = '🟢 Онлайн';
        else if (pending) statusEmoji = '🟡 Ожидает переподключения';
        
        const gamesDisplay = account.games.map(g => typeof g === 'string' ? `"${g}"` : g).join(', ');
        
        // Can auto-reconnect if has token, shared secret, or no guard
        const canAutoReconnect = tokenSaved || account.sharedSecret || account.guardType === 'none';

        const buttons: TelegramBot.InlineKeyboardButton[][] = [];
        if (online) {
            buttons.push([{ text: '⏹ Остановить', callback_data: `stop_${username}` }]);
        } else {
            buttons.push([{ text: '▶️ Запустить', callback_data: `start_${username}` }]);
        }
        buttons.push([{ text: '🎮 Изменить игры', callback_data: `editgames_${username}` }]);
        buttons.push([{ text: '🗑 Удалить', callback_data: `delete_${username}` }]);
        buttons.push([{ text: '◀️ Назад', callback_data: 'list' }]);

        await this.bot.editMessageText(
            `👤 *${username}*\n\n` +
            `📊 Статус: ${statusEmoji}\n` +
            `🎮 Игры: ${gamesDisplay}\n` +
            `🛡 Guard: ${account.guardType || 'none'}\n` +
            `💾 Токен сохранён: ${tokenSaved ? '✅' : '❌'}\n` +
            `🔄 Авто-реконнект: ${canAutoReconnect ? '✅' : '❌'}`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
        );
    }

    private async startBoost(chatId: number, messageId: number, userId: number, username: string): Promise<void> {
        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.editMessageText('❌ Аккаунт не найден.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton('list') });
            return;
        }

        if (isOnline(username)) {
            await this.bot.editMessageText(`⚠️ *${username}* уже онлайн.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton('list') });
            return;
        }

        await this.bot.editMessageText(`⏳ Запускаю *${username}*...`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        // Guard code callback for manual entry
        const guardCallback = async (type: 'mobile' | 'email'): Promise<string> => {
            const typeText = type === 'mobile' ? 'из приложения Steam' : 'из письма на почту';
            await this.bot.sendMessage(chatId,
                `🛡 *Требуется код Steam Guard*\n\n` +
                `Введи код ${typeText}:\n` +
                `\`/guard_${username} КОД\`\n\n` +
                `Пример: \`/guard_${username} ABC123\``,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ Отмена', callback_data: 'menu' }]
                        ]
                    }
                }
            );

            return new Promise((resolve) => {
                this.pendingGuardCodes.set(username, { resolve, userId });
                // Timeout after 2 minutes
                setTimeout(() => {
                    if (this.pendingGuardCodes.has(username)) {
                        this.pendingGuardCodes.delete(username);
                        resolve('');
                    }
                }, 120000);
            });
        };

        const result = await login(account, guardCallback);
        
        if (result.success) {
            await this.bot.editMessageText(`✅ *${username}* успешно запущен!`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '◀️ К аккаунту', callback_data: `acc_${username}` }], [{ text: '🏠 В меню', callback_data: 'menu' }]] }
            });
        } else {
            await this.bot.editMessageText(`❌ Ошибка входа: ${result.error}`, {
                chat_id: chatId, message_id: messageId,
                reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: `start_${username}` }], [{ text: '◀️ Назад', callback_data: `acc_${username}` }]] }
            });
        }
    }

    private async stopBoost(chatId: number, messageId: number, userId: number, username: string): Promise<void> {
        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.editMessageText('❌ Аккаунт не найден.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton('list') });
            return;
        }

        if (logout(username)) {
            await this.bot.editMessageText(`✅ *${username}* остановлен.`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '◀️ К аккаунту', callback_data: `acc_${username}` }]] }
            });
        } else {
            await this.bot.editMessageText(`⚠️ *${username}* не был онлайн.`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton(`acc_${username}`)
            });
        }
    }

    private async confirmDelete(chatId: number, messageId: number, username: string): Promise<void> {
        await this.bot.editMessageText(
            `⚠️ *Удалить аккаунт ${username}?*\n\nЭто действие нельзя отменить.`,
            {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Да, удалить', callback_data: `confirm_delete_${username}` }],
                        [{ text: '❌ Отмена', callback_data: `acc_${username}` }]
                    ]
                }
            }
        );
    }

    private async deleteAccount(chatId: number, messageId: number, userId: number, username: string): Promise<void> {
        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.editMessageText('❌ Аккаунт не найден.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton('list') });
            return;
        }

        logout(username);
        this.storage.removeAccount(username);
        await this.bot.editMessageText(`✅ Аккаунт *${username}* удалён.`, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton('list')
        });
    }

    private async handleStartAll(chatId: number, messageId: number, userId: number): Promise<void> {
        const accounts = this.storage.loadAccounts().filter(a => a.ownerId === userId);
        if (accounts.length === 0) {
            await this.bot.editMessageText('📭 У тебя нет аккаунтов.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton() });
            return;
        }

        await this.bot.editMessageText(`⏳ Запускаю ${accounts.length} аккаунтов...`, { chat_id: chatId, message_id: messageId });

        let success = 0, failed = 0;
        for (const account of accounts) {
            if (!isOnline(account.username)) {
                // Only auto-start accounts with shared secret (no manual guard)
                if (account.sharedSecret || account.guardType === 'none') {
                    const result = await login(account);
                    if (result.success) success++; else failed++;
                } else {
                    failed++;
                }
            } else {
                success++;
            }
        }

        await this.bot.editMessageText(`✅ Запущено: ${success}\n❌ Ошибок: ${failed}\n\n⚠️ Аккаунты с ручным Guard нужно запускать отдельно.`, {
            chat_id: chatId, message_id: messageId, reply_markup: this.backButton()
        });
    }

    private async handleStopAll(chatId: number, messageId: number, userId: number): Promise<void> {
        const accounts = this.storage.loadAccounts().filter(a => a.ownerId === userId);
        let stopped = 0;
        for (const account of accounts) {
            if (logout(account.username)) stopped++;
        }
        await this.bot.editMessageText(`✅ Остановлено: ${stopped}`, { chat_id: chatId, message_id: messageId, reply_markup: this.backButton() });
    }

    private async showStatus(chatId: number, messageId: number, userId: number): Promise<void> {
        const accounts = this.storage.loadAccounts().filter(a => a.ownerId === userId);
        const activeAccounts = getActiveAccounts();
        const pendingAccounts = getPendingReconnects();
        const userActive = accounts.filter(a => activeAccounts.includes(a.username));
        const userPending = accounts.filter(a => pendingAccounts.includes(a.username));

        await this.bot.editMessageText(
            `📊 *Статус*\n\n` +
            `📁 Всего аккаунтов: ${accounts.length}\n` +
            `🟢 Онлайн: ${userActive.length}\n` +
            `🟡 Ожидают реконнект: ${userPending.length}\n\n` +
            `*Онлайн:* ${userActive.map(a => a.username).join(', ') || 'нет'}\n` +
            `*Ожидают:* ${userPending.map(a => a.username).join(', ') || 'нет'}`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
        );
    }

    private async showHelp(chatId: number, messageId: number): Promise<void> {
        await this.bot.editMessageText(
            `❓ *Помощь*\n\n` +
            `*Как добавить аккаунт:*\n` +
            `1. Нажми "Добавить аккаунт"\n` +
            `2. Введи логин и пароль\n` +
            `3. Выбери тип Steam Guard\n` +
            `4. Укажи игры для накрутки\n\n` +
            `*Типы Steam Guard:*\n` +
            `• 📱 Мобильный — код из приложения\n` +
            `• 📧 Email — код из письма\n` +
            `• 🔑 Shared Secret — автоматически\n` +
            `• ❌ Без Guard — если отключен\n\n` +
            `*Кастомные игры:*\n` +
            `Вместо AppID можно написать текст:\n` +
            `\`t.me/sensejke\` → "Играет в t.me/sensejke"\n\n` +
            `*Авто-реконнект:*\n` +
            `Если ты сам зайдёшь играть, бот подождёт 2 минуты и переподключится автоматически.\n` +
            `⚠️ Работает только с Shared Secret или без Guard.`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton() }
        );
    }

    async startAutoBoost(): Promise<void> {
        console.log('🚀 Starting auto-boost for all accounts...');
        const accounts = this.storage.loadAccounts();

        for (const account of accounts) {
            // Only auto-start accounts with shared secret
            if (!isOnline(account.username) && (account.sharedSecret || account.guardType === 'none')) {
                console.log(`⏳ Auto-starting: ${account.username}`);
                await login(account);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    private async startEditGames(chatId: number, messageId: number, userId: number, username: string): Promise<void> {
        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.editMessageText('❌ Аккаунт не найден.', { chat_id: chatId, message_id: messageId, reply_markup: this.backButton('list') });
            return;
        }

        this.pendingEdits.set(userId, { type: 'games', username });
        const currentGames = account.games.map(g => typeof g === 'string' ? g : g.toString()).join(', ');

        await this.bot.editMessageText(
            `🎮 *Изменение игр для ${username}*\n\n` +
            `Текущие игры: \`${currentGames}\`\n\n` +
            `Введи новый список игр через запятую:\n` +
            `• AppID: \`730\` (CS2), \`570\` (Dota 2)\n` +
            `• Кастом: \`t.me/sensejke\`\n\n` +
            `Пример: \`730, t.me/sensejke, 570\``,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: this.backButton(`acc_${username}`) }
        );
    }

    private async handleEditGames(chatId: number, userId: number, text: string, username: string): Promise<void> {
        this.pendingEdits.delete(userId);

        const account = this.storage.getAccount(username);
        if (!account || account.ownerId !== userId) {
            await this.bot.sendMessage(chatId, '❌ Аккаунт не найден.', { reply_markup: this.backButton('list') });
            return;
        }

        // Parse games
        const games: (number | string)[] = text.split(',').map(g => {
            const trimmed = g.trim();
            const num = parseInt(trimmed);
            return isNaN(num) ? trimmed : num;
        });

        // Update account
        account.games = games;
        this.storage.addAccount(account);

        // Update running games if online
        if (isOnline(username)) {
            updateGames(username, games);
        }

        const gamesDisplay = games.map(g => typeof g === 'string' ? `"${g}"` : g).join(', ');

        await this.bot.sendMessage(chatId,
            `✅ *Игры обновлены для ${username}!*\n\n` +
            `🎮 Новые игры: ${gamesDisplay}\n\n` +
            `${isOnline(username) ? '✅ Изменения применены сразу!' : '⚠️ Изменения применятся при следующем запуске.'}`,
            { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ К аккаунту', callback_data: `acc_${username}` }],
                        [{ text: '🏠 В меню', callback_data: 'menu' }]
                    ]
                }
            }
        );
    }
}
