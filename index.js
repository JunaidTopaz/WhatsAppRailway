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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE and listening!');
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    // Listen for ALL message events (notify and append types)
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                
                // Ignore status broadcast updates
                if (remoteJid.includes('status@broadcast')) continue;

                // Extract text from standard text, extended text, or media caption
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             '';

                if (!text.trim()) continue;

                console.log(`📩 [Message Detected] From: ${remoteJid} | Content: "${text}"`);

                // 1. Command Trigger: !remind <task> in <time>
                if (text.toLowerCase().startsWith('!remind')) {
                    console.log('⚡ Handling !remind command...');
                    await handleManualReminder(sock, remoteJid, text);
                    continue;
                }

                // 2. Command Trigger: !gemini <prompt>
                if (text.toLowerCase().startsWith('!gemini')) {
                    console.log('⚡ Handling !gemini command...');
                    await handleGeminiQuery(sock, remoteJid, text);
                    continue;
                }

                // 3. Passive Auto-Detection (runs on regular messages sent by others)
                if (text.length > 8 && !msg.key.fromMe) {
                    console.log('🧠 Analyzing message with Gemini 3.8 Flash...');
                    await parseChatForCommitments(sock, remoteJid, text);
                }
            }
        } catch (err) {
            console.error('❌ Error in messages.upsert handler:', err);
        }
    });
}

async function parseChatForCommitments(sock, jid, text) {
    try {
        const prompt = `Analyze this WhatsApp message received: "${text}". Did the sender promise a task, document, update, or follow-up?`;

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
            console.log(`✅ Auto-reminder queued for ${jid} in ${parsed.delayMinutes}m`);
        }
    } catch (err) {
        console.error('❌ Auto-parse error:', err.message);
    }
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
        console.log(`✅ Manual reminder queued for ${jid} in ${parsed.delayMinutes}m`);
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
            contents: `You are an AI WhatsApp assistant. Answer concisely and clearly:\n${query}`
        });

        await sock.sendMessage(jid, { text: `🤖 *Gemini*: ${res.text}` });
        console.log(`✅ Responded to !gemini query for ${jid}`);
    } catch (err) {
        console.error('❌ Gemini Query Error:', err);
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
