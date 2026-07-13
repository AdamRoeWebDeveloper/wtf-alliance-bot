require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// Minimal health-check server. This bot has no web interface of its own, but
// some hosts (Railway included, depending on how the service is configured)
// expect something listening on a port to consider the deploy healthy. This
// just responds 200 OK to anything - it's not used for anything functional.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LAP alliance bot is running.\n');
}).listen(PORT, () => console.log(`Health-check server listening on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed to read !timezone / !cheese commands - must also be enabled in the Developer Portal
    GatewayIntentBits.GuildMembers, // needed so message.member.roles is reliably populated for the !cheese leader check - must also be enabled in the Developer Portal
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;
const LEADERS_CHANNEL_ID = process.env.LEADERS_CHANNEL_ID || null;
const LEADER_ROLE_ID = process.env.LEADER_ROLE_ID || null; // if unset, falls back to requiring Administrator permission
const PING_ROLE_ID = process.env.PING_ROLE_ID || null;

// ---------------------------------------------------------------------------
// QUARANTINE + JOIN APPROVAL SYSTEM
// New members are auto-assigned the Quarantine role on join, which (per the
// channel permission setup) only lets them see quarantine-checkpoint. They
// click "Request to Join" there, which notifies R4/R5 in the applications
// channel with three buttons: Approve as Member, Approve as Allied Wolf, Deny.
// ---------------------------------------------------------------------------
const QUARANTINE_ROLE_ID = process.env.QUARANTINE_ROLE_ID;
const ALLIED_WOLF_ROLE_ID = process.env.ALLIED_WOLF_ROLE_ID;
const R3_ROLE_ID = process.env.R3_ROLE_ID;
const R4_ROLE_ID = process.env.R4_ROLE_ID;
const R5_ROLE_ID = process.env.R5_ROLE_ID;
const QUARANTINE_CHANNEL_ID = process.env.QUARANTINE_CHANNEL_ID;
const APPLICATIONS_CHANNEL_ID = process.env.APPLICATIONS_CHANNEL_ID;
const ROLES_CHANNEL_ID = process.env.ROLES_CHANNEL_ID;

// ---------------------------------------------------------------------------
// GIFT CODE RELAY
// RAW_GIFT_FEED_CHANNEL_ID is a hidden channel that "Follows" another
// server's gift-codes announcement channel (Discord's native cross-server
// follow feature). Whatever lands there gets parsed and reposted, cleaned up
// and copy-friendly, into GIFT_CODES_CHANNEL_ID.
// ---------------------------------------------------------------------------
const RAW_GIFT_FEED_CHANNEL_ID = process.env.RAW_GIFT_FEED_CHANNEL_ID;
const GIFT_CODES_CHANNEL_ID = process.env.GIFT_CODES_CHANNEL_ID;

const WOLF_EMOJI = '<:emoji_3:1525797281561841664>';

// In-memory guard against duplicate "Request to Join" spam from the same
// person before their first request has been actioned.
const pendingJoinRequests = new Set();

// ---------------------------------------------------------------------------
// SELF-ASSIGNABLE SQUAD ROLES
// "!role <name>" toggles one of these on/off for whoever runs it.
// ---------------------------------------------------------------------------
const SQUAD_ROLES = {
  cheese: { id: process.env.CHEESE_ROLE_ID, label: 'Cheese' },
  survivalbattle: { id: process.env.SURVIVAL_BATTLE_ROLE_ID, label: 'Survival Battle' },
  allianceduel: { id: process.env.ALLIANCE_DUEL_ROLE_ID, label: 'Alliance Duel' },
  caravan: { id: process.env.CARAVAN_ROLE_ID, label: 'Caravan' },
  shield: { id: process.env.SHIELD_ROLE_ID, label: 'Shield' },
};

// ---------------------------------------------------------------------------
// SERVER TIME
// The game's server time is 2 hours BEHIND true GMT/UTC (confirmed via a live
// check: server midnight = 3am BST in Milton Keynes, and BST = UTC+1, so
// server 00:00 = UTC 02:00 -> server = UTC - 2).
// All schedule data below (SB_SLOT_HOURS, AD reset time, etc.) is written in
// SERVER TIME - matching what players actually see in-game. To fire cron jobs
// at the correct real-world instant, we convert server-time hours to real UTC
// by ADDING this offset before scheduling, and we convert the real "now" back
// to server time (by SUBTRACTING this offset) before reading day/hour for any
// display or lookup logic. If this offset is ever wrong, it's a one-line fix.
// ---------------------------------------------------------------------------
const SERVER_TIME_OFFSET_HOURS = 2; // server time = real UTC minus 2 hours

function toServerTime(utcDate) {
  return new Date(utcDate.getTime() - SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
}

function serverHourToUTCHour(serverHour) {
  return (serverHour + SERVER_TIME_OFFSET_HOURS) % 24;
}

// ---------------------------------------------------------------------------
// TIMEZONE COMMAND (!timezone CET, !timezone GMT, etc.)
// Fixed UTC offsets for common abbreviations. These are NOT DST-aware
// (e.g. CET vs CEST, EST vs EDT are listed separately) - the person needs to
// pick whichever currently applies. Add more here as members request them.
// ---------------------------------------------------------------------------
const TIMEZONE_OFFSETS = {
  GMT: 0, UTC: 0, BST: 1, WET: 0,
  CET: 1, CEST: 2,
  EET: 2, EEST: 3,
  EST: -5, EDT: -4,
  CST: -6, CDT: -5,
  MST: -7, MDT: -6,
  PST: -8, PDT: -7,
  IST: 5.5,
  JST: 9,
  AEST: 10, AEDT: 11,
  ACST: 9.5, ACDT: 10.5,
  AWST: 8,
  NZST: 12, NZDT: 13,
};

// Converts a server-time hour (0-23) to a target zone's local hour, given the
// zone's UTC offset. Returns { hour, dayShift } where dayShift is -1/0/+1 if
// the converted time lands on the previous/same/next calendar day.
function convertServerHourToZone(serverHour, zoneUTCOffset) {
  const total = serverHour + SERVER_TIME_OFFSET_HOURS + zoneUTCOffset;
  const hour = ((total % 24) + 24) % 24;
  const dayShift = Math.floor(total / 24);
  return { hour, dayShift };
}

function formatZoneHour(serverHour, zoneUTCOffset) {
  const { hour, dayShift } = convertServerHourToZone(serverHour, zoneUTCOffset);
  const hourStr = `${String(Math.floor(hour)).padStart(2, '0')}:${hour % 1 === 0.5 ? '30' : '00'}`;
  const suffix = dayShift === 1 ? ' (+1 day)' : dayShift === -1 ? ' (-1 day)' : '';
  return hourStr + suffix;
}

// Formats a real UTC instant (e.g. a cheese event's realTarget) as a local
// clock time in the given zone - used for showing leader-set cheese timers
// converted into whatever zone someone asks !timezone for.
function formatRealInstantInZone(date, zoneUTCOffsetHours) {
  const shifted = new Date(date.getTime() + zoneUTCOffsetHours * 60 * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// CHEESE EVENTS
// Two rallying events, every OTHER day (not daily), at fixed default server
// times (Cheese 1 = 16:00, Cheese 2 = 22:00). Because the cycle is every 2
// days and a week has 7 (odd), the actual weekday it lands on drifts forward
// each cycle rather than staying locked to the same weekday.
//
// The cycle is anchored to a fixed start date (CHEESE_ANCHOR_DATE) - active
// days are that date, +2 days, +4 days, etc. This anchor must stay fixed
// across restarts (recomputing "start from tomorrow" on every boot would
// shift the whole cycle), so it's a hard-coded date, not calculated live.
//
// Leaders can change either time with "!cheese 1 07:00" - this changes the
// TIME only, not the every-other-day cadence. Once changed, the new time
// keeps running on the same active-day pattern until changed again (or reset
// back to default). In-memory only - a bot restart reverts custom times back
// to their hard-coded defaults below (the anchor date itself is a constant,
// so the day pattern survives a restart even though custom times don't).
// ---------------------------------------------------------------------------
const CHEESE_DEFAULTS = { 1: { hour: 16, minute: 0 }, 2: { hour: 22, minute: 0 } };
const cheeseSchedule = { 1: { ...CHEESE_DEFAULTS[1] }, 2: { ...CHEESE_DEFAULTS[2] } };

// First active day of the every-other-day cycle (server-time date). Confirmed
// as "starting tomorrow" relative to when this rule was set (2026-07-12
// server time), so tomorrow = 2026-07-13.
const CHEESE_ANCHOR_DATE = '2026-07-13';

// Tracks the server-time date (YYYY-MM-DD) each phase last fired for each
// event, so each occurrence only triggers its reminders once.
const cheeseNotified = {
  1: { oneHour: null, tenMin: null, start: null },
  2: { oneHour: null, tenMin: null, start: null },
};

const CHEESE_RALLY_RULE = "Only launch **1 rally** - do not join others' rallies. This lets offline members get rewards too.";

// Server-time calendar date as a plain string, for "has this fired today yet"
// and for the every-other-day anchor comparison.
function serverDateString(realDate) {
  const s = toServerTime(realDate);
  const pad = (n) => String(n).padStart(2, '0');
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

// Integer number of whole days between two YYYY-MM-DD date strings (b - a).
function daysBetweenDateStrings(aStr, bStr) {
  const a = new Date(aStr + 'T00:00:00Z');
  const b = new Date(bStr + 'T00:00:00Z');
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

// Is the given server-time date string an active Cheese Event day? Active
// days are the anchor date, then every 2 days after (and before, so this
// still works correctly if ever queried for a date prior to the anchor).
function isCheeseActiveDate(dateStr) {
  const diff = daysBetweenDateStrings(CHEESE_ANCHOR_DATE, dateStr);
  return diff >= 0 && diff % 2 === 0;
}

// Today's occurrence (in real UTC) of a given server-time hour/minute, ONLY
// if today is an active cheese day - returns null on an off-day. Used fresh
// every tick - no rollover needed since "today" naturally advances.
function getTodaysRealTargetIfActive(hour, minute, realNow) {
  const today = serverDateString(realNow);
  if (!isCheeseActiveDate(today)) return null;
  const serverNow = toServerTime(realNow);
  const serverTarget = new Date(Date.UTC(
    serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate(), hour, minute, 0
  ));
  return new Date(serverTarget.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
}

// Next occurrence (rolls forward day by day, skipping inactive days, until it
// lands on an active one) - used only for display purposes (!timezone,
// !cheese status), not for the cron logic.
function getNextRealTarget(hour, minute, realNow) {
  const serverNow = toServerTime(realNow);
  let candidateDate = new Date(Date.UTC(
    serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate(), hour, minute, 0
  ));
  // If today's time slot already passed, start the search from tomorrow.
  if (candidateDate.getTime() <= serverNow.getTime()) {
    candidateDate = new Date(candidateDate.getTime() + 24 * 60 * 60 * 1000);
  }
  // Walk forward (max 2 iterations needed given a 2-day cycle) until active.
  for (let i = 0; i < 14; i++) {
    const dateStr = serverDateString(new Date(candidateDate.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000));
    if (isCheeseActiveDate(dateStr)) break;
    candidateDate = new Date(candidateDate.getTime() + 24 * 60 * 60 * 1000);
  }
  return new Date(candidateDate.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-07-13" -> "Jul 13"
function formatDateNice(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// "Today" / "Tomorrow" / "Jul 15" depending how far out the target date is,
// relative to the given "today" date string.
function formatRelativeDayLabel(targetDateStr, todayDateStr) {
  const diff = daysBetweenDateStrings(todayDateStr, targetDateStr);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return formatDateNice(targetDateStr);
}

// Total minutes -> "4h 12m" or just "45m" if under an hour.
function formatDuration(totalMinutes) {
  if (totalMinutes < 0) totalMinutes = 0;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function announceCheese(num, phase) {
  const titles = {
    oneHour: `🧀 Cheese Event ${num} starts in 1 hour`,
    tenMin: `🧀 Cheese Event ${num} starts in 10 minutes`,
    start: `🧀 Cheese Event ${num} is starting NOW`,
  };
  const embed = new EmbedBuilder()
    .setTitle(titles[phase])
    .setDescription(CHEESE_RALLY_RULE)
    .setColor(0xd69e2e)
    .setTimestamp(new Date());

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.cheese.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.cheese.id),
    });
  }
}

// Runs every minute: for each cheese event's configured time, checks whether
// today is an active day AND whether we're in the 1-hour / 10-minute / start
// window, firing once per occurrence per phase. On an inactive day, this does
// nothing at all for that event. Range checks (not exact equality) so a
// missed/delayed tick still catches it on the next run.
async function checkCheeseTimers() {
  const now = new Date();
  const today = serverDateString(now);

  for (const num of Object.keys(cheeseSchedule)) {
    const { hour, minute } = cheeseSchedule[num];
    const target = getTodaysRealTargetIfActive(hour, minute, now);
    if (!target) continue; // not an active cheese day - skip entirely

    const diffMin = Math.round((target.getTime() - now.getTime()) / 60000);
    const notified = cheeseNotified[num];

    if (diffMin <= 60 && diffMin > 50 && notified.oneHour !== today) {
      await announceCheese(num, 'oneHour');
      notified.oneHour = today;
    }
    if (diffMin <= 10 && diffMin > 2 && notified.tenMin !== today) {
      await announceCheese(num, 'tenMin');
      notified.tenMin = today;
    }
    if (diffMin <= 0 && diffMin > -5 && notified.start !== today) {
      await announceCheese(num, 'start');
      notified.start = today;
    }
  }
}

function isLeader(message) {
  if (!message.member) return false;
  // Consistent with the join-approval buttons: R4 or R5 counts as a leader.
  if (message.member.roles.cache.has(R4_ROLE_ID) || message.member.roles.cache.has(R5_ROLE_ID)) {
    return true;
  }
  // Optional extra override role, if you ever want a leader role beyond R4/R5.
  if (LEADER_ROLE_ID && message.member.roles.cache.has(LEADER_ROLE_ID)) {
    return true;
  }
  // Final fallback for server owners/admins who aren't R4/R5.
  return message.member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function handleCheeseCommand(message) {
  const content = message.content.trim();

  // "!cheese status" is read-only - anyone can check it, no leader permission needed.
  if (/^!cheese\s+status$/i.test(content)) {
    const now = new Date();
    const todayStr = serverDateString(now);
    const todayActive = isCheeseActiveDate(todayStr);
    const lines = Object.keys(cheeseSchedule).map(num => {
      const { hour, minute } = cheeseSchedule[num];
      const isDefault = hour === CHEESE_DEFAULTS[num].hour && minute === CHEESE_DEFAULTS[num].minute;
      const next = getNextRealTarget(hour, minute, now);
      const nextDateStr = serverDateString(next);
      const minutesLeft = Math.round((next.getTime() - now.getTime()) / 60000);
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const dayLabel = formatRelativeDayLabel(nextDateStr, todayStr);
      const dateSuffix = (dayLabel === 'Today' || dayLabel === 'Tomorrow') ? `, ${formatDateNice(nextDateStr)}` : '';
      return `Cheese ${num}: ${timeStr} server time, every other day${isDefault ? ' (default)' : ' (custom)'}\n  Next: ${dayLabel}${dateSuffix} - in ${formatDuration(minutesLeft)}`;
    });
    lines.push(`(Today ${todayActive ? 'IS' : 'is NOT'} an active cheese day.)`);
    await message.reply(lines.join('\n'));
    return;
  }

  if (!isLeader(message)) {
    await message.reply("Only alliance leaders can change cheese event times.");
    return;
  }

  const resetMatch = content.match(/^!cheese\s+([12])\s+(cancel|reset)$/i);
  if (resetMatch) {
    const num = resetMatch[1];
    cheeseSchedule[num] = { ...CHEESE_DEFAULTS[num] };
    const d = CHEESE_DEFAULTS[num];
    await message.reply(`Cheese Event ${num} reset to its default time: ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')} server time, every day.`);
    return;
  }

  const match = content.match(/^!cheese\s+([12])\s+(\d{1,2}):(\d{2})$/i);
  if (!match) {
    await message.reply('Usage: `!cheese 1 07:00` or `!cheese 2 15:30` (server time, 24-hour format) - changes that event\'s daily time from now on. Use `!cheese 1 reset` to go back to default, or `!cheese status` to check both.');
    return;
  }

  const num = match[1];
  const hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  if (hour > 23 || minute > 59) {
    await message.reply('Invalid time - use HH:MM in 24-hour server time, e.g. `!cheese 1 07:00`.');
    return;
  }

  cheeseSchedule[num] = { hour, minute };
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  await message.reply(`Cheese Event ${num} now set for ${timeStr} server time, every day, until changed again. Reminders fire at 1 hour before, 10 minutes before, and at start.`);
}

