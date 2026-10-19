import dotenv from 'dotenv';
dotenv.config();

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import { GoogleGenAI, Type } from '@google/genai';

// Guard against missing API key
if (!process.env.GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY environment variable is not set!');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Launch WhatsApp client using the Docker container's system Chromium
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/session_data' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

const activeReminders = [];

client.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('SCAN THIS QR CODE IN YOUR RAILWAY LOGS WITH WHATSAPP');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
    console.log('\n==================================================\n');
});

client.on('ready', () => {
    console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE on Railway!');
    cron.schedule('*/30 * * * * *', checkScheduledReminders);
});

client.on('message_create', async (msg) => {
    if (msg.isStatus || msg.from === 'status@broadcast') return;

    const chat = await msg.getChat();

    if (msg.body.toLowerCase().startsWith('!remind')) {
        await handleManualReminder(msg, chat);
        return;
    }

    if (msg.body.toLowerCase().startsWith('!gemini')) {
        await handleGeminiQuery(msg, chat);
        return;
    }

    if (msg.body.length > 5) {
        await parseChatForCommitments(chat);
    }
});

async function parseChatForCommitments(chat) {
    try {
        const history = await chat.fetchMessages({ limit: 6 });
        const context = history.map(m => `${m.fromMe ? 'Me' : 'Contact'}: ${m.body}`).join('\n');

        const prompt = `Analyze this WhatsApp chat context. Did "Me" promise a follow-up, document, or task to "Contact"?\n\nContext:\n${context}`;

        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        hasReminder: { type: Type.BOOLEAN },
                        reason: { type: Type.STRING },
                        delayMinutes: { type: Type.NUMBER }
                    },
                    required: ['hasReminder']
                }
            }
        });

        const parsed = JSON.parse(res.text);

        if (parsed.hasReminder && parsed.delayMinutes > 0) {
            const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);
            
            const duplicate = activeReminders.some(r => r.chatId === chat.id._serialized && !r.fired);
            if (!duplicate) {
                activeReminders.push({
                    chatId: chat.id._serialized,
                    chatName: chat.name || 'Contact',
                    reason: parsed.reason,
                    triggerTime,
                    fired: false
                });

                console.log(`[Auto-Reminder Scheduled] ${chat.name} | Delay: ${parsed.delayMinutes}m | Task: ${parsed.reason}`);
                await chat.sendMessage(`🤖 *Gemini Bot*: Auto-detected commitment. Reminder scheduled in ${parsed.delayMinutes}m: "${parsed.reason}"`);
            }
        }
    } catch (err) {
        // Skip background errors
    }
}

async function handleManualReminder(msg, chat) {
    const text = msg.body.replace(/^!remind\s*/i, '').trim();

    if (!text) {
        await msg.reply('🤖 *Usage*: `!remind <task description> in <time>` (e.g. `!remind send contract in 10 minutes`)');
        return;
    }

    try {
        const prompt = `Extract task description and delay duration in total minutes from user request: "${text}". Output strictly JSON.`;
        
        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        reason: { type: Type.STRING },
                        delayMinutes: { type: Type.NUMBER }
                    },
                    required: ['reason', 'delayMinutes']
                }
            }
        });

        const parsed = JSON.parse(res.text);
        const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);

        activeReminders.push({
            chatId: chat.id._serialized,
            chatName: chat.name || 'Contact',
            reason: parsed.reason,
            triggerTime,
            fired: false
        });

        await msg.reply(`✅ *Reminder set!* I will notify you in ${parsed.delayMinutes} minute(s) about: "${parsed.reason}".`);
    } catch (err) {
        await msg.reply('❌ Could not parse reminder request.');
    }
}

async function handleGeminiQuery(msg, chat) {
    const query = msg.body.replace(/^!gemini\s*/i, '').trim();

    if (!query) {
        await msg.reply('🤖 *Usage*: `!gemini <question or instruction>`');
        return;
    }

    try {
        const history = await chat.fetchMessages({ limit: 8 });
        const context = history.map(m => `${m.fromMe ? 'Me' : 'Contact'}: ${m.body}`).join('\n');

        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: `You are an AI WhatsApp assistant.\n\nChat Context:\n${context}\n\nUser Query: ${query}`
        });

        await msg.reply(`🤖 *Gemini*: ${res.text}`);
    } catch (err) {
        await msg.reply('❌ Error querying Gemini.');
    }
}

async function checkScheduledReminders() {
    const now = new Date();
    for (const reminder of activeReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;
            const alertText = `🔔 *GEMINI FOLLOW-UP REMINDER*\n\n📌 *Target*: ${reminder.chatName}\n💡 *Task*: ${reminder.reason}\n\n_Don't forget to send your promised update!_`;
            
            await client.sendMessage(reminder.chatId, alertText);
            console.log(`[Alert Fired] Sent reminder to ${reminder.chatName}`);
        }
    }
}

client.initialize();
