import fs from 'fs';
import path from 'path';
import { encrypt, decrypt } from './crypto';
import { Account } from './types';

const DATA_FILE = path.join(__dirname, '../data/accounts.enc');

export class SecureStorage {
    private encryptionKey: string;

    constructor(encryptionKey: string) {
        this.encryptionKey = encryptionKey;
        this.ensureDataDir();
    }

    private ensureDataDir(): void {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    saveAccounts(accounts: Account[]): void {
        const data = JSON.stringify(accounts);
        const encrypted = encrypt(data, this.encryptionKey);
        fs.writeFileSync(DATA_FILE, encrypted, 'utf8');
    }

    loadAccounts(): Account[] {
        if (!fs.existsSync(DATA_FILE)) {
            return [];
        }
        try {
            const encrypted = fs.readFileSync(DATA_FILE, 'utf8');
            const decrypted = decrypt(encrypted, this.encryptionKey);
            return JSON.parse(decrypted);
        } catch (error) {
            console.error('Failed to decrypt accounts. Wrong key?');
            return [];
        }
    }

    addAccount(account: Account): void {
        const accounts = this.loadAccounts();
        const existingIndex = accounts.findIndex(a => a.username === account.username);
        if (existingIndex >= 0) {
            accounts[existingIndex] = account;
        } else {
            accounts.push(account);
        }
        this.saveAccounts(accounts);
    }

    removeAccount(username: string): boolean {
        const accounts = this.loadAccounts();
        const filtered = accounts.filter(a => a.username !== username);
        if (filtered.length === accounts.length) return false;
        this.saveAccounts(filtered);
        return true;
    }

    getAccount(username: string): Account | undefined {
        return this.loadAccounts().find(a => a.username === username);
    }
}