// ---------------------------------------------------------------------------
// SB SURVIVAL BATTLE
// 7-day event, starts Friday 00:00 SERVER TIME, repeats weekly.
// Fixed lookup table (NOT a formula - Day 4 restarts Day 2's pattern,
// Day 5 restarts Day 3's pattern, per confirmed screenshots).
// Slots each day: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 SERVER TIME
// ---------------------------------------------------------------------------
const SB_SCHEDULE = {
  1: ['Enhance Raven', 'Enhance Heroes', 'Build Territory', 'Train Soldiers', 'Technology Research', 'Enhance Raven'],
  2: ['Enhance Heroes', 'Build Territory', 'Train Soldiers', 'Technology Research', 'Enhance Raven', 'Enhance Heroes'],
  3: ['Build Territory', 'Train Soldiers', 'Technology Research', 'Enhance Raven', 'Enhance Heroes', 'Build Territory'],
  4: ['Enhance Heroes', 'Build Territory', 'Train Soldiers', 'Technology Research', 'Enhance Raven', 'Enhance Heroes'],
  5: ['Build Territory', 'Train Soldiers', 'Technology Research', 'Enhance Raven', 'Enhance Heroes', 'Build Territory'],
  6: ['Train Soldiers', 'Technology Research', 'Enhance Raven', 'Enhance Heroes', 'Build Territory', 'Train Soldiers'],
  7: ['Technology Research', 'Enhance Raven', 'Enhance Heroes', 'Build Territory', 'Train Soldiers', 'Technology Research'],
};

// CORRECTED: the original screenshots these were sourced from displayed
// times in BST (UK local, UTC+1), not true server time. Since server = UTC-2
// and BST = UTC+1 (a 3-hour gap), the true server-time slots are 3 hours
// earlier than originally coded. Confirmed via a real CDT member report
// (expected 21:00 CDT for the first slot, which this correction produces).
const SB_SLOT_HOURS = [0, 4, 8, 12, 16, 20];

// How each SB activity scores points (confirmed values; TBC = not yet confirmed)
const SB_SCORING = {
  'Build Territory': ['Use 1m Construction Speedup (+10)', 'Increase 1 Building Might (+1)', 'Buy a Diamond pack (+30)'],
  'Technology Research': ['Use 1m Research Speedup (+10)', 'Increase 1 Tech Might (+1)', 'Buy a Diamond pack (+30)'],
  'Train Soldiers': ['Use 1m Training Boost (+10)', 'Train soldiers, e.g. Lv.9 (+28)', 'Buy a Diamond pack (+30)'],
  'Enhance Raven': ['Every 10 Raven Fruits consumed (+1)', 'Consume 1 Stamina (+100)', 'Buy a Diamond pack (+30)'],
  'Enhance Heroes': ['Recruit heroes (TBC)', 'Level up Heroes using Antitoxin (TBC)', 'Buy a Diamond pack (+30)'],
};

