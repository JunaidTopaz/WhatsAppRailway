import dotenv from 'dotenv';
dotenv.config();

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason 
} from '@whiskeysockets/baileys';
import cron from 'node-cron';
import { GoogleGenAI, Type } from '@google/genai';

if (!process.env.GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY environment variable is missing!');
    process.exit(1);
}

const PHONE_NUMBER = process.env.PHONE_NUMBER || "";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const activeReminders = [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/session_data');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        fireInitQueries: false
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        if (!PHONE_NUMBER) {
            console.error('❌ PHONE_NUMBER environment variable is required for pairing code authentication!');
            process.exit(1);
        }
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n==================================================');
                console.log(`🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                console.log('==================================================');
                console.log('Open WhatsApp on phone -> Linked Devices -> Link with Phone Number -> Enter this code.\n');
            } catch (err) {
                console.error('Failed to get pairing code:', err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('⚠️ Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE and ready!');
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) return;

        if (text.toLowerCase().startsWith('!remind')) {
            await handleManualReminder(sock, remoteJid, text);
            return;
        }

        if (text.toLowerCase().startsWith('!gemini')) {
            await handleGeminiQuery(sock, remoteJid, text);
            return;
        }

        if (text.length > 8) {
            await parseChatForCommitments(sock, remoteJid, text);
        }
    });
}

async function parseChatForCommitments(sock, jid, text) {
    try {
        const prompt = `Analyze this WhatsApp message: "${text}". Did the user or sender promise a task, document, or follow-up?`;
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
            activeReminders.push({ jid, reason: parsed.reason, triggerTime, fired: false });

            await sock.sendMessage(jid, { 
                text: `🤖 *Gemini Bot*: Auto-detected commitment. Reminder set in ${parsed.delayMinutes}m: "${parsed.reason}"` 
            });
        }
    } catch (err) {}
}

async function handleManualReminder(sock, jid, fullText) {
    const text = fullText.replace(/^!remind\s*/i, '').trim();
    if (!text) return sock.sendMessage(jid, { text: '🤖 Usage: `!remind <task> in <time>`' });

    try {
        const prompt = `Extract task and delay in minutes from: "${text}". Strictly JSON output.`;
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

        activeReminders.push({ jid, reason: parsed.reason, triggerTime, fired: false });
        await sock.sendMessage(jid, { text: `✅ *Reminder set!* In ${parsed.delayMinutes}m: "${parsed.reason}".` });
    } catch (err) {
        await sock.sendMessage(jid, { text: '❌ Could not parse reminder request.' });
    }
}

async function handleGeminiQuery(sock, jid, fullText) {
    const query = fullText.replace(/^!gemini\s*/i, '').trim();
    if (!query) return sock.sendMessage(jid, { text: '🤖 Usage: `!gemini <question>`' });

    try {
        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: `You are an AI WhatsApp assistant. Query: ${query}`
        });

        await sock.sendMessage(jid, { text: `🤖 *Gemini*: ${res.text}` });
    } catch (err) {
        await sock.sendMessage(jid, { text: '❌ Error querying Gemini.' });
    }
}

async function checkScheduledReminders(sock) {
    const now = new Date();
    for (const reminder of activeReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;
            await sock.sendMessage(reminder.jid, { 
                text: `🔔 *GEMINI FOLLOW-UP REMINDER*\n\n💡 *Task*: ${reminder.reason}` 
            });
        }
    }
}

connectToWhatsApp();
