import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import twilio from 'twilio';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ override: true });

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM,
  DOMAIN: rawDomain,
  OPENAI_API_KEY,
} = process.env;

// Constants
const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, '').replace(/\/+$/, '');
const CLAWD_DIR = '/Users/henry_notabot/clawd';
const CACHE_PATH = `${CLAWD_DIR}/voice-realtime/data-cache.json`;
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const VOICE = 'alloy';

// Mode settings
const MODES = {
  standup: {
    name: 'standup',
    silence_duration_ms: 900,
    announcement: "Switching to standup mode — quick and responsive."
  },
  reflective: {
    name: 'reflective', 
    silence_duration_ms: 2500,
    announcement: "Switching to reflective mode. I'll give you more space to think."
  }
};

// Cues that trigger mode switches
const REFLECTIVE_CUES = ['slow down', 'slow it down', 'reflective', 'let me think', 'give me a moment', 'give me a minute', 'mellow mode', 'reflective mode', 'thinking mode', 'take it slow', 'be more patient', 'more time to think', 'brainstorm', 'let\'s think', 'stop interrupt', 'quit interrupt', 'don\'t interrupt', 'let me finish', 'hold on', 'wait a sec'];
const STANDUP_CUES = ['standup mode', 'speed up', 'quick mode', 'back to normal', 'fast mode', 'let\'s move', 'pick up the pace'];

// Detect mode from transcript
function detectModeSwitch(text, currentMode) {
  const lower = text.toLowerCase();
  if (currentMode !== 'reflective') {
    for (const cue of REFLECTIVE_CUES) {
      if (lower.includes(cue)) return 'reflective';
    }
  }
  if (currentMode !== 'standup') {
    for (const cue of STANDUP_CUES) {
      if (lower.includes(cue)) return 'standup';
    }
  }
  return null;
}

// Read cache helper — returns null if stale or missing
function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    const age = Date.now() - new Date(cache.timestamp).getTime();
    if (age > CACHE_MAX_AGE_MS) {
      console.log(`Cache stale (${Math.round(age/60000)} min old)`);
      return null;
    }
    return cache;
  } catch (e) {
    console.log('Cache read error:', e.message);
    return null;
  }
}

// Minimal system prompt — rules and identity only, NO loaded files
function buildSystemMessage() {
  // Load just identity (very small)
  let identity = '';
  try {
    const idPath = `${CLAWD_DIR}/IDENTITY.md`;
    if (existsSync(idPath)) {
      identity = readFileSync(idPath, 'utf8').trim();
    }
  } catch(e) {}

  return `You are Henry III, a sharp and capable AI assistant on a phone call with Paul.
Be concise, helpful, and conversational. You have a regal but friendly vibe.
Keep responses brief — this is voice, not text.

${identity ? `--- YOUR IDENTITY ---\n${identity}\n\n` : ''}
--- ABOUT PAUL ---
Paul is your human. He's a retired tech leader in North Vancouver with kids Ailie and Parker.
His wife is Jen. He has back issues so reducing desk time is important.

--- CRITICAL RULES ---

1. NO DEAD AIR: You MUST speak BEFORE every tool call. Say "Let me check that" or "One moment" — NEVER go silent.

2. NO DUPLICATE TASKS: When Paul discusses an existing task, search first with search_tasks, then use update_task_note. Only use add_task for genuinely NEW tasks.

3. NEVER HALLUCINATE: You cannot see Telegram messages or images directly. Use get_telegram_context tool if Paul asks about recent chat. If you don't have data, say so.

4. HONEST FAILURE OVER FAKE SUCCESS: If a tool fails or returns an error, SAY SO. Never pretend something worked when it didn't. Never invent workarounds or "change the method" silently. Paul prefers hearing "that failed" over fabricated success.

5. TASK CONFIRMATION: Read back task details and get verbal "yes" before creating. EXCEPTION: If Paul says "just do it" or "put it in", submit immediately.

6. SEARCH TIP: Paul's voice may garble task names. Try short keywords. Task titles often start with "Henry:".

6. "Haley" = "Ailie" (voice dictation issue).

--- TOOLS ---
You have tools for weather, calendar, tasks, briefings, and Telegram context.
READ tools (weather, calendar, tasks_due, get_briefing, get_telegram_context) use cached data for speed.
WRITE tools (add_task, update_task_note, create_calendar_event) use live APIs.
search_tasks and get_task always use live API for accuracy.

--- TASK TRIAGE MODE ---
When Paul says "let's do triage" or "triage time", use triage_tasks to get the next batch.
Present tasks ONE AT A TIME. For each task, read: title, age, due date, note preview.
Then ask: "Do it, delegate, defer, delete, or need detail?"

THE 5 D's:
• DO IT → Use schedule_task to set a due date (commits to this sprint)
• DELEGATE → Use delegate_task to assign to Henry (overnight processing)
• DEFER → Use defer_task to move to Someday (removes date, tags Deferred)
• DELETE → Use mark_obsolete to complete and tag as obsolete
• DETAIL → Use get_task to read the full note

After any decision, the task is marked as triaged. Move to the next task.
Keep the pace steady — Paul drives, you execute. Don't lecture on methodology.`;
}

