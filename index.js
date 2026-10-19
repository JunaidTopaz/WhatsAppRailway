import dotenv from 'dotenv';
dotenv.config();

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
        ]
    }
});

const activeReminders = [];

client.on('qr', (qr) => {
    console.log('Scan this QR code in terminal logs:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 24/7 WhatsApp Gemini Bot running in the cloud!');
    cron.schedule('* * * * *', checkCloudReminders);
});

client.on('message_create', async (msg) => {
    if (msg.isStatus || msg.from === 'status@broadcast') return;

    const chat = await msg.getChat();

    // Direct Command Trigger: !remind me to check budget in 10 days
    if (msg.body.toLowerCase().startsWith('!remind')) {
        await handleManualReminderRequest(msg, chat);
        return;
    }

    // Passive Chat Scan
    if (msg.body.length > 5) {
        await parseChatForReminders(chat);
    }
});

async function parseChatForReminders(chat) {
    try {
        const history = await chat.fetchMessages({ limit: 6 });
        const context = history.map(m => `${m.fromMe ? 'Me' : 'Contact'}: ${m.body}`).join('\n');

        const prompt = `Analyze this WhatsApp chat context. Did "Me" promise a follow-up or task?\n\nContext:\n${context}`;

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
            activeReminders.push({
                chatId: chat.id._serialized,
                reason: parsed.reason,
                triggerTime,
                fired: false
            });

            await chat.sendMessage(`🤖 *Gemini*: Scheduled a reminder in ${parsed.delayMinutes} minute(s): "${parsed.reason}"`);
        }
    } catch (err) {
        console.error("Cloud processing error:", err.message);
    }
}

async function handleManualReminderRequest(msg, chat) {
    const text = msg.body.replace(/^!remind\s*/i, '').trim();
    
    const prompt = `Extract task and delay in minutes from user request: "${text}". Output JSON with fields: "reason" (string), "delayMinutes" (number).`;
    
    try {
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
            reason: parsed.reason,
            triggerTime,
            fired: false
        });

        await msg.reply(`✅ *Reminder set!* I will message you in ${parsed.delayMinutes} minute(s) about: "${parsed.reason}".`);
    } catch (err) {
        await msg.reply("❌ Failed to parse reminder request.");
    }
}

async function checkCloudReminders() {
    const now = new Date();
    for (const reminder of activeReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;
            const message = `🔔 *GEMINI REMINDER*\n\n📌 *Task*: ${reminder.reason}\n\n_Don't forget to send your update!_`;
            await client.sendMessage(reminder.chatId, message);
        }
    }
}

client.initialize();