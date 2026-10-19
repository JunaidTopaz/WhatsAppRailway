import dotenv from 'dotenv';
dotenv.config();

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason 
} from '@whiskeysockets/baileys';
import cron from 'node-cron';
import { GoogleGenAI, Type } from '@google/genai';

console.log("🚀 Starting Gemini Executive Control Center...");

if (!process.env.GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY environment variable is missing!');
    process.exit(1);
}

const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^0-9]/g, '');
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || "Gemini Control Center";

// Stable model with 1,500 daily requests
const MODEL_NAME = 'gemini-3.6-flash';

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
                console.log('==================================================\n');
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

                // Infinite loop guard: Skip messages sent by bot
                if (msg.key.fromMe) {
                    if (text.startsWith('🤖') || text.startsWith('❌') || text.startsWith('📝') || text.startsWith('⏰') || text.startsWith('🔔') || text.startsWith('Got it')) {
                        continue;
                    }
                }

                // Case 1: Control Center Group -> Interactive Commands
                if (targetGroupJid && remoteJid === targetGroupJid) {
                    console.log(`💬 [Control Center Command Received]: "${text}"`);
                    await handleControlCenterInteractiveCommand(sock, targetGroupJid, text);
                    continue;
                }

                // Case 2: Other Chats -> Passive Background Observer
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
        console.warn(`⚠️ Target group "${TARGET_GROUP_NAME}" not found yet. Create a WhatsApp group named "${TARGET_GROUP_NAME}".`);
    } catch (err) {
        console.error('❌ Error fetching groups:', err.message);
    }
}

async function passivelyAnalyzeMessage(sock, chatJid, text) {
    if (!targetGroupJid) return;

    try {
        const prompt = `
        You are an AI Executive Assistant monitoring incoming WhatsApp messages.
        Analyze this incoming message: "${text}"

        Determine if it contains:
        1. A commitment, promise, action item, or follow-up requirement.
        2. Important factual info (address, pricing, meeting time) worth saving as a note.

        Respond ONLY with raw JSON:
        {
            "hasActionItem": true/false,
            "hasNoteableInfo": true/false,
            "actionReason": "short task description",
            "delayMinutes": 10,
            "noteCategory": "e.g., General / Meeting / Price",
            "noteContent": "concise note summary"
        }
        `;

        const res = await ai.models.generateContent({
            model: MODEL_NAME,
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
    } catch (err) {
        console.error('❌ Passive analysis error:', err.message);
    }
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
        
        const prompt = `
        You are an AI Executive Assistant operating inside the user's private WhatsApp Control Center group.
        
        Recent Saved Notes Context:
        ${notesContext || 'None'}

        User Prompt: "${userText}"

        Analyze the user prompt. Is the user asking to set a reminder/timer, or asking a general question/request?
        
        Respond ONLY in raw JSON matching this schema:
        {
            "isReminderRequest": true/false,
            "taskDescription": "clean description of task",
            "delayMinutes": 5,
            "generalResponse": "direct reply to user if not a reminder request"
        }
        `;

        const res = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        isReminderRequest: { type: Type.BOOLEAN },
                        taskDescription: { type: Type.STRING },
                        delayMinutes: { type: Type.NUMBER },
                        generalResponse: { type: Type.STRING }
                    },
                    required: ['isReminderRequest']
                }
            }
        });

        const parsed = JSON.parse(res.text);

        if (parsed.isReminderRequest && parsed.delayMinutes > 0) {
            const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);
            scheduledReminders.push({ chatJid: groupJid, reason: parsed.taskDescription, triggerTime, fired: false });

            await sock.sendMessage(groupJid, {
                text: `🤖 Got it. Reminder set for ${parsed.delayMinutes} minutes from now:\n\n⏰ *Task:* ${parsed.taskDescription}\n⏱️ *Time:* In ${parsed.delayMinutes} minutes\n\nI'll buzz you right here when it's time.`
            });
            return;
        }

        const responseText = parsed.generalResponse || "I've processed your request.";
        await sock.sendMessage(groupJid, { text: `🤖 ${responseText}` });

    } catch (err) {
        console.error('❌ Control Center Error:', err.message);
    }
}

async function checkScheduledReminders(sock) {
    if (!targetGroupJid) return;

    const now = new Date();
    for (const reminder of scheduledReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;

            await sock.sendMessage(targetGroupJid, {
                text: `🔔 *DUE REMINDER ALERT*\n\n📌 *Task*: ${reminder.reason}\n\n_Make sure to check or follow up!_`
            });
        }
    }
}

connectToWhatsApp();