// Tool definitions
const TOOLS = [
  {
    type: 'function',
    name: 'check_weather',
    description: 'Get current weather and forecast. Uses cached data for instant response. Includes North Vancouver, Whistler snow, and Spanish Banks wind.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'Optional specific location (default uses cached North Van + Whistler)' },
      },
    },
  },
  {
    type: 'function',
    name: 'check_calendar',
    description: 'Get today and tomorrow calendar events. Uses cached data for instant response. Includes Paul, Jen, Ailie, and Parker calendars.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days (ignored — always returns today + tomorrow from cache)' },
      },
    },
  },
  {
    type: 'function',
    name: 'get_event_details',
    description: 'Get full details of a calendar event including description/notes. Use when Paul asks "what is that meeting about" or wants details of an event.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Event name or keyword to search for' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'tasks_due',
    description: 'List tasks due soon. Uses cached data showing top priority tasks due today/this week.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time range (ignored — returns cached summary)' },
      },
    },
  },
  {
    type: 'function',
    name: 'get_briefing',
    description: 'Get full morning briefing: weather, calendar, tasks, emails, sitting time, screen time. Uses cached data for instant response.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'get_telegram_context',
    description: 'Get recent Telegram conversation between Paul and text-Henry. Use when Paul asks "what did we discuss" or references chat messages.',
    parameters: {
      type: 'object',
      properties: {
        max_messages: { type: 'number', description: 'Max messages to return (default 20)' },
      },
    },
  },
  {
    type: 'function',
    name: 'search_tasks',
    description: 'Search Toodledo tasks by keyword. Uses LIVE API for accurate real-time search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to find tasks' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'triage_tasks',
    description: 'Get the next batch of tasks for triage. Returns 10 tasks: 6 treadmill (dated but bumping 3+ months) + 2 standby >1yr + 2 standby <1yr. Use the 5 D\'s: DO (schedule it), DELEGATE (assign to Henry), DEFER (to someday), DELETE (kill it), DETAIL (need more info). LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of tasks to return (default 10)' },
      },
    },
  },
  {
    type: 'function',
    name: 'defer_task',
    description: 'Defer a task to Someday/Maybe. Removes due date and adds "Deferred" tag. Use when task is nice-to-have but not essential. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID to defer' },
        reason: { type: 'string', description: 'Optional reason for deferring' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'mark_obsolete',
    description: 'Mark a task as obsolete/done. Completes the task and tags it "obsolete". Use for DELETE decisions in triage. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID to mark obsolete' },
        reason: { type: 'string', description: 'Optional reason why obsolete' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'complete_task',
    description: 'Mark a task as completed (actually done, not obsolete). Use when task is finished. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID to complete' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'set_priority',
    description: 'Set task priority without changing due date. Use for "Someday, High" type decisions. Priority: low, medium, high. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID' },
        priority: { type: 'string', description: 'Priority level: low, medium, or high' },
      },
      required: ['task_id', 'priority'],
    },
  },
  {
    type: 'function',
    name: 'schedule_task',
    description: 'Schedule a task (set a due date). Use for DO decisions in triage. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID to schedule' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD format' },
        priority: { type: 'string', description: 'Optional priority: low, medium, high' },
      },
      required: ['task_id', 'due_date'],
    },
  },
  {
    type: 'function',
    name: 'delegate_task',
    description: 'Delegate a task to Henry. Sets context to Henry and adds "Overnight" tag so Henry works it. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID to delegate' },
        note: { type: 'string', description: 'Optional instructions for Henry' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'mark_triaged',
    description: 'Mark a task as triaged (adds triaged-MMDD tag). Call after any triage decision. LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID that was triaged' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'get_task',
    description: 'Get full details of a task by ID including notes. Uses LIVE API.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'add_task',
    description: 'Add a new task to Toodledo. Uses LIVE API. Confirm details with Paul first unless he says "just do it".',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title. Prefix with "Henry: " if Henry will do it.' },
        folder: { type: 'string', description: 'Folder name (default: pWorkflow)' },
        priority: { type: 'string', description: 'low, medium, or high (default: medium)' },
        duedate: { type: 'string', description: 'Due date YYYY-MM-DD format' },
        star: { type: 'boolean', description: 'Star the task' },
        note: { type: 'string', description: 'Optional note' },
      },
      required: ['title'],
    },
  },
  {
    type: 'function',
    name: 'update_task_note',
    description: 'Append a note to an EXISTING task. Uses LIVE API. Get task_id from search_tasks first.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The Toodledo task ID' },
        note: { type: 'string', description: 'Text to append to existing note' },
      },
      required: ['task_id', 'note'],
    },
  },
  {
    type: 'function',
    name: 'create_calendar_event',
    description: 'Create a calendar event. Uses LIVE API. Confirm details first. Family emails: jen@heth.ca, parker@heth.ca, ailie@heth.ca',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time YYYY-MM-DDTHH:MM:SS (24h Pacific)' },
        end: { type: 'string', description: 'End time YYYY-MM-DDTHH:MM:SS' },
        attendees: { type: 'string', description: 'Comma-separated emails to invite' },
        description: { type: 'string', description: 'Optional description' },
        location: { type: 'string', description: 'Optional location' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    type: 'function',
    name: 'update_calendar_event',
    description: 'Update an existing calendar event (move time, change description, etc). Uses LIVE API. First use get_event_details to find the event ID.',
    parameters: {
      type: 'object',
      properties: {
        event_query: { type: 'string', description: 'Event name to search for' },
        new_start: { type: 'string', description: 'New start time YYYY-MM-DDTHH:MM:SS (optional)' },
        new_end: { type: 'string', description: 'New end time YYYY-MM-DDTHH:MM:SS (optional)' },
        new_description: { type: 'string', description: 'New description/notes (optional)' },
        new_summary: { type: 'string', description: 'New title (optional)' },
        new_location: { type: 'string', description: 'New location (optional)' },
      },
      required: ['event_query'],
    },
  },
  {
    type: 'function',
    name: 'read_email',
    description: 'Search and read emails. Can search henry@heth.ca (full access) or paul@heth.ca (read-only). Returns subject, sender, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (Gmail syntax: from:, subject:, is:unread, etc.)' },
        account: { type: 'string', description: 'Which inbox: "henry" or "paul" (default: henry)' },
        max_results: { type: 'number', description: 'Max emails to return (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'delete_calendar_event',
    description: 'Delete a calendar event. Uses LIVE API. ALWAYS confirm with Paul before deleting.',
    parameters: {
      type: 'object',
      properties: {
        event_query: { type: 'string', description: 'Event name to search for and delete' },
        confirm: { type: 'boolean', description: 'Must be true to proceed with deletion' },
      },
      required: ['event_query', 'confirm'],
    },
  },
  {
    type: 'function',
    name: 'read_full_email',
    description: 'Read the complete body of an email. Use after read_email to get full content. Only works with henry@heth.ca inbox.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID from read_email results' },
      },
      required: ['message_id'],
    },
  },
  {
    type: 'function',
    name: 'forward_email',
    description: 'Forward an email from henry@heth.ca to another address (usually paul@heth.ca). Can include an optional note.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID of email to forward' },
        to: { type: 'string', description: 'Email address to forward to (default: paul@heth.ca)' },
        note: { type: 'string', description: 'Optional note to add above forwarded content' },
      },
      required: ['message_id'],
    },
  },
  {
    type: 'function',
    name: 'write_memory',
    description: 'Write to Henry\'s memory files. Uses LIVE file write.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text to write with heading' },
        target: { type: 'string', description: '"daily" (default) or "longterm" for MEMORY.md' },
      },
      required: ['content'],
    },
  },
  {
    type: 'function',
    name: 'search_memory',
    description: 'Search Henry\'s workspace memory via QMD. Uses LIVE search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'send_message_to_clawdbot',
    description: 'Send a message to text-Henry for tasks you cannot do on call (emails, research).',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The instruction to send' },
      },
      required: ['message'],
    },
  },
  {
    type: 'function',
    name: 'search_web',
    description: 'Search the web for current information. Use for news, facts, prices, or anything not in memory/calendar/tasks.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

// Tool execution — READ tools use cache, WRITE tools use live API
async function executeTool(name, args) {
  try {
    switch (name) {
      // ===== READ TOOLS (CACHE FIRST) =====
      
      case 'check_weather': {
        const cache = readCache();
        if (cache?.voiceSummaries?.weather) {
          console.log('Weather: returning cached data');
          return cache.voiceSummaries.weather;
        }
        // Fallback to live
        console.log('Weather: cache miss, fetching live');
        const loc = args.location || 'North Vancouver';
        const result = execSync(
          `curl -s "wttr.in/${encodeURIComponent(loc)}?format=3"`,
          { timeout: 10000, encoding: 'utf8' }
        );
        return result.trim();
      }

      case 'check_calendar': {
        const cache = readCache();
        if (cache?.voiceSummaries?.calendar) {
          console.log('Calendar: returning cached data');
          const cal = cache.voiceSummaries.calendar;
          return `TODAY:\n${cal.today}\n\nTOMORROW:\n${cal.tomorrow}`;
        }
        // Fallback to live
        console.log('Calendar: cache miss, fetching live');
        const result = execSync(
          `GOG_KEYRING_PASSWORD="henrybot" gog calendar events "paul@heth.ca" --account henry@heth.ca --from today --days 2`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        return result.trim() || 'No upcoming events.';
      }

      case 'get_event_details': {
        const query = args.query?.toLowerCase() || '';
        console.log(`Event details: searching for "${query}"`);
        
        // Try cache first
        const cache = readCache();
        if (cache?.data?.calendar?.eventsWithDetails) {
          const events = cache.data.calendar.eventsWithDetails;
          const match = events.find(e => e.summary?.toLowerCase().includes(query));
          if (match) {
            console.log('Event details: found in cache');
            let details = `EVENT: ${match.summary}\n`;
            details += `WHEN: ${match.start}\n`;
            if (match.location) details += `WHERE: ${match.location}\n`;
            if (match.description) {
              const desc = match.description.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
              details += `DESCRIPTION: ${desc}\n`;
            } else {
              details += `DESCRIPTION: No description set.\n`;
            }
            if (match.attendees) details += `ATTENDEES: ${match.attendees}\n`;
            return details;
          }
        }
        
        // Fallback to live API
        console.log('Event details: cache miss, fetching live');
        try {
          const result = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog calendar events "paul@heth.ca" --account henry@heth.ca --from today --days 7 --query "${query.replace(/"/g, '\\"')}" --json`,
            { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
          );
          const data = JSON.parse(result);
          if (!data.events || data.events.length === 0) {
            return `No event found matching "${query}".`;
          }
          const event = data.events[0];
          let details = `EVENT: ${event.summary || 'Untitled'}\n`;
          details += `WHEN: ${event.start?.dateTime || event.start?.date || 'Unknown'}\n`;
          if (event.location) details += `WHERE: ${event.location}\n`;
          if (event.description) {
            const desc = event.description.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            details += `DESCRIPTION: ${desc}\n`;
          } else {
            details += `DESCRIPTION: No description set.\n`;
          }
          if (event.attendees) {
            const names = event.attendees.map(a => a.displayName || a.email).join(', ');
            details += `ATTENDEES: ${names}\n`;
          }
          return details;
        } catch (e) {
          console.log('Event details error:', e.message);
          return `Could not find event details for "${query}".`;
        }
      }

      case 'tasks_due': {
        const cache = readCache();
        if (cache?.voiceSummaries?.tasks) {
          console.log('Tasks: returning cached data');
          return cache.voiceSummaries.tasks;
        }
        // Fallback to live
        console.log('Tasks: cache miss, fetching live');
        const result = execSync(
          `node scripts/toodledo.js due week`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        return result.trim() || 'No tasks due.';
      }

      case 'get_briefing': {
        const cache = readCache();
        if (cache?.voiceSummaries) {
          console.log('Briefing: returning cached data');
          const s = cache.voiceSummaries;
          return `WEATHER:\n${s.weather}\n\nCALENDAR TODAY:\n${s.calendar?.today || 'No events'}\n\nCALENDAR TOMORROW:\n${s.calendar?.tomorrow || 'No events'}\n\nTASKS DUE:\n${s.tasks}\n\nSITTING TIME:\n${s.sitting}\n\nSCREEN TIME:\n${s.screenTime}\n\nIMPORTANT EMAILS:\n${s.emails}\n\nSCHOOL UPDATES:\n${s.schoolEmails}`;
        }
        // Fallback to live
        console.log('Briefing: cache miss, running live');
        const result = execSync(
          `node scripts/morning-briefing.js`,
          { cwd: CLAWD_DIR, timeout: 45000, encoding: 'utf8' }
        );
        return result.trim();
      }

      case 'get_telegram_context': {
        const maxMessages = args.max_messages || 20;
        try {
          // Use JSONL extractor for real Telegram history
          const result = execSync(
            `node ${CLAWD_DIR}/scripts/extract_telegram_transcript.js --days 2 --limit ${maxMessages}`,
            { encoding: 'utf8', timeout: 10000 }
          );
          console.log(`Telegram: returning ${result.length} chars from JSONL`);
          return result.trim() || 'No Telegram messages found.';
        } catch (e) {
          return `Error reading Telegram context: ${e.message}`;
        }
      }

      // ===== WRITE/SEARCH TOOLS (LIVE API) =====

      case 'search_tasks': {
        console.log('Search tasks: live API');
        const result = execSync(
          `node scripts/toodledo.js find "${args.query.replace(/"/g, '\\"')}"`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        const lines = result.trim().split('\n').slice(0, 10);
        return lines.join('\n') || 'No tasks found matching that search.';
      }

      // ===== TRIAGE TOOLS =====

      case 'triage_tasks': {
        console.log('Triage tasks: live API');
        try {
          const result = execSync(
            `node scripts/triage-list.js`,
            { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' }
          );
          return result.trim();
        } catch (e) {
          console.log('Triage tasks error:', e.message);
          return `Could not fetch triage list: ${e.message}`;
        }
      }

      case 'defer_task': {
        console.log('Defer task: via safe client');
        const { task_id, reason } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          
          // Use safe client to get task, preserve tags, and edit with history
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['Deferred', 'triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { duedate: 0, tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          const result = execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          // Optionally add reason to note (uses safe client via CLI)
          if (reason) {
            const reasonNote = `Deferred ${new Date().toISOString().slice(0, 10)}: ${reason}`;
            execSync(
              `node scripts/toodledo.js update-note ${task_id} --note "${reasonNote.replace(/"/g, '\\"')}" --user VoiceHenry`,
              { cwd: CLAWD_DIR, timeout: 10000, encoding: 'utf8' }
            );
          }
          
          return `Task ${task_id} deferred to Someday. Due date removed, tagged "Deferred".`;
        } catch (e) {
          console.log('Defer task error:', e.message);
          return `Could not defer task: ${e.message}`;
        }
      }

      case 'mark_obsolete': {
        console.log('Mark obsolete: via safe client');
        const { task_id, reason } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          const completed = Math.floor(Date.now() / 1000);
          
          // Use safe client to complete task and add obsolete tag
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['obsolete', 'triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { completed: ${completed}, tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          return `Task ${task_id} marked obsolete and completed.`;
        } catch (e) {
          console.log('Mark obsolete error:', e.message);
          return `Could not mark task obsolete: ${e.message}`;
        }
      }

      case 'complete_task': {
        console.log('Complete task: via safe client');
        const { task_id } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          const completed = Math.floor(Date.now() / 1000);
          
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { completed: ${completed}, tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          return `Task ${task_id} marked complete.`;
        } catch (e) {
          console.log('Complete task error:', e.message);
          return `Could not complete task: ${e.message}`;
        }
      }

      case 'set_priority': {
        console.log('Set priority: via safe client');
        const { task_id, priority } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          
          // Priority mapping: 0=none, 1=low, 2=medium, 3=high
          const prioMap = { low: 1, medium: 2, high: 3 };
          const prioVal = prioMap[priority.toLowerCase()] || 2;
          
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { priority: ${prioVal}, tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          return `Task ${task_id} priority set to ${priority}.`;
        } catch (e) {
          console.log('Set priority error:', e.message);
          return `Could not set priority: ${e.message}`;
        }
      }

      case 'schedule_task': {
        console.log('Schedule task: via safe client');
        const { task_id, due_date, priority } = args;
        try {
          // Parse due date to Unix timestamp
          const dueTs = Math.floor(new Date(due_date + 'T12:00:00').getTime() / 1000);
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          
          // Priority mapping: 0=none, 1=low, 2=medium, 3=high
          const prioMap = { low: 1, medium: 2, high: 3 };
          const prioVal = priority ? prioMap[priority.toLowerCase()] || 2 : null;
          
          // Use safe client to get task, preserve tags, and edit with history
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const fields = { duedate: ${dueTs}, tag: newTag };
              ${prioVal !== null ? `fields.priority = ${prioVal};` : ''}
              const result = await s.safeEditTask(${task_id}, fields, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          return `Task ${task_id} scheduled for ${due_date}${priority ? ` with ${priority} priority` : ''}.`;
        } catch (e) {
          console.log('Schedule task error:', e.message);
          return `Could not schedule task: ${e.message}`;
        }
      }

      case 'delegate_task': {
        console.log('Delegate task: via safe client');
        const { task_id, note } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          
          // Use safe client to get task, preserve tags, and edit with history
          // Context ID for Henry: 1462384
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = ['Henry', 'Overnight', 'triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { context: 1462384, tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          
          // Add note if provided (uses safe client via CLI)
          if (note) {
            const delegateNote = `Delegated to Henry ${new Date().toISOString().slice(0, 10)}: ${note}`;
            execSync(
              `node scripts/toodledo.js update-note ${task_id} --note "${delegateNote.replace(/"/g, '\\"')}" --user VoiceHenry`,
              { cwd: CLAWD_DIR, timeout: 10000, encoding: 'utf8' }
            );
          }
          
          return `Task ${task_id} delegated to Henry. Tagged "Henry" + "Overnight" for overnight processing.`;
        } catch (e) {
          console.log('Delegate task error:', e.message);
          return `Could not delegate task: ${e.message}`;
        }
      }

      case 'mark_triaged': {
        console.log('Mark triaged: via safe client');
        const { task_id } = args;
        try {
          const triageDate = new Date().toISOString().slice(5, 10).replace('-', '');
          
          // Use safe client to get task, check triaged status, and edit with history
          const safeEditCmd = `node -e "
            const s = require('./scripts/toodledo_safe_client.js');
            (async () => {
              const task = await s.getTask(${task_id});
              const existingTags = (task.tag || '').split(',').map(t => t.trim()).filter(Boolean);
              if (existingTags.some(t => t.startsWith('triaged-'))) {
                console.log(JSON.stringify({ alreadyTriaged: true }));
                return;
              }
              const newTags = ['triaged-${triageDate}'];
              const allTags = [...new Set([...existingTags, ...newTags])];
              const newTag = allTags.join(', ');
              const result = await s.safeEditTask(${task_id}, { tag: newTag }, 'VoiceHenry');
              console.log(JSON.stringify(result));
            })();
          "`;
          const result = execSync(safeEditCmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          const parsed = JSON.parse(result.trim());
          
          if (parsed.alreadyTriaged) {
            return `Task ${task_id} already has a triaged tag.`;
          }
          
          return `Task ${task_id} marked as triaged (triaged-${triageDate}).`;
        } catch (e) {
          console.log('Mark triaged error:', e.message);
          return `Could not mark task as triaged: ${e.message}`;
        }
      }

      case 'get_task': {
        console.log('Get task: live API');
        const taskId = args.task_id;
        const result = execSync(
          `node -e "const c = require('./scripts/toodledo_client.js'); c.apiCall('/3/tasks/get.php?f=json&id=${taskId}&fields=note,duedate,priority,folder,tag').then(d => { const t = Array.isArray(d) ? d.find(x => x.id === ${taskId}) : null; if (!t) { console.log('Task not found'); return; } const due = t.duedate ? new Date(t.duedate * 1000).toISOString().slice(0,10) : 'none'; console.log('Title: ' + t.title); console.log('Due: ' + due); console.log('Priority: ' + t.priority); console.log('Note: ' + (t.note || '(empty)')); })"`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        return result.trim() || 'Task not found.';
      }

      case 'add_task': {
        console.log('Add task: live API');
        const folder = args.folder || 'pWorkflow';
        const priority = args.priority || 'medium';
        const title = args.title;
        // Duplicate check
        try {
          const keyword = title.split(/[\s:]+/).filter(w => w.length > 3 && w.toLowerCase() !== 'henry').slice(0, 2).join(' ');
          if (keyword) {
            const existing = execSync(
              `node scripts/toodledo.js find "${keyword.replace(/"/g, '\\"')}"`,
              { cwd: CLAWD_DIR, timeout: 10000, encoding: 'utf8' }
            ).trim();
            if (existing && !existing.includes('No tasks found')) {
              return `WARNING: Similar task(s) exist:\n${existing}\n\nUse update_task_note to update existing, or confirm this is genuinely new.`;
            }
          }
        } catch(e) {}
        const noteArg = args.note ? ` --note "${args.note.replace(/"/g, '\\"')}"` : '';
        const dueArg = args.duedate ? ` --due ${args.duedate}` : '';
        const starArg = args.star ? ` --star` : '';
        const result = execSync(
          `node scripts/toodledo.js add "${title.replace(/"/g, '\\"')}" --folder "${folder}" --tag Henry --priority ${priority}${dueArg}${starArg}${noteArg}`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        return result.trim();
      }

      case 'update_task_note': {
        console.log('Update task note: via safe client');
        const taskId = args.task_id;
        const transcriptTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const transcriptRef = `\n📞 Voice call ref: memory/voice-calls/${transcriptTs}*.txt`;
        const noteWithRef = args.note + transcriptRef;
        const result = execSync(
          `node scripts/toodledo.js update-note ${taskId} --note "${noteWithRef.replace(/"/g, '\\"')}" --user VoiceHenry`,
          { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
        );
        return result.trim();
      }

      case 'create_calendar_event': {
        console.log('Create calendar event: live API');
        const { summary, start, end, attendees, description, location } = args;
        let cmd = `GOG_KEYRING_PASSWORD="henrybot" gog calendar create paul@heth.ca --summary "${summary.replace(/"/g, '\\"')}" --from "${start}-08:00" --to "${end}-08:00" --send-updates all --account henry@heth.ca`;
        if (attendees) cmd += ` --attendees "${attendees}"`;
        if (description) cmd += ` --description "${description.replace(/"/g, '\\"')}"`;
        if (location) cmd += ` --location "${location.replace(/"/g, '\\"')}"`;
        const result = execSync(cmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
        return result.trim() || 'Event created successfully.';
      }

      case 'update_calendar_event': {
        console.log('Update calendar event: live API');
        const { event_query, new_start, new_end, new_description, new_summary, new_location } = args;
        try {
          // First find the event
          const searchResult = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog calendar events "paul@heth.ca" --account henry@heth.ca --from today --days 14 --query "${event_query.replace(/"/g, '\\"')}" --json`,
            { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
          );
          const data = JSON.parse(searchResult);
          if (!data.events || data.events.length === 0) {
            return `No event found matching "${event_query}".`;
          }
          const event = data.events[0];
          const eventId = event.id;
          
          // Build update command
          let cmd = `GOG_KEYRING_PASSWORD="henrybot" gog calendar update "paul@heth.ca" "${eventId}" --account henry@heth.ca --force`;
          if (new_start) cmd += ` --from "${new_start}-08:00"`;
          if (new_end) cmd += ` --to "${new_end}-08:00"`;
          if (new_description) cmd += ` --description "${new_description.replace(/"/g, '\\"')}"`;
          if (new_summary) cmd += ` --summary "${new_summary.replace(/"/g, '\\"')}"`;
          if (new_location) cmd += ` --location "${new_location.replace(/"/g, '\\"')}"`;
          
          const result = execSync(cmd, { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' });
          return `Updated event "${event.summary}". ${result.trim()}`;
        } catch (e) {
          console.log('Update event error:', e.message);
          return `Could not update event: ${e.message}`;
        }
      }

      case 'read_email': {
        const query = args.query || 'is:unread';
        const account = args.account === 'paul' ? 'paul@heth.ca' : 'henry@heth.ca';
        const maxResults = args.max_results || 5;
        console.log(`Read email: searching "${query}" in ${account}`);
        try {
          // Use --plain for clean TSV output
          const result = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog gmail messages search "${query.replace(/"/g, '\\"')}" --max ${maxResults} --include-body --plain --account ${account}`,
            { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' }
          );
          if (!result.trim()) {
            return `No emails found matching "${query}" in ${account}.`;
          }
          // Parse TSV format (tab-separated): ID, THREAD, DATE, FROM, SUBJECT, LABELS, BODY
          const lines = result.trim().split('\n').filter(l => !l.startsWith('ID\t') && !l.startsWith('#'));
          let output = `Found ${lines.length} emails in ${account}:\n\n`;
          for (let i = 0; i < Math.min(lines.length, maxResults); i++) {
            const line = lines[i];
            const parts = line.split('\t');
            // TSV: ID[0], THREAD[1], DATE[2], FROM[3], SUBJECT[4], LABELS[5], BODY[6]
            if (parts.length >= 5) {
              const msgId = parts[0] || '';
              const date = parts[2] || '';
              const from = parts[3]?.replace(/<[^>]+>/g, '').replace(/"/g, '').trim() || 'Unknown';
              const subject = parts[4] || 'No subject';
              const body = parts.length > 6 ? parts[6] : '';
              output += `${i + 1}. [ID: ${msgId}]\n   From: ${from}\n   Subject: ${subject}\n   Date: ${date}\n`;
              if (body) output += `   Preview: ${body.slice(0, 100)}...\n`;
              output += '\n';
            }
          }
          return output;
        } catch (e) {
          console.log('Read email error:', e.message);
          return `Could not search emails: ${e.message}`;
        }
      }

      case 'delete_calendar_event': {
        const { event_query, confirm } = args;
        console.log(`Delete calendar event: "${event_query}" (confirm: ${confirm})`);
        
        if (!confirm) {
          return `Deletion not confirmed. Please confirm you want to delete "${event_query}".`;
        }
        
        try {
          // First find the event
          const searchResult = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog calendar events "paul@heth.ca" --account henry@heth.ca --from today --days 14 --query "${event_query.replace(/"/g, '\\"')}" --json`,
            { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
          );
          const data = JSON.parse(searchResult);
          if (!data.events || data.events.length === 0) {
            return `No event found matching "${event_query}".`;
          }
          const event = data.events[0];
          const eventId = event.id;
          const eventName = event.summary;
          
          // Delete it
          execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog calendar delete "paul@heth.ca" "${eventId}" --account henry@heth.ca --force`,
            { cwd: CLAWD_DIR, timeout: 15000, encoding: 'utf8' }
          );
          return `Deleted event "${eventName}".`;
        } catch (e) {
          console.log('Delete event error:', e.message);
          return `Could not delete event: ${e.message}`;
        }
      }

      case 'read_full_email': {
        const { message_id } = args;
        console.log(`Read full email: ${message_id}`);
        try {
          const result = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog gmail get "${message_id}" --account henry@heth.ca`,
            { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' }
          );
          if (!result.trim()) {
            return `Could not find email with ID ${message_id}.`;
          }
          // Limit response length for voice
          const maxLen = 2000;
          if (result.length > maxLen) {
            return result.slice(0, maxLen) + '\n\n[Truncated - email too long for voice. Consider forwarding to yourself.]';
          }
          return result.trim();
        } catch (e) {
          console.log('Read full email error:', e.message);
          return `Could not read email: ${e.message}`;
        }
      }

      case 'forward_email': {
        const { message_id, to = 'paul@heth.ca', note } = args;
        console.log(`Forward email ${message_id} to ${to}`);
        try {
          // Get email in JSON format to extract subject
          const emailJson = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog gmail get "${message_id}" --json --account henry@heth.ca`,
            { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' }
          );
          const emailData = JSON.parse(emailJson);
          
          // Extract subject from headers (gog uses simplified headers object)
          const originalSubject = emailData.headers?.subject || 'No Subject';
          const originalFrom = emailData.headers?.from || 'Unknown';
          const originalDate = emailData.headers?.date || '';
          
          // Get plain text body
          const emailContent = execSync(
            `GOG_KEYRING_PASSWORD="henrybot" gog gmail get "${message_id}" --account henry@heth.ca`,
            { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' }
          );
          
          // Build forward body
          let body = '';
          if (note) body += `${note}\n\n`;
          body += `---------- Forwarded message ----------\n`;
          body += `From: ${originalFrom}\n`;
          body += `Date: ${originalDate}\n`;
          body += `Subject: ${originalSubject}\n\n`;
          body += emailContent.trim();
          
          // Write body to temp file (avoids shell escaping issues)
          const tmpFile = `/tmp/fwd-email-${Date.now()}.txt`;
          writeFileSync(tmpFile, body);
          
          // Send via henry's account using --body-file
          const fwdSubject = `Fwd: ${originalSubject}`;
          const sendCmd = `GOG_KEYRING_PASSWORD="henrybot" gog gmail send --to "${to}" --subject "${fwdSubject.replace(/"/g, '\\"')}" --body-file "${tmpFile}" --account henry@heth.ca`;
          execSync(sendCmd, { cwd: CLAWD_DIR, timeout: 20000, encoding: 'utf8' });
          
          // Clean up temp file
          try { execSync(`rm "${tmpFile}"`); } catch(e) {}
          
          return `Email forwarded to ${to} with subject: "${fwdSubject}"`;
        } catch (e) {
          console.log('Forward email error:', e.message);
          return `Could not forward email: ${e.message}`;
        }
      }

      case 'write_memory': {
        console.log('Write memory: live file');
        const target = args.target || 'daily';
        const content = args.content;
        if (target === 'longterm') {
          const memPath = `${CLAWD_DIR}/MEMORY.md`;
          const existing = readFileSync(memPath, 'utf8');
          writeFileSync(memPath, existing.trimEnd() + '\n\n' + content + '\n');
          return 'Written to MEMORY.md (long-term memory).';
        } else {
          const today = new Date().toISOString().slice(0, 10);
          const dailyPath = `${CLAWD_DIR}/memory/${today}.md`;
          const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
          const entry = `\n\n## Voice Note (${timestamp})\n${content}\n`;
          if (existsSync(dailyPath)) {
            const existing = readFileSync(dailyPath, 'utf8');
            writeFileSync(dailyPath, existing + entry);
          } else {
            writeFileSync(dailyPath, `# ${today}\n${entry}`);
          }
          return `Written to today's memory file.`;
        }
      }

      case 'search_memory': {
        console.log('Search memory: live QMD');
        try {
          const result = execSync(
            `export PATH="/Users/henry_notabot/.bun/bin:$PATH" && qmd search "${args.query.replace(/"/g, '\\"')}" -n 5`,
            { timeout: 5000, encoding: 'utf8' }
          );
          return result.trim() || 'No results found.';
        } catch(e) {
          return 'Search failed.';
        }
      }

      case 'send_message_to_clawdbot': {
        console.log('Send to Clawdbot: logging');
        const timestamp = new Date().toISOString();
        const msg = `[${timestamp}] Voice call request: ${args.message}\n`;
        execSync(`echo ${JSON.stringify(msg)} >> voice-requests.log`, { cwd: CLAWD_DIR });
        return 'Message saved. Will handle it after the call.';
      }

      case 'search_web': {
        console.log('Web search:', args.query);
        try {
          // Brave Search API
          const apiKey = 'BSA_e4h22a8pAz0JHxzjmqTqidGzWOF';
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=5`;
          const response = execSync(
            `curl -s -H "Accept: application/json" -H "X-Subscription-Token: ${apiKey}" "${url}"`,
            { timeout: 10000, encoding: 'utf8' }
          );
          const data = JSON.parse(response);
          if (!data.web?.results?.length) {
            return 'No results found.';
          }
          // Return top 3 results as concise snippets
          const results = data.web.results.slice(0, 3).map((r, i) => 
            `${i + 1}. ${r.title}\n   ${r.description || 'No description'}`
          ).join('\n\n');
          return results;
        } catch (e) {
          console.error('Web search error:', e.message);
          return `Search failed: ${e.message?.substring(0, 50)}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    console.error(`Tool ${name} error:`, error.message);
    return `Error: ${error.message?.substring(0, 100)}`;
  }
}

const PORT = process.env.PORT || 6060;
const CALL_HISTORY_PATH = `${CLAWD_DIR}/voice-realtime/call-history.json`;

// ── Call History (persisted to disk) ─────────────────
let callHistory = [];
try {
  if (existsSync(CALL_HISTORY_PATH)) {
    callHistory = JSON.parse(readFileSync(CALL_HISTORY_PATH, 'utf8'));
    console.log(`Loaded ${callHistory.length} call history entries`);
  }
} catch (e) {
  console.log('Call history load error:', e.message);
  callHistory = [];
}

function saveCallHistory() {
  try {
    // Keep last 500 entries max
    if (callHistory.length > 500) {
      callHistory = callHistory.slice(-500);
    }
    writeFileSync(CALL_HISTORY_PATH, JSON.stringify(callHistory, null, 2));
  } catch (e) {
    console.error('Call history save error:', e.message);
  }
}

const serverStartTime = Date.now();

// Prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated',
  'response.function_call_arguments.done',
  'conversation.item.input_audio_transcription.completed',
  'response.audio_transcript.done',
  'response.output_audio_transcript.done'
];

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PHONE_NUMBER_FROM || !rawDomain || !OPENAI_API_KEY) {
  console.error('Missing environment variables. Check .env file.');
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Static file serving for web caller UI
const __dirname = path.dirname(fileURLToPath(import.meta.url));
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: true,
});

// Root route — serve call.html
fastify.get('/', async (request, reply) => {
  return reply.sendFile('call.html');
});

// Token endpoint for Twilio Client SDK (web caller)
fastify.get('/api/token', async (request, reply) => {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity: 'paul-web', ttl: 3600 }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  });
  token.addGrant(voiceGrant);

  reply.send({ token: token.toJwt() });
});

// Status endpoint for Mission Control dashboard
fastify.get('/status', async (request, reply) => {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const callsLast24h = callHistory.filter(c => new Date(c.timestamp).getTime() > oneDayAgo).length;
  const callsLast7d = callHistory.filter(c => new Date(c.timestamp).getTime() > sevenDaysAgo).length;

  const lastCall = callHistory.length > 0 ? callHistory[callHistory.length - 1] : null;

  reply.send({
    status: 'online',
    activeCalls: activeCall ? 1 : 0,
    activeCall: activeCall ? {
      caller: activeCall.callerNumber,
      startTime: activeCall.startTime.toISOString(),
      duration: Math.floor((now - activeCall.startTime.getTime()) / 1000)
    } : null,
    lastCall: lastCall || null,
    callsLast24h,
    callsLast7d,
    totalCalls: callHistory.length,
    uptime: Math.floor((now - serverStartTime) / 1000)
  });
});

// Active call tracking
let activeCall = null;
let latestCallerNumber = 'unknown';

// Safety: auto-release stale calls after 2 minutes (if no WebSocket stream opened)
function releaseStaleCall() {
  if (activeCall && (Date.now() - activeCall.startTime.getTime() > 2 * 60 * 1000)) {
    console.log(`STALE CALL: Auto-releasing after 2min`);
    activeCall = null;
  }
}
setInterval(releaseStaleCall, 10 * 1000);

// Twilio incoming call webhook
fastify.all('/incoming-call', async (request, reply) => {
  const callerNumber = request.body?.From || request.query?.From || 'unknown';
  const isWebClient = callerNumber.startsWith('client:');
  latestCallerNumber = callerNumber;
  console.log(`Incoming call from: ${callerNumber}${isWebClient ? ' (web client)' : ''}`);

  if (activeCall) {
    console.log(`BUSY: Rejecting call — active call in progress`);
    const busyTwiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Sorry, Henry is on another call. Try again in a few minutes.</Say>
        <Hangup/>
      </Response>`;
    reply.type('text/xml').send(busyTwiml);
    return;
  }

  activeCall = { callerNumber, startTime: new Date(), isWebClient };
  console.log(`Call accepted from: ${callerNumber}`);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting you to Henry.</Say>
      <Connect>
        <Stream url="wss://${DOMAIN}/media-stream">
          <Parameter name="callerNumber" value="${callerNumber}" />
        </Stream>
      </Connect>
    </Response>`;
  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to media stream');

    const transcript = [];
    const callStartTime = new Date();

    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });

    let streamSid = null;
    let currentMode = 'standup'; // Start in standup mode

    // Switch conversation mode (standup <-> reflective)
    const switchMode = (newMode) => {
      if (newMode === currentMode) return;
      currentMode = newMode;
      const mode = MODES[newMode];
      console.log(`🔄 Switching to ${mode.name} mode (silence: ${mode.silence_duration_ms}ms)`);
      
      // Send session update with new silence duration
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.75,
                prefix_padding_ms: 300,
                silence_duration_ms: mode.silence_duration_ms,
              },
            },
          },
        },
      }));
      
      // Have Henry announce the mode switch
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[SYSTEM] ${mode.announcement}` }],
        },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    const sendSessionUpdate = async () => {
      const systemMessage = buildSystemMessage();
      console.log(`System prompt: ${systemMessage.length} chars (minimal, cache-enabled)`);
      
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.75,
                prefix_padding_ms: 300,
                silence_duration_ms: 900,
              },
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: VOICE,
            },
          },
          instructions: systemMessage,
          tools: TOOLS,
          tool_choice: 'auto',
        },
      };

      // Caller verification
      const PAUL_NUMBER = process.env.PAUL_PHONE || '+16045551234';
      const safeWord = process.env.SAFE_WORD || '';
      const callerInfo = connection.callerNumber || latestCallerNumber || 'unknown';
      const isWebClient = callerInfo.startsWith('client:');
      // Trust web clients — they're behind Cloudflare Zero Trust (paul@heth.ca only)
      const isKnownCaller = (callerInfo === PAUL_NUMBER && callerInfo !== 'unknown') || isWebClient;
      
      if (!isKnownCaller) {
        // LOCKDOWN for unknown callers
        sessionUpdate.session.instructions = `You are Henry III. This call is from an UNVERIFIED caller (${callerInfo}).

