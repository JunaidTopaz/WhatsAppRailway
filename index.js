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

// Target group chat name where Gemini will operate exclusively
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || "Gemini Control Center";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// In-memory memory & task stores (Persists during runtime)
const scheduledReminders = [];
const savedNotes = [];
let targetGroupJid = null;

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('🚀 24/7 Gemini WhatsApp Executive Bot is ONLINE!');
            
            // Find and bind target group JID by name
            await findAndBindTargetGroup(sock);

            // Schedule Cron background checks
            cron.schedule('*/30 * * * * *', () => checkScheduledReminders(sock));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;

            for (const msg of m.messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                
                // Ignore status broadcast updates
                if (remoteJid.includes('status@broadcast')) continue;

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             '';

                if (!text.trim()) continue;

                // Case 1: Message received in Control Center Group -> Interactive Assistant Chat
                if (targetGroupJid && remoteJid === targetGroupJid) {
                    // Do not process messages sent by the bot itself
                    if (msg.key.fromMe && text.startsWith('🤖')) continue;

                    console.log(`💬 [Control Center Command Received]: "${text}"`);
                    await handleControlCenterInteractiveCommand(sock, targetGroupJid, text);
                    continue;
                }

                // Case 2: Message in any OTHER chat -> Passive Background Observer (Reads & Analyzes)
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

/**
 * Searches user groups to bind to the specified target group name
 */
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

        console.warn(`⚠️ Target group "${TARGET_GROUP_NAME}" not found yet. Please create a WhatsApp group named "${TARGET_GROUP_NAME}".`);
    } catch (err) {
        console.error('❌ Error fetching groups:', err.message);
    }
}

/**
 * Passively analyzes incoming messages from all chats
 */
async function passivelyAnalyzeMessage(sock, chatJid, text) {
    if (!targetGroupJid) return;

    try {
        const prompt = `
        You are an AI Executive Assistant monitoring incoming WhatsApp messages for a busy professional.
        Analyze this incoming message from a contact:
        "${text}"

        Determine if this message contains:
        1. A commitment/promise, action item, deadline, or follow-up requirement.
        2. Important factual information that should be recorded as a structured note (e.g., address, pricing, decision, meeting time).

        Output strictly raw JSON adhering to this schema:
        {
            "hasActionItem": true/false,
            "hasNoteableInfo": true/false,
            "actionReason": "short summary of required follow-up",
            "delayMinutes": 10,
            "noteCategory": "e.g., Client Update / Meeting / Price Quote",
            "noteContent": "concise executive note summary"
        }
        `;

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

        // Record Note & Alert in Control Center Group
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
            console.log(`📝 Logged note to Control Group: ${parsed.noteContent}`);
        }

        // Schedule Follow-Up & Notify Control Center Group
        if (parsed.hasActionItem && parsed.delayMinutes > 0) {
            const triggerTime = new Date(Date.now() + parsed.delayMinutes * 60 * 1000);
            scheduledReminders.push({
                chatJid,
                reason: parsed.actionReason,
                triggerTime,
                fired: false
            });

            await sock.sendMessage(targetGroupJid, {
                text: `⏰ *ACTION ITEM DETECTED*\n\n📌 *Task*: ${parsed.actionReason}\n⏳ *Follow-Up Scheduled In*: ${parsed.delayMinutes} minute(s)`
            });
            console.log(`⏰ Scheduled action reminder in Control Group: ${parsed.actionReason}`);
        }
    } catch (err) {
        console.error('❌ Error during passive analysis:', err.message);
    }
}

/**
 * Handles interactive chats & queries inside the Control Center Group
 */
async function handleControlCenterInteractiveCommand(sock, groupJid, userText) {
    const lowerText = userText.toLowerCase().trim();

    // Query Notes Memory
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

    // Query Pending Reminders
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

    // General Interactive Conversational Request inside Control Center
    try {
        const notesContext = savedNotes.slice(-5).map(n => `[${n.category}]: ${n.content}`).join('\n');
        
        const prompt = `
        You are an AI Executive Assistant operating inside the user's private WhatsApp Control Center group.
        
        Recent Saved Notes Context:
        ${notesContext || 'None'}

        User Prompt: ${userText}
        `;

        const res = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt
        });

        await sock.sendMessage(groupJid, { text: `🤖 ${res.text}` });
    } catch (err) {
        console.error('❌ Control Center response error:', err);
        await sock.sendMessage(groupJid, { text: '❌ Error generating response.' });
    }
}

/**
 * Cron trigger sending reminder alerts directly to the Control Center Group
 */
async function checkScheduledReminders(sock) {
    if (!targetGroupJid) return;

    const now = new Date();
    for (const reminder of scheduledReminders) {
        if (!reminder.fired && now >= reminder.triggerTime) {
            reminder.fired = true;

            await sock.sendMessage(targetGroupJid, {
                text: `🔔 *DUE REMINDER ALERT*\n\n📌 *Task*: ${reminder.reason}\n\n_Make sure to execute or reply to your contact!_`
            });
            console.log(`🔔 Fired reminder into Control Group: ${reminder.reason}`);
        }
    }
}

connectToWhatsApp();