// ---------------------------------------------------------------------------
// ALLIANCE DUEL (AD)
// 6-day event, Monday-Saturday, starts 00:00 SERVER TIME Monday, no event Sunday.
// ---------------------------------------------------------------------------
const AD_SCHEDULE = {
  1: {
    theme: 'Gathering / Raven',
    actions: [
      'Consume 1 Stamina (+322.5)',
      'Complete Falcon Quest once (+26,500)',
      'Level up Heroes using Antitoxin (+2.1)',
      'Gather 100 Grain / Timber (+10.7 each)',
      'Gather 60 Herbs (+10.7)',
      'Consume 1 Raven Fruit (+6.4)',
      'Consume 1 Raven Essence (+5,375)',
    ],
    holdForCrossover: [
      { action: 'Level up Heroes using Antitoxin', hours: [0, 20], sbActivity: 'Enhance Heroes' },
      { action: 'Consume 1 Stamina', hours: [16], sbActivity: 'Enhance Raven' },
      { action: 'Consume 1 Raven Fruit', hours: [16], sbActivity: 'Enhance Raven' },
    ],
    unconfirmedCrossover: [],
    noCrossover: ['Gather Grain/Timber/Herbs', 'Consume 1 Raven Essence'],
    tip: 'Send gatherers out right after reset - queued/in-transit gathering still counts. ' +
      'Falcon Quest costs stamina to complete - do it at 16:00 (Enhance Raven) and the stamina spent counts for SB too.',
  },
  2: {
    theme: 'Territory / Covert',
    actions: [
      'Use 1m Construction Speedup (+132.5)',
      'Increase 1 Building Might (+26.5)',
      'Execute 1 UR Covert Operation (+172,500)',
      'Dispatch a UR Caravan (+235,000)',
      'Recruit survivor once (+3,450)',
    ],
    tip: 'UR Covert Ops and UR Caravans are worth far more than routine actions - save these if you can control timing.',
    holdForCrossover: [
      { action: 'Use 1m Construction Speedup', hours: [0, 20], sbActivity: 'Build Territory' },
      { action: 'Increase 1 Building Might', hours: [0, 20], sbActivity: 'Build Territory' },
    ],
    unconfirmedCrossover: [],
    noCrossover: ['Execute 1 UR Covert Operation', 'Dispatch a UR Caravan', 'Recruit survivor'],
  },
  3: {
    theme: 'Research / Raven Gear',
    actions: [
      'Complete Falcon Quest once (+26,500)',
      'Use 1m Research Speedup (+132.5)',
      'Consume 1 Study Scroll (+645)',
      'Increase 1 Tech Might (+26.5)',
      'Raven Gear Chest Lv.1-7 opened (+2,365 up to +1,741,500)',
    ],
    tip: 'Higher-level Raven Gear Chests are worth exponentially more - save chest openings for today if possible.',
    holdForCrossover: [
      { action: 'Use 1m Research Speedup', hours: [4], sbActivity: 'Technology Research' },
      { action: 'Increase 1 Tech Might', hours: [4], sbActivity: 'Technology Research' },
    ],
    unconfirmedCrossover: ['Complete Falcon Quest', 'Consume 1 Study Scroll'],
    noCrossover: ['Raven Gear Chest openings (any level)'],
  },
  4: {
    theme: 'Heroes',
    actions: [
      'Level up Heroes using Antitoxin (+2.1)',
      'Recruit heroes once (+3,975)',
      'Consume 1 UR Hero Shard (+21,500)',
      'Consume 1 SSR Hero Shard (+7,525)',
      'Consume 1 SR Hero Shard (+2,150)',
      'Use 1 Skill Badge (+21.5)',
    ],
    tip: 'Save Hero Shard consumption for today - it does not cross over with SB, but it is a big chunk of AD points.',
    holdForCrossover: [
      { action: 'Level up Heroes using Antitoxin', hours: [8], sbActivity: 'Enhance Heroes' },
      { action: 'Recruit heroes', hours: [8], sbActivity: 'Enhance Heroes' },
    ],
    unconfirmedCrossover: [],
    noCrossover: ['Consume UR/SSR/SR Hero Shard', 'Use 1 Skill Badge'],
  },
  5: {
    theme: 'Soldiers / Build',
    actions: [
      'Complete Falcon Quest once (+26,500)',
      'Use 1m Construction/Research/Training Speedup (+132.5 each)',
      'Increase 1 Building/Tech Might (+26.5 each)',
      'Train soldiers Lv.1-10 (+51 up to +280.5)',
    ],
    tip: 'Training higher-level soldiers scores significantly more - queue your best-value training today.',
    holdForCrossover: [
      { action: 'Use 1m Construction Speedup / Increase Building Might', hours: [8], sbActivity: 'Build Territory' },
      { action: 'Use 1m Training Boost / Train soldiers', hours: [12], sbActivity: 'Train Soldiers' },
      { action: 'Use 1m Research Speedup / Increase Tech Might', hours: [16], sbActivity: 'Technology Research' },
    ],
    unconfirmedCrossover: ['Complete Falcon Quest'],
    noCrossover: [],
  },
  6: {
    theme: 'Combat / War',
    actions: [
      'Use 1m Construction/Research/Training/Healing Speedup (+132.5 each)',
      'Execute 1 UR Covert Operation (+172,500)',
      'Dispatch a UR Caravan (+235,000)',
      'Soldiers defeated - specific match (+25 to +137.5, much higher than general combat)',
      'Soldiers defeated - general (+5 to +27.5)',
      'Soldiers lost still scores points (+4.3 to +23.6)',
    ],
    tip: 'War day - defeating in a targeted alliance match scores far more per kill than general combat. ' +
      'Refresh Covert Operations and Caravans until you get an all-gold result before executing/dispatching - it scores significantly more.',
    holdForCrossover: [
      { action: 'Use 1m Construction Speedup', hours: [4], sbActivity: 'Build Territory' },
      { action: 'Use 1m Training Boost', hours: [8], sbActivity: 'Train Soldiers' },
      { action: 'Use 1m Research Speedup', hours: [12], sbActivity: 'Technology Research' },
    ],
    unconfirmedCrossover: [],
    noCrossover: ['Execute 1 UR Covert Operation', 'Dispatch a UR Caravan', 'Use 1m Healing Speedup', 'Combat (defeated/lost)'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// UTC weekday of a (server-time-adjusted) date: 0=Sun, 1=Mon, ... 6=Sat
function getUTCWeekday(date) {
  return date.getUTCDay();
}

// SB Day: Fri=1, Sat=2, Sun=3, Mon=4, Tue=5, Wed=6, Thu=7
// Expects a date already converted to server time via toServerTime().
function getSBDay(date) {
  const map = { 5: 1, 6: 2, 0: 3, 1: 4, 2: 5, 3: 6, 4: 7 };
  return map[getUTCWeekday(date)];
}

// AD Day: Mon=1 ... Sat=6, Sun=null (no event)
// Expects a date already converted to server time via toServerTime().
function getADDay(date) {
  const map = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
  return map[getUTCWeekday(date)] || null;
}

// Builds a ping string for one or more role IDs, plus the optional extra
// PING_ROLE_ID if configured. Replaces the old @everyone-for-everything
// approach - each notification type now only pings the members who opted
// into that specific squad role.
function rolePing(...roleIds) {
  const ids = [...roleIds.filter(Boolean)];
  if (PING_ROLE_ID) ids.push(PING_ROLE_ID);
  return ids.map(id => `<@&${id}>`).join(' ');
}
function rolePingAllowedMentions(...roleIds) {
  const ids = [...roleIds.filter(Boolean)];
  if (PING_ROLE_ID) ids.push(PING_ROLE_ID);
  return { roles: ids };
}

async function postSBReminder() {
  const realNow = new Date();
  const now = toServerTime(realNow); // all schedule logic runs in server time
  const sbDay = getSBDay(now);
  const hour = now.getUTCHours();
  const slotIndex = SB_SLOT_HOURS.indexOf(hour);
  if (slotIndex === -1) return; // safety check, shouldn't happen given cron times

  const activity = SB_SCHEDULE[sbDay][slotIndex];
  const scoring = SB_SCORING[activity] || [];

  const embed = new EmbedBuilder()
    .setTitle(`SB Survival Battle - Day ${sbDay}, ${String(hour).padStart(2, '0')}:00 server time`)
    .setDescription(`**Now active: ${activity}**`)
    .addFields({ name: 'How to earn points', value: scoring.join('\n') || 'Not confirmed yet' })
    .setColor(0x2b6cb0)
    .setTimestamp(realNow);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.survivalbattle.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.survivalbattle.id),
    });
  }

  // Separate, standalone crossover alert - only sent if today's AD day has an
  // action saved specifically for this activity+hour. Kept as its own message
  // (not a field on the SB embed) so it stands out and isn't missed.
  await postCrossoverAlert(realNow, now, sbDay, activity, hour);
}

async function postCrossoverAlert(realNow, now, sbDay, activity, hour) {
  const adDay = getADDay(now);
  if (!adDay) return; // no AD today, nothing to cross-reference

  const adInfo = AD_SCHEDULE[adDay];
  const readyNow = adInfo.holdForCrossover.filter(
    h => h.sbActivity === activity && h.hours.includes(hour)
  );
  if (!readyNow.length) return;

  const embed = new EmbedBuilder()
    .setTitle('🎯 Double Points Window - AD + SB Crossover')
    .setDescription(`SB Day ${sbDay} just switched to **${activity}** - this lines up with today's Alliance Duel scoring.`)
    .addFields({
      name: 'Use these now for points in BOTH events',
      value: readyNow.map(h => `**${h.action}**`).join('\n'),
    })
    .setColor(0x38a169)
    .setTimestamp(realNow);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.survivalbattle.id, SQUAD_ROLES.allianceduel.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.survivalbattle.id, SQUAD_ROLES.allianceduel.id),
    });
  }
}