SECURITY: Ask for safe word before proceeding. The safe word is: "${safeWord}" — caller must say it first.
Until verified: share ZERO personal info, don't confirm/deny anything, keep responses short.
If they provide correct safe word, say "Identity verified, welcome!" and proceed normally.`;
        delete sessionUpdate.session.tools;
        delete sessionUpdate.session.tool_choice;
      }

      console.log('Sending session update');
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Initial greeting
      const greet = isKnownCaller 
        ? 'Greet Paul with just: "Paul!"'
        : 'Say: "Hello, this is Henry. Please provide the safe word to continue."';
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: greet }],
        },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    let isAiSpeaking = false;
    let audioChunksSent = 0;

    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      setTimeout(sendSessionUpdate, 100);
    });

    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`OpenAI: ${response.type}`);
        }

        // Audio to Twilio
        if ((response.type === 'response.audio.delta' || response.type === 'response.output_audio.delta') && response.delta) {
          isAiSpeaking = true;
          audioChunksSent++;
          if (connection.readyState === 1) {
            connection.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: response.delta },
            }));
          }
        }

        if (response.type === 'response.done') {
          isAiSpeaking = false;
          audioChunksSent = 0;
        }

        // Barge-in handling
        if (response.type === 'input_audio_buffer.speech_started') {
          if (connection.readyState === 1) {
            connection.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          if (isAiSpeaking) {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            isAiSpeaking = false;
          }
        }

        // Transcript collection
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📞 CALLER: ${response.transcript}`);
          if (response.transcript) {
            transcript.push(`[CALLER] ${response.transcript}`);
            // Check for mode switch cues
            const newMode = detectModeSwitch(response.transcript, currentMode);
            console.log(`Mode check: "${response.transcript}" → ${newMode || 'no match'} (current: ${currentMode})`);
            if (newMode) {
              switchMode(newMode);
            }
          }
        }
        if (response.type === 'response.audio_transcript.done' || response.type === 'response.output_audio_transcript.done') {
          console.log(`🤖 HENRY: ${response.transcript}`);
          if (response.transcript) transcript.push(`[HENRY] ${response.transcript}`);
        }

        // Tool calls
        if (response.type === 'response.function_call_arguments.done') {
          console.log(`Tool: ${response.name}(${response.arguments})`);
          try {
            const args = JSON.parse(response.arguments);
            const result = await executeTool(response.name, args);
            console.log(`Result: ${result.substring(0, 200)}`);

            openAiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: result,
              },
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
          } catch (error) {
            console.error(`Tool error:`, error.message);
            openAiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: `Error: ${error.message}`,
              },
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        }

        if (response.type === 'error') {
          console.error('OpenAI ERROR:', JSON.stringify(response, null, 2));
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    openAiWs.on('close', (code, reason) => {
      console.log(`OpenAI disconnected (code: ${code})`);
    });

    openAiWs.on('error', (error) => {
      console.error('OpenAI error:', error.message);
    });

    // Twilio events
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload,
              }));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            connection.callerNumber = data.start.customParameters?.callerNumber || 'unknown';
            console.log(`Stream started: ${streamSid}`);
            break;
          case 'stop':
            console.log('Stream stopped');
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            break;
        }
      } catch (error) {
        console.error('Twilio message error:', error);
      }
    });

    connection.on('close', () => {
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch (e) {}
      console.log('Client disconnected');

      // Record call in history
      const callEndTime = new Date();
      const callDurationSec = Math.floor((callEndTime.getTime() - callStartTime.getTime()) / 1000);
      const callerNum = connection.callerNumber || latestCallerNumber || 'unknown';
      callHistory.push({
        timestamp: callEndTime.toISOString(),
        duration: callDurationSec,
        caller: callerNum,
        transcriptLines: transcript.length
      });
      saveCallHistory();
      console.log(`Call recorded: ${callerNum}, ${callDurationSec}s, ${transcript.length} lines`);

      activeCall = null;

      // Save transcript
      if (transcript.length > 0) {
        try {
          const ts = callStartTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const transcriptDir = `${CLAWD_DIR}/memory/voice-calls`;
          if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });
          const transcriptFile = `${transcriptDir}/${ts}.txt`;
          writeFileSync(transcriptFile, transcript.join('\n'));
          console.log(`Transcript saved: ${transcriptFile}`);

          // Async summarization
          import('child_process').then(cp => {
            cp.exec(
              `node scripts/summarize-call.js "${transcriptFile}"`,
              { cwd: CLAWD_DIR, timeout: 60000 },
              (err, stdout) => {
                if (stdout) console.log('Summary:', stdout.trim());
              }
            );
          });
        } catch (e) {
          console.error('Transcript save error:', e.message);
        }
      }
    });

    connection.on('error', (error) => {
      console.error('Twilio error:', error.message);
    });
  });
});

// Outbound call endpoint
fastify.post('/make-call', async (request, reply) => {
  const { to } = request.body || {};
  if (!to) return reply.code(400).send({ error: 'Missing "to" phone number' });

  try {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${DOMAIN}/media-stream" /></Connect></Response>`;
    const call = await client.calls.create({
      from: PHONE_NUMBER_FROM,
      to,
      twiml,
    });
    console.log(`Outbound call: ${call.sid}`);
    reply.send({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('Call error:', error);
    reply.code(500).send({ error: error.message });
  }
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Henry III Voice Server (cache-enabled) on port ${PORT}`);
  console.log(`WebSocket: wss://${DOMAIN}/media-stream`);
});
