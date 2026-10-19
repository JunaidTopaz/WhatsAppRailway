import dotenv from 'dotenv';
dotenv.config();

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
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
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n==================================================');
            console.log('SCAN THIS QR CODE IN YOUR RAILWAY LOGS WITH WHATSAPP:');
            console.log('==================================================\n');
            // Setting small to false uses full block rendering without line-height gaps
            qrcode.generate(qr, { small: false });
            console.log('\n==================================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('⚠️ Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Bot is ONLINE via Baileys WebSockets!');
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

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
        const prompt = `Analyze this WhatsApp message sent to me: "${text}". Did the sender or user promise a follow-up, document, or task?`;

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
                jid,
                reason: parsed.reason,
                triggerTime,
                fired: false
            });

            await sock.sendMessage(jid, { 
                text: `🤖 *Gemini Bot*: Auto-detected commitment. Reminder set in ${parsed.delayMinutes}m: "${parsed.reason}"` 
            });
        }
    } catch (err) {
        // Silently handle errors
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
            jid,
            reason: parsed.reason,
            triggerTime,
            fired: false
        });

        await sock.sendMessage(jid, { 
            text: `✅ *Reminder set!* I will notify you in ${parsed.delayMinutes} minute(s) about: "${parsed.reason}".` 
        });
    } catch (err) {
        await sock.sendMessage(jid, { text: '❌ Could not parse reminder request.' });
    }
}

async function handleGeminiQuery(sock, jid, fullText) {
    const query = fullText.replace(/^!gemini\s*/i, '').trim();

    if (!query) {
        await sock.sendMessage(jid, { text: '🤖 *Usage*: `!gemini <question or instruction>`' });
        return;
    }

    try {
        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: `You are an AI WhatsApp assistant. User query: ${query}`
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
            const alertText = `🔔 *GEMINI FOLLOW-UP REMINDER*\n\n💡 *Task*: ${reminder.reason}\n\n_Don't forget to send your promised update!_`;
            
            await sock.sendMessage(reminder.jid, { text: alertText });
            console.log(`[Alert Fired] Sent reminder to ${reminder.jid}`);
        }
    }
}

connectToWhatsApp();