async function postADReminder() {
  const realNow = new Date();
  const now = toServerTime(realNow); // all schedule logic runs in server time
  const adDay = getADDay(now);
  if (!adDay) return; // Sunday, no AD

  const info = AD_SCHEDULE[adDay];

  const formatHours = (hours) => hours.map(h => `${String(h).padStart(2, '0')}:00`).join(' or ') + ' server time';

  const holdText = info.holdForCrossover.length
    ? info.holdForCrossover
        .map(h => `**Wait on:** ${h.action}\n→ Use it at **${formatHours(h.hours)}** when SB switches to **${h.sbActivity}** for double points`)
        .join('\n\n')
    : 'None today.';

  const noCrossoverText = info.noCrossover.length
    ? info.noCrossover.join(', ')
    : 'None.';

  const unconfirmedText = info.unconfirmedCrossover.length
    ? info.unconfirmedCrossover.join(', ') + ' - not confirmed to cross over yet, use your own judgement.'
    : 'None.';

  const embed = new EmbedBuilder()
    .setTitle(`Alliance Duel - Day ${adDay}: ${info.theme}`)
    .setDescription('**Do NOT use the actions below yet - hold them until the matching SB time for double points.**')
    .addFields(
      { name: '⏳ HOLD these for double points', value: holdText },
      { name: '✅ Fine to use anytime (no SB crossover)', value: noCrossoverText },
      { name: '❓ Unconfirmed crossover', value: unconfirmedText },
      { name: 'Full scoring list for today', value: info.actions.join('\n') },
      { name: 'Tip', value: info.tip }
    )
    .setColor(0xb7791f)
    .setTimestamp(realNow);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.allianceduel.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.allianceduel.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Sunday gather-prep reminder: fires once weekly, ~3 hours before Monday's
// AD reset (server 00:00), i.e. Sunday 20:00 server time. Reminds members to
// send gatherers out now (RSS Lv.10 tiles) so they land back right at reset,
// ready for immediate re-deployment and in-transit points on AD Day 1.
// ---------------------------------------------------------------------------
async function postGatherPrepReminder() {
  const embed = new EmbedBuilder()
    .setTitle('🌾 Send Gatherers Now - AD Resets in ~4 Hours')
    .setDescription(
      'Alliance Duel resets at **00:00 server time** (Monday) - about 4 hours from now.\n\n' +
      'Send your gatherers out **now** on **RSS Level 10 tiles** so they arrive back right at reset, ' +
      'ready for immediate re-deployment and bonus in-transit gathering points for AD Day 1.'
    )
    .setColor(0x38761d)
    .setTimestamp(new Date());

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.allianceduel.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.allianceduel.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Shield reminders: a 4-stage countdown to Saturday's 00:00 server reset
// (start of AD Day 6, "raid day"), pinging the Shield role. Fires on Friday
// (the day before) at 00:00, then 21:00, 23:00, and 23:45 server time.
// ---------------------------------------------------------------------------
const SHIELD_REMINDER_MESSAGES = {
  dayAhead: {
    title: '🛡️ Raid Day Tomorrow!',
    description:
      'Alliance Duel Day 6 tomorrow is raid day! Please make sure you have a shield ' +
      'ready and activated before reset at **00:00 server time**. You can get a shield ' +
      'from the alliance shop.',
  },
  threeHours: {
    title: '🛡️ 3 Hours Until Reset',
    description: 'Please make sure your shield is active before reset - **3 hours** until reset (00:00 server time).',
  },
  oneHour: {
    title: '🛡️ 1 Hour Until Reset',
    description:
      'Please activate your shields now - **1 hour** until reset. If you don\'t have a ' +
      'shield, you can get one from the alliance shop.',
  },
  fifteenMin: {
    title: '🚨 15 Minutes Until Alliance Duel War!',
    description: 'Please activate your shields now if you have not done so!',
  },
};

async function postShieldReminder(stage) {
  const info = SHIELD_REMINDER_MESSAGES[stage];
  const embed = new EmbedBuilder()
    .setTitle(info.title)
    .setDescription(info.description)
    .setColor(0x4a5568)
    .setTimestamp(new Date());

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send({
      content: rolePing(SQUAD_ROLES.shield.id),
      embeds: [embed],
      allowedMentions: rolePingAllowedMentions(SQUAD_ROLES.shield.id),
    });
  }
}


async function postLeaderSummary() {
  if (!LEADERS_CHANNEL_ID) return; // feature off if not configured

  const realNow = new Date();
  const now = toServerTime(realNow); // all schedule logic runs in server time
  const sbDay = getSBDay(now);
  const adDay = getADDay(now);

  const sbLines = SB_SLOT_HOURS
    .map((hour, idx) => `${String(hour).padStart(2, '0')}:00 - ${SB_SCHEDULE[sbDay][idx]}`)
    .join('\n');

  let text = `ALLIANCE NOTICE - ${now.toUTCString().slice(0, 16)} (server time)\n\n`;
  text += `SB SURVIVAL BATTLE (Day ${sbDay}) - all times server time:\n${sbLines}\n\n`;

  if (adDay) {
    const info = AD_SCHEDULE[adDay];
    text += `ALLIANCE DUEL (Day ${adDay}): ${info.theme}\n`;
    if (info.holdForCrossover.length) {
      text += `Save these for double points:\n`;
      info.holdForCrossover.forEach(h => {
        const hours = h.hours.map(x => `${String(x).padStart(2, '0')}:00`).join(' or ');
        text += `- ${h.action} -> use at ${hours} server time\n`;
      });
    }
  } else {
    text += `ALLIANCE DUEL: no event today (Sunday).\n`;
  }

  text += `\n`;
  const todayStr = serverDateString(realNow);
  if (isCheeseActiveDate(todayStr)) {
    text += `CHEESE EVENTS - today is an active cheese day:\n`;
    Object.keys(cheeseSchedule).forEach(num => {
      const { hour, minute } = cheeseSchedule[num];
      text += `- Cheese ${num}: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} server time\n`;
    });
  } else {
    text += `CHEESE EVENTS: none today (runs every other day - not today).\n`;
  }

  // Plain text in a code block - easy to select-all and paste into the game's
  // alliance notice field, which does not render Discord markdown.
  const message = '```\n' + text.trim() + '\n```';

  const channel = await client.channels.fetch(LEADERS_CHANNEL_ID);
  if (channel) {
    await channel.send({ content: message });
  }
}

// ---------------------------------------------------------------------------
// !timezone command
// e.g. "!timezone CET" or "!timezone EST" - replies with today's SB + AD
// schedule converted to that zone. No @everyone ping - just a normal reply.
// ---------------------------------------------------------------------------
async function handleTimezoneCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const zoneInput = (parts[1] || '').toUpperCase();

  if (!zoneInput) {
    await message.reply(`Usage: \`!timezone CET\` - supported zones: ${Object.keys(TIMEZONE_OFFSETS).join(', ')}`);
    return;
  }

  const zoneOffset = TIMEZONE_OFFSETS[zoneInput];
  if (zoneOffset === undefined) {
    await message.reply(`Unknown timezone "${zoneInput}". Supported: ${Object.keys(TIMEZONE_OFFSETS).join(', ')}`);
    return;
  }

  const realNow = new Date();
  const now = toServerTime(realNow);
  const sbDay = getSBDay(now);
  const adDay = getADDay(now);

  const sbLines = SB_SLOT_HOURS
    .map((hour, idx) => `${formatZoneHour(hour, zoneOffset)} - ${SB_SCHEDULE[sbDay][idx]}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Today's Schedule in ${zoneInput}`)
    .addFields({ name: `SB Survival Battle (Day ${sbDay})`, value: sbLines });

  if (adDay) {
    const info = AD_SCHEDULE[adDay];
    const holdText = info.holdForCrossover.length
      ? info.holdForCrossover
          .map(h => `**${h.action}** -> use at ${h.hours.map(hh => formatZoneHour(hh, zoneOffset)).join(' or ')} (${h.sbActivity})`)
          .join('\n')
      : 'None today.';
    embed.addFields(
      { name: `Alliance Duel (Day ${adDay}): ${info.theme}`, value: 'Save these for double points:' },
      { name: 'Hold list', value: holdText }
    );
  } else {
    embed.addFields({ name: 'Alliance Duel', value: 'No event today (Sunday).' });
  }

  const cheeseText = Object.keys(cheeseSchedule)
    .map(num => {
      const { hour, minute } = cheeseSchedule[num];
      const next = getNextRealTarget(hour, minute, realNow);
      const minutesLeft = Math.round((next.getTime() - realNow.getTime()) / 60000);
      return `Cheese ${num}: ${formatRealInstantInZone(next, zoneOffset)} (in ${formatDuration(minutesLeft)}, every other day)`;
    })
    .join('\n');
  embed.addFields({ name: '🧀 Cheese Events', value: cheeseText });

  embed
    .setFooter({ text: 'Fixed UTC offset - not DST-aware. Pick CET vs CEST / EST vs EDT etc. based on what currently applies.' })
    .setColor(0x4a5568)
    .setTimestamp(realNow);

  await message.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// QUARANTINE ON JOIN + PERSONALIZED WELCOME
// Every new member gets the Quarantine role AND their own personalized
// welcome message with the Request to Join button, posted automatically -
// not a single shared/persistent message, a fresh one addressed to them.
// ---------------------------------------------------------------------------
function buildWelcomeMessage(member) {
  const embed = new EmbedBuilder()
    .setDescription(
      `**Welcome to the den, ${member}.**\n` +
      `You've wandered into **[WTF] WAKE THE FERAL**'s territory. ${WOLF_EMOJI}\n\n` +
      `**How this works:**\n` +
      `Tap **Request to Join** below\n` +
      `Our leaders (R4/R5) will review your request as soon as possible.\n\n` +
      `You'll be let in as either a **Full Member** or an **Allied Wolf** (if you're visiting from an allied KvK alliance).\n\n` +
      `Sit tight in here until then - the rest of the den opens up once you're approved.`
    )
    .setColor(0x2d3748);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('request_join').setLabel('Request to Join').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

// ---------------------------------------------------------------------------
// Posted right after someone is approved as a Full Member - lets them opt
// into notification-role pings for whichever events they actually care about.
// Buttons toggle on/off, same as "!role", but presented proactively rather
// than requiring them to already know the command exists.
// ---------------------------------------------------------------------------
function buildRoleOptInMessage(member, { isNewApproval = false } = {}) {
  const intro = isNewApproval
    ? `Welcome to the pack, ${member}! Pick which event notifications you want to be pinged for below - ` +
      `you can change these anytime with \`!role <name>\` or \`!notifications\`.`
    : `${member}, here are your current notification roles - green means ON, red means OFF. Tap any to toggle it.`;

  const embed = new EmbedBuilder()
    .setTitle('🔔 Notification Roles')
    .setDescription(intro)
    .setColor(0x2b6cb0);

  const makeButton = (key) => new ButtonBuilder()
    .setCustomId(`optin_${key}_${member.id}`)
    .setLabel(SQUAD_ROLES[key].label)
    .setStyle(member.roles.cache.has(SQUAD_ROLES[key].id) ? ButtonStyle.Success : ButtonStyle.Danger);

  const row1 = new ActionRowBuilder().addComponents(
    makeButton('cheese'), makeButton('survivalbattle'), makeButton('allianceduel')
  );
  const row2 = new ActionRowBuilder().addComponents(
    makeButton('caravan'), makeButton('shield')
  );

  return { content: `${member}`, embeds: [embed], components: [row1, row2], allowedMentions: { users: [member.id] } };
}


client.on('guildMemberAdd', async (member) => {
  try {
    await member.roles.add(QUARANTINE_ROLE_ID);
    console.log(`Assigned Quarantine role to new member: ${member.user.tag}`);
  } catch (err) {
    console.error(`Failed to assign Quarantine role to ${member.user.tag}:`, err.message);
  }

  try {
    const channel = await client.channels.fetch(QUARANTINE_CHANNEL_ID);
    if (channel) {
      await channel.send(buildWelcomeMessage(member));
    }
  } catch (err) {
    console.error(`Failed to post welcome message for ${member.user.tag}:`, err.message);
  }
});

// ---------------------------------------------------------------------------
// "!setup-welcome" - now just a leader-only PREVIEW/TEST command, since the
// real welcome message posts automatically per new member above. Useful for
// checking how it looks/wording without needing an actual new join.
// ---------------------------------------------------------------------------
async function handleSetupWelcomeCommand(message) {
  if (!isLeader(message)) {
    await message.reply('Only leaders can run this preview command.');
    return;
  }

  const channel = await client.channels.fetch(QUARANTINE_CHANNEL_ID);
  if (channel) {
    await channel.send(buildWelcomeMessage(message.member));
    await message.reply('Preview posted (addressed to you, for testing - real new members get their own automatically).');
  }
}

// ---------------------------------------------------------------------------
// "!role <squad>" - toggles a self-assignable squad role on/off for whoever
// runs it. Anyone can use this (no leader restriction).
// ---------------------------------------------------------------------------
async function handleRoleCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const key = (parts[1] || '').toLowerCase().replace(/\s+/g, '');

  if (!key || !SQUAD_ROLES[key]) {
    const available = [...new Set(Object.values(SQUAD_ROLES).map(r => r.label))].join(', ');
    await message.reply(`Usage: \`!role <name>\` - available: ${available}`);
    return;
  }

  const { id: roleId, label } = SQUAD_ROLES[key];
  const member = message.member;
  if (!member) {
    await message.reply('Could not find your server membership - please try again.');
    return;
  }

  try {
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
      await message.reply(`Removed the **${label}** role.`);
    } else {
      await member.roles.add(roleId);
      await message.reply(`Added the **${label}** role.`);
    }
  } catch (err) {
    console.error('Error toggling squad role:', err.message);
    await message.reply('Something went wrong changing that role - please tell a leader.');
  }
}

