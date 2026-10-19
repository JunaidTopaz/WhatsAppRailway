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

// Clean phone number (strips spaces, dashes, + signs)
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, '');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const activeReminders = [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/session_data');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        fireInitQueries: false
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        console.log("📲 Status: Not logged in. Requesting pairing code...");
        if (!PHONE_NUMBER) {
            console.error('❌ ERROR: PHONE_NUMBER environment variable is missing in Railway!');
            process.exit(1);
        }
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n==================================================');
                console.log(`🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                console.log('==================================================');
                console.log('Open WhatsApp -> Linked Devices -> Link with Phone Number -> Enter code.\n');
            } catch (err) {
                console.error('❌ Error requesting pairing code:', err);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE and listening!');
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (remoteJid.includes('status@broadcast')) continue;

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             '';

                if (!text.trim()) continue;

                console.log(`📩 [Message Detected] From: ${remoteJid} | Content: "${text}"`);

                if (text.toLowerCase().startsWith('!remind')) {
                    await handleManualReminder(sock, remoteJid, text);
                    continue;
                }

                if (text.toLowerCase().startsWith('!gemini')) {
                    await handleGeminiQuery(sock, remoteJid, text);
                    continue;
                }

                if (text.length > 8 && !msg.key.fromMe) {
                    await parseChatForCommitments(sock, remoteJid, text);
                }
            }
        } catch (err) {
            console.error('❌ Error processing message:', err);
        }
    });
}

async function parseChatForCommitments(sock, jid, text) {
    try {
        const prompt = `Analyze this WhatsApp message: "${text}". Did the sender make a promise/commitment to send a document, update, or follow-up?`;

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
            console.log(`✅ Auto-reminder scheduled for ${jid} in ${parsed.delayMinutes}m`);
        }
    } catch (err) {}
}

async function handleManualReminder(sock, jid, fullText) {
    const text = fullText.replace(/^!remind\s*/i, '').trim();

    if (!text) {
        await sock.sendMessage(jid, { 
            text: '🤖 *Usage*: `!remind <task description> in <time>` (e.g. `!remind call client in 10 minutes`)' 
        });
        return;
    }

    try {
        const prompt = `Extract task description and delay duration in total minutes from: "${text}". Output strictly JSON.`;

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
        await sock.sendMessage(jid, { 
            text: `✅ *Reminder set!* In ${parsed.delayMinutes}m: "${parsed.reason}".` 
        });
        console.log(`✅ Manual reminder scheduled for ${jid} in ${parsed.delayMinutes}m`);
    } catch (err) {
        await sock.sendMessage(jid, { text: '❌ Could not parse reminder request.' });
    }
}

async function handleGeminiQuery(sock, jid, fullText) {
    const query = fullText.replace(/^!gemini\s*/i, '').trim();

    if (!query) {
        await sock.sendMessage(jid, { text: '🤖 *Usage*: `!gemini <question or prompt>`' });
        return;
    }

    try {
        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: `You are an AI WhatsApp assistant. Answer concisely:\n${query}`
        });

        await sock.sendMessage(jid, { text: `🤖 *Gemini*: ${res.text}` });
        console.log(`✅ Responded to !gemini for ${jid}`);
    } catch (err) {
        console.error('❌ Gemini Error:', err);
        await sock.sendMessage(jid, { text: '❌ Error processing request with Gemini.' });
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
            console.log(`🔔 Reminder fired for ${reminder.jid}`);
        }
    }
}

connectToWhatsApp();
