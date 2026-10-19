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
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('⚠️ Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE and listening!');
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    // Listen to ALL incoming and outgoing chat messages
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remoteJid = msg.key.remoteJid;
            
            // Extract text from various WhatsApp message types
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         '';

            if (!text) return;

            console.log(`📩 [Message Received] From JID: ${remoteJid} | Content: "${text}"`);

            // Command Trigger: !remind <task> in <time>
            if (text.toLowerCase().startsWith('!remind')) {
                console.log('⚡ Processing !remind command...');
                await handleManualReminder(sock, remoteJid, text);
                return;
            }

            // Command Trigger: !gemini <prompt>
            if (text.toLowerCase().startsWith('!gemini')) {
                console.log('⚡ Processing !gemini command...');
                await handleGeminiQuery(sock, remoteJid, text);
                return;
            }

            // Passive Auto-Detection (ignore status/broadcast messages)
            if (text.length > 8 && !remoteJid.includes('status@broadcast')) {
                console.log('🧠 Analyzing context with Gemini 3.8 Flash...');
                await parseChatForCommitments(sock, remoteJid, text);
            }
        } catch (err) {
            console.error('❌ Error handling message:', err.message);
        }
    });
}

async function parseChatForCommitments(sock, jid, text) {
    try {
        const prompt = `Analyze this WhatsApp message: "${text}". Did the sender make a clear commitment or promise to send a document, update, or follow-up in the future?`;
        
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
        console.log('💡 Gemini Analysis Output:', parsed);

        if (parsed.hasReminder && parsed.delayMinutes > 0) {
            const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);
            activeReminders.push({ jid, reason: parsed.reason, triggerTime, fired: false });

            await sock.sendMessage(jid, { 
                text: `🤖 *Gemini Bot*: Auto-detected commitment. Reminder set in ${parsed.delayMinutes}m: "${parsed.reason}"` 
            });
            console.log(`✅ Reminder scheduled for ${jid} in ${parsed.delayMinutes}m`);
        }
    } catch (err) {
        console.error('❌ Gemini Parse Error:', err.message);
    }
}

async function handleManualReminder(sock, jid, fullText) {
    const text = fullText.replace(/^!remind\s*/i, '').trim();
    if (!text) return sock.sendMessage(jid, { text: '🤖 Usage: `!remind <task> in <time>`' });

    try {
        const prompt = `Extract task description and delay duration in total minutes from: "${text}". Strictly JSON output.`;
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
            contents: `You are an AI WhatsApp assistant. Answer concisely: ${query}`
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
            console.log(`🔔 Reminder fired for ${reminder.jid}`);
        }
    }
}

connectToWhatsApp();