// ---------------------------------------------------------------------------
// "!notifications" - anyone can run this anytime to re-trigger the same
// button-based opt-in prompt that new members get automatically on approval.
// Useful for existing members who joined before this feature existed, or
// anyone who wants to revisit their choices.
// ---------------------------------------------------------------------------
async function handleNotificationsCommand(message) {
  const member = message.member;
  if (!member) {
    await message.reply('Could not find your server membership - please try again.');
    return;
  }
  await message.channel.send(buildRoleOptInMessage(member));
}

// ---------------------------------------------------------------------------
// PERSISTENT ROLES-CHANNEL PICKER
// A single static message with generic (not personalized) buttons, meant to
// live permanently in a channel that has chat disabled (Send Messages denied
// for @everyone) - buttons work independently of that permission, so this is
// the only way to let people self-manage roles in a channel with no chat.
//
// Buttons here are always neutral color - NOT state-reflecting - because
// this one message is shared by everyone. If it changed color to match
// whoever last clicked it, every other viewer would see a state that isn't
// their own. Each click instead gets its own private (ephemeral) confirmation.
// ---------------------------------------------------------------------------
function buildPersistentRolePicker() {
  const embed = new EmbedBuilder()
    .setTitle('🔔 Notification Roles')
    .setDescription(
      'Tap a button below to toggle that notification role on or off for yourself.\n' +
      "You'll get a private confirmation each time - the buttons themselves don't change color, " +
      'since this message is shared by everyone.'
    )
    .setColor(0x2b6cb0);

  const makeButton = (key) => new ButtonBuilder()
    .setCustomId(`pickroles_${key}`)
    .setLabel(SQUAD_ROLES[key].label)
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(
    makeButton('cheese'), makeButton('survivalbattle'), makeButton('allianceduel')
  );
  const row2 = new ActionRowBuilder().addComponents(
    makeButton('caravan'), makeButton('shield')
  );

  return { embeds: [embed], components: [row1, row2] };
}

