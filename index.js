import dotenv from 'dotenv';
dotenv.config();

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason 
} from '@whiskeysockets/baileys';
import cron from 'node-cron';
import { GoogleGenAI, Type } from '@google/genai';

console.log("🚀 Starting Node.js process...");

if (!process.env.GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY environment variable is missing!');
    process.exit(1);
}

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, '');
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || "Gemini Control Center";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const scheduledReminders = [];
const savedNotes = [];
let targetGroupJid = null;

async function connectToWhatsApp() {
    console.log("⚡ Loading persistent authentication state...");
    const { state, saveCreds } = await useMultiFileAuthState('/app/session_data');

    console.log("⚡ Initializing Baileys WhatsApp Socket...");
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
            return;
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Executive Bot is ONLINE!');
            await findAndBindTargetGroup(sock);
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

                if (targetGroupJid && remoteJid === targetGroupJid) {
                    if (msg.key.fromMe && text.startsWith('🤖')) continue;
                    console.log(`💬 [Control Center Command Received]: "${text}"`);
                    await handleControlCenterInteractiveCommand(sock, targetGroupJid, text);
                    continue;
                }

                if (!msg.key.fromMe) {
                    console.log(`👁️ [Passive Analysis] Chat: ${remoteJid} | Text: "${text}"`);
                    await passivelyAnalyzeMessage(sock, remoteJid, text);
                }
            }
        } catch (err) {
            console.error('❌ Error processing message upsert:', err);
        }
    });
}

async function findAndBindTargetGroup(sock) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const jid in groups) {
            const group = groups[jid];
            if (group.subject.trim().toLowerCase() === TARGET_GROUP_NAME.trim().toLowerCase()) {
                targetGroupJid = jid;
                console.log(`🎯 Bound strictly to Control Group: "${group.subject}" (JID: ${targetGroupJid})`);
                await sock.sendMessage(targetGroupJid, {
                    text: `🤖 *Gemini Executive Control Center Active*\n\nI am now passively reading your incoming chats. I will post action items, reminders, and summaries strictly inside this group.`
                });
                return;
            }
        }
        console.warn(`⚠️ Target group "${TARGET_GROUP_NAME}" not found. Create a WhatsApp group named "${TARGET_GROUP_NAME}".`);
    } catch (err) {
        console.error('❌ Error fetching groups:', err.message);
    }
}

async function passivelyAnalyzeMessage(sock, chatJid, text) {
    if (!targetGroupJid) return;

    try {
        const prompt = `Analyze this message: "${text}". Output strictly raw JSON.`;
        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        hasActionItem: { type: Type.BOOLEAN },
                        hasNoteableInfo: { type: Type.BOOLEAN },
                        actionReason: { type: Type.STRING },
                        delayMinutes: { type: Type.NUMBER },
                        noteCategory: { type: Type.STRING },
                        noteContent: { type: Type.STRING }
                    },
                    required: ['hasActionItem', 'hasNoteableInfo']
                }
            }
        });

        const parsed = JSON.parse(res.text);

        if (parsed.hasNoteableInfo && parsed.noteContent) {
            const noteEntry = {
                timestamp: new Date().toLocaleString(),
                category: parsed.noteCategory || 'General',
                content: parsed.noteContent,
                chatJid
            };
            savedNotes.push(noteEntry);

            await sock.sendMessage(targetGroupJid, {
                text: `📝 *NEW EXECUTIVE NOTE DETECTED*\n\n📌 *Category*: ${noteEntry.category}\n💡 *Details*: ${noteEntry.content}\n🕒 *Time*: ${noteEntry.timestamp}`
            });
        }

        if (parsed.hasActionItem && parsed.delayMinutes > 0) {
            const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);
            scheduledReminders.push({ chatJid, reason: parsed.actionReason, triggerTime, fired: false });

            await sock.sendMessage(targetGroupJid, {
                text: `⏰ *ACTION ITEM DETECTED*\n\n📌 *Task*: ${parsed.actionReason}\n⏳ *Follow-Up Scheduled In*: ${parsed.delayMinutes} minute(s)`
            });
        }
    } catch (err) {}
}

async function handleControlCenterInteractiveCommand(sock, groupJid, userText) {
    const lowerText = userText.toLowerCase().trim();

    if (lowerText.includes('show notes') || lowerText.includes('list notes')) {
        if (savedNotes.length === 0) {
            await sock.sendMessage(groupJid, { text: '📝 *Gemini*: No notes logged yet today.' });
            return;
        }

        let formattedNotes = `📝 *SAVED EXECUTIVE NOTES (${savedNotes.length})*\n\n`;
        savedNotes.forEach((n, idx) => {
            formattedNotes += `${idx + 1}. *[${n.category}]* ${n.content} _(${n.timestamp})_\n`;
        });

        await sock.sendMessage(groupJid, { text: formattedNotes });
        return;
    }

    if (lowerText.includes('show reminders') || lowerText.includes('list reminders')) {
        const pending = scheduledReminders.filter(r => !r.fired);
        if (pending.length === 0) {
            await sock.sendMessage(groupJid, { text: '⏰ *Gemini*: No pending reminders active.' });
            return;
        }

        let formattedReminders = `⏰ *ACTIVE PENDING REMINDERS (${pending.length})*\n\n`;
        pending.forEach((r, idx) => {
            formattedReminders += `${idx + 1}. ${r.reason} _(Due: ${r.triggerTime.toLocaleTimeString()})_\n`;
        });

        await sock.sendMessage(groupJid, { text: formattedReminders });
        return;
    }

    try {
        const notesContext = savedNotes.slice(-5).map(n => `[${n.category}]: ${n.content}`).join('\n');
        const prompt = `You are an AI Executive Assistant operating inside the user's private WhatsApp Control Center group. Saved Notes Context:\n${notesContext || 'None'}\n\nUser Prompt: ${userText}`;

        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt
        });

        await sock.sendMessage(groupJid, { text: `🤖 ${res.text}` });
    } catch (err) {
        await sock.sendMessage(groupJid, { text: '❌ Error generating response.' });
    }
}

async function checkScheduledReminders(sock) {
    if (!targetGroupJid) return;

    const now = new Date();
    for (const reminder of scheduledReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;

            await sock.sendMessage(targetGroupJid, {
                text: `🔔 *DUE REMINDER ALERT*\n\n📌 *Task*: ${reminder.reason}\n\n_Make sure to execute or reply to your contact!_`
            });
        }
    }
}

connectToWhatsApp();