// "!setup-roles" - leaders run this ONCE to post the persistent picker into
// the roles channel. Not automatic on every restart, to avoid duplicates.
async function handleSetupRolesCommand(message) {
  if (!isLeader(message)) {
    await message.reply('Only leaders can run this setup command.');
    return;
  }
  if (!ROLES_CHANNEL_ID) {
    await message.reply('ROLES_CHANNEL_ID is not configured.');
    return;
  }
  const channel = await client.channels.fetch(ROLES_CHANNEL_ID);
  if (channel) {
    await channel.send(buildPersistentRolePicker());
    await message.reply('Roles picker posted.');
  }
}

// ---------------------------------------------------------------------------
// "!clear <number>" - leader-only bulk delete, e.g. "!clear 20" removes the
// last 20 messages plus the command itself. Requires the Manage Messages
// permission (not previously needed by this bot - must be added).
// Discord only allows bulk-deleting messages younger than 14 days; anything
// older is silently skipped rather than erroring.
// ---------------------------------------------------------------------------
async function handleClearCommand(message) {
  if (!isLeader(message)) {
    await message.reply('Only leaders can use this command.');
    return;
  }

  const parts = message.content.trim().split(/\s+/);
  const count = parseInt(parts[1], 10);
  if (!count || count < 1 || count > 99) {
    await message.reply('Usage: `!clear <number>` - between 1 and 99.');
    return;
  }

  try {
    // +1 to also remove the "!clear" command message itself.
    const deleted = await message.channel.bulkDelete(count + 1, true);
    const confirmMsg = await message.channel.send(`🧹 Cleared ${deleted.size - 1} message(s).`);
    setTimeout(() => confirmMsg.delete().catch(() => {}), 5000);
  } catch (err) {
    console.error('Error clearing messages:', err.message);
    await message.channel.send('Something went wrong - Discord can only bulk-delete messages younger than 14 days, and the bot needs the Manage Messages permission.');
  }
}

// ---------------------------------------------------------------------------
// Gift code parsing: expects the code as the first non-empty line, e.g.
// "26CHOCO\n\nYou can try to use this giftcode..." - validates it looks like
// a plausible code (alphanumeric, no spaces, 3-20 chars) rather than blindly
// trusting the first line of any message. Also grabs a FAQ/how-to link if
// one appears anywhere in the message.
// ---------------------------------------------------------------------------
function parseGiftCodeMessage(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const firstLine = lines[0];
  const codePattern = /^[A-Z0-9]{3,20}$/i;
  if (!codePattern.test(firstLine)) return null;

  const urlMatch = content.match(/https?:\/\/\S+/);
  return { code: firstLine.toUpperCase(), link: urlMatch ? urlMatch[0] : null };
}

async function handleGiftFeedMessage(message) {
  if (!GIFT_CODES_CHANNEL_ID) return;
  const channel = await client.channels.fetch(GIFT_CODES_CHANNEL_ID);
  if (!channel) return;

  const parsed = parseGiftCodeMessage(message.content);

  if (parsed) {
    const embed = new EmbedBuilder()
      .setTitle('🎁 New Gift Code!')
      .setDescription(
        `Well, he has done it again folks! ALI3N has found yet another winner. 👽\n\n` +
        `Is there anything this Extraterrestrial cant do? I doubt it! What an absolute legend that space man is. Now go get your rewards! ${WOLF_EMOJI}\n\n` +
        '```\n' + parsed.code + '\n```' +
        (parsed.link ? `\nHow to redeem: ${parsed.link}` : '')
      )
      .setColor(0xf6ad55)
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
  } else {
    // Couldn't confidently parse a code - relay as-is rather than guess wrong,
    // flagged so a leader can check/repost manually if needed.
    await channel.send(`⚠️ New post detected in the gift code feed but couldn't auto-parse a code - please check manually:\n${message.content}`);
  }
}

// ---------------------------------------------------------------------------
// Button interactions: "Request to Join" (from new members) and the leader
// approval buttons (Approve as Member / Approve as Allied Wolf / Deny).
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === 'request_join') {
      const userId = interaction.user.id;

      // Someone without Quarantine can still SEE this button if they have
      // Administrator (which bypasses Discord's channel permissions entirely)
      // - but they shouldn't be able to trigger a real join request.
      if (!interaction.member.roles.cache.has(QUARANTINE_ROLE_ID)) {
        await interaction.reply({ content: "You're already part of the alliance - no need to request again!", ephemeral: true });
        return;
      }

      if (pendingJoinRequests.has(userId)) {
        await interaction.reply({ content: 'Your request is already pending review - sit tight!', ephemeral: true });
        return;
      }
      pendingJoinRequests.add(userId);

      const embed = new EmbedBuilder()
        .setTitle('New Join Request!')
        .setDescription(
          `${interaction.user} (\`${interaction.user.tag}\`) wants to join the pack.\n\n` +
          `@R4 / @R5 please reach out if you do not know the player.\n\n` +
          `[WTF] WAKE THE FERAL ${WOLF_EMOJI}`
        )
        .addFields({ name: 'Account created', value: `<t:${Math.floor(interaction.user.createdTimestamp / 1000)}:R>` })
        .setColor(0xd69e2e)
        .setTimestamp(new Date());

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_member_${userId}`).setLabel('Approve as Member').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`approve_guest_${userId}`).setLabel('Approve as Allied Wolf').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`deny_${userId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
      );

      const appChannel = await client.channels.fetch(APPLICATIONS_CHANNEL_ID);
      if (appChannel) {
        await appChannel.send({
          content: `<@&${R4_ROLE_ID}> <@&${R5_ROLE_ID}>`,
          embeds: [embed],
          components: [row],
          allowedMentions: { roles: [R4_ROLE_ID, R5_ROLE_ID] },
        });
      }

      await interaction.reply({ content: 'Your request has been sent to the leaders for review. Sit tight!', ephemeral: true });
      return;
    }

    const approveMemberMatch = interaction.customId.match(/^approve_member_(\d+)$/);
    const approveGuestMatch = interaction.customId.match(/^approve_guest_(\d+)$/);
    const denyMatch = interaction.customId.match(/^deny_(\d+)$/);

    if (approveMemberMatch || approveGuestMatch || denyMatch) {
      const isApprover = interaction.member.roles.cache.has(R4_ROLE_ID) || interaction.member.roles.cache.has(R5_ROLE_ID);
      if (!isApprover) {
        await interaction.reply({ content: 'Only R4/R5 can action join requests.', ephemeral: true });
        return;
      }

      const targetUserId = (approveMemberMatch || approveGuestMatch || denyMatch)[1];
      const guild = interaction.guild;
      let targetMember;
      try {
        targetMember = await guild.members.fetch(targetUserId);
      } catch {
        await interaction.reply({ content: 'That member seems to have left the server already.', ephemeral: true });
        return;
      }

      let resultText;
      if (approveMemberMatch) {
        await targetMember.roles.remove(QUARANTINE_ROLE_ID).catch(() => {});
        await targetMember.roles.add(R3_ROLE_ID);
        resultText = `✅ Approved as **Member** (R3) by ${interaction.user}`;

        const mainChannel = await client.channels.fetch(CHANNEL_ID);
        if (mainChannel) {
          await mainChannel.send(buildRoleOptInMessage(targetMember, { isNewApproval: true }));
        }
      } else if (approveGuestMatch) {
        await targetMember.roles.remove(QUARANTINE_ROLE_ID).catch(() => {});
        await targetMember.roles.add(ALLIED_WOLF_ROLE_ID);
        resultText = `✅ Approved as **Allied Wolf** by ${interaction.user}`;
      } else {
        // Deny: leave them in Quarantine, don't kick - just notify.
        resultText = `❌ Denied by ${interaction.user} (left in Quarantine)`;
        const qChannel = await client.channels.fetch(QUARANTINE_CHANNEL_ID);
        if (qChannel) {
          await qChannel.send(`${targetMember} your join request was not approved. Please reach out to a leader.`);
        }
      }

      pendingJoinRequests.delete(targetUserId);

      const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
        ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true),
        ButtonBuilder.from(interaction.message.components[0].components[2]).setDisabled(true)
      );

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({ name: 'Outcome', value: resultText });

      await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });
      return;
    }

    const optinMatch = interaction.customId.match(/^optin_([a-z]+)_(\d+)$/);
    if (optinMatch) {
      const [, key, ownerId] = optinMatch;
      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: "This isn't your prompt - use `!role <name>` to manage your own roles.", ephemeral: true });
        return;
      }

      const squad = SQUAD_ROLES[key];
      if (!squad) return;

      const member = interaction.member;
      const hasRole = member.roles.cache.has(squad.id);
      try {
        const updatedMember = hasRole
          ? await member.roles.remove(squad.id)
          : await member.roles.add(squad.id);

        // Rebuild using the member object RETURNED by add/remove (guaranteed
        // fresh role cache) rather than the original reference, then update
        // the message in place with the new button colors.
        const refreshed = buildRoleOptInMessage(updatedMember);
        await interaction.update({ embeds: refreshed.embeds, components: refreshed.components });
        const confirmMsg = await interaction.followUp({
          content: hasRole ? `Removed the **${squad.label}** role.` : `Added the **${squad.label}** role.`,
          ephemeral: true,
        });
        // followUp messages need their own .delete() (deleteReply() only
        // targets the original reply) - clean up after a few seconds.
        setTimeout(() => confirmMsg.delete().catch(() => {}), 3000);
      } catch (err) {
        console.error('Error toggling opt-in role:', err.message);
        await interaction.reply({ content: 'Something went wrong - please tell a leader.', ephemeral: true }).catch(() => {});
      }
      return;
    }

    const pickMatch = interaction.customId.match(/^pickroles_([a-z]+)$/);
    if (pickMatch) {
      const key = pickMatch[1];
      const squad = SQUAD_ROLES[key];
      if (!squad) return;

      const member = interaction.member;
      const hasRole = member.roles.cache.has(squad.id);
      try {
        if (hasRole) {
          await member.roles.remove(squad.id);
        } else {
          await member.roles.add(squad.id);
        }
        // No interaction.update() here - the message is shared by everyone,
        // so it stays exactly as-is. Only the clicking person gets feedback.
        await interaction.reply({
          content: hasRole ? `Removed the **${squad.label}** role.` : `Added the **${squad.label}** role.`,
          ephemeral: true,
        });
        // Ephemeral messages don't auto-dismiss on their own - clean it up
        // after a few seconds so repeated clicks don't pile up in view.
        setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
      } catch (err) {
        console.error('Error toggling pickroles role:', err.message);
        await interaction.reply({ content: 'Something went wrong - please tell a leader.', ephemeral: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Error handling button interaction:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong - please tell a leader.', ephemeral: true }).catch(() => {});
    }
  }
});


client.on('messageCreate', async (message) => {
  // Cross-server "Follow Channel" messages arrive via webhook and would
  // otherwise get skipped by the bot-message filter below - handle this one
  // specific channel first, regardless of author.
  if (RAW_GIFT_FEED_CHANNEL_ID && message.channel.id === RAW_GIFT_FEED_CHANNEL_ID) {
    try {
      await handleGiftFeedMessage(message);
    } catch (err) {
      console.error('Error relaying gift code:', err.message);
    }
    return;
  }

  if (message.author.bot) return;
  const content = message.content.toLowerCase();
  try {
    if (content.startsWith('!timezone')) {
      await handleTimezoneCommand(message);
    } else if (content.startsWith('!cheese')) {
      await handleCheeseCommand(message);
    } else if (content.startsWith('!setup-welcome')) {
      await handleSetupWelcomeCommand(message);
    } else if (content.startsWith('!role')) {
      await handleRoleCommand(message);
    } else if (content.startsWith('!notifications')) {
      await handleNotificationsCommand(message);
    } else if (content.startsWith('!setup-roles')) {
      await handleSetupRolesCommand(message);
    } else if (content.startsWith('!clear')) {
      await handleClearCommand(message);
    }
  } catch (err) {
    console.error('Error handling command:', err);
    await message.reply('Something went wrong - please try again.');
  }
});

// ---------------------------------------------------------------------------
// Cron schedules
// Cron itself must fire at the correct REAL UTC instant. Our schedule data is
// written in server time, so we convert each server-time trigger hour to its
// real UTC equivalent before building the cron patterns.
// ---------------------------------------------------------------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  const sbUTCHours = SB_SLOT_HOURS.map(serverHourToUTCHour); // e.g. [2,6,10,14,18,22]
  // CORRECTED: "03:00" was also a mislabeled BST reading, like SB was - true
  // server-time reset is 3 hours earlier, at 00:00 server time.
  const resetUTCHour = serverHourToUTCHour(0); // AD + leader summary both fire at server 00:00

  // SB: every 4 hours, at the real UTC instants matching server-time slots
  cron.schedule(`0 ${sbUTCHours.join(',')} * * *`, postSBReminder, { timezone: 'Etc/UTC' });

  // AD: once daily at server-time 00:00 (skips itself internally on Sundays)
  cron.schedule(`0 ${resetUTCHour} * * *`, postADReminder, { timezone: 'Etc/UTC' });

  // Leaders channel: copy-paste summary, once daily alongside AD
  cron.schedule(`0 ${resetUTCHour} * * *`, postLeaderSummary, { timezone: 'Etc/UTC' });

  // Cheese events: checked every minute since custom times can have any minute value
  cron.schedule('* * * * *', checkCheeseTimers, { timezone: 'Etc/UTC' });

  // Gather-prep reminder: once weekly, Sunday 20:00 server time (~4h before
  // Monday's AD reset). Server 20:00 doesn't cross a UTC day boundary, so
  // cron's day-of-week (0 = Sunday) lines up directly with no adjustment.
  const gatherPrepUTCHour = serverHourToUTCHour(20);
  cron.schedule(`0 ${gatherPrepUTCHour} * * 0`, postGatherPrepReminder, { timezone: 'Etc/UTC' });

  // Shield reminders: 4-stage countdown to Saturday's 00:00 server reset
  // (start of AD Day 6 "raid day"). The last two triggers cross into
  // Saturday in real UTC terms, so their cron weekday is 6, not 5.
  cron.schedule('0 2 * * 5', () => postShieldReminder('dayAhead'), { timezone: 'Etc/UTC' });   // Fri 00:00 server
  cron.schedule('0 23 * * 5', () => postShieldReminder('threeHours'), { timezone: 'Etc/UTC' }); // Fri 21:00 server
  cron.schedule('0 1 * * 6', () => postShieldReminder('oneHour'), { timezone: 'Etc/UTC' });      // Fri 23:00 server (rolls to Sat UTC)
  cron.schedule('45 1 * * 6', () => postShieldReminder('fifteenMin'), { timezone: 'Etc/UTC' });  // Fri 23:45 server (rolls to Sat UTC)

  console.log(`Cron jobs scheduled - SB every 4h (server hours ${SB_SLOT_HOURS.join(',')} -> UTC hours ${sbUTCHours.join(',')}), AD + leader summary daily at server 00:00 (UTC ${resetUTCHour}), cheese events checked every minute (defaults: Cheese 1 ${CHEESE_DEFAULTS[1].hour}:00, Cheese 2 ${CHEESE_DEFAULTS[2].hour}:00 server time), gather-prep reminder Sunday 20:00 server time (UTC ${gatherPrepUTCHour}), shield reminders Friday 00:00/21:00/23:00/23:45 server time.`);
});

client.login(TOKEN);
