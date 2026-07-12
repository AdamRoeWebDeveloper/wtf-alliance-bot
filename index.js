require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
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
// Two rallying events, every day, at fixed default server times (Cheese 1 =
// 16:00, Cheese 2 = 22:00). Leaders can change either time with
// "!cheese 1 07:00" - once changed, it keeps running at the NEW time every
// day going forward, until a leader changes it again (or resets it back to
// default). In-memory only - a bot restart reverts both back to their
// hard-coded defaults below.
// ---------------------------------------------------------------------------
const CHEESE_DEFAULTS = { 1: { hour: 16, minute: 0 }, 2: { hour: 22, minute: 0 } };
const cheeseSchedule = { 1: { ...CHEESE_DEFAULTS[1] }, 2: { ...CHEESE_DEFAULTS[2] } };

// Tracks the server-time date (YYYY-MM-DD) each phase last fired for each
// event, so each daily occurrence only triggers its reminders once.
const cheeseNotified = {
  1: { oneHour: null, tenMin: null, start: null },
  2: { oneHour: null, tenMin: null, start: null },
};

const CHEESE_RALLY_RULE = "Only launch **1 rally** - do not join others' rallies. This lets offline members get rewards too.";

// Server-time calendar date as a plain string, for "has this fired today yet".
function serverDateString(realDate) {
  const s = toServerTime(realDate);
  const pad = (n) => String(n).padStart(2, '0');
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

// Today's occurrence (in real UTC) of a given server-time hour/minute. Used
// fresh every tick - no rollover needed since "today" naturally advances.
function getTodaysRealTarget(hour, minute, realNow) {
  const serverNow = toServerTime(realNow);
  const serverTarget = new Date(Date.UTC(
    serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate(), hour, minute, 0
  ));
  return new Date(serverTarget.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
}

// Next occurrence (rolls to tomorrow if today's has already passed) - used
// only for display purposes (!timezone, !cheese status), not for the cron logic.
function getNextRealTarget(hour, minute, realNow) {
  const serverNow = toServerTime(realNow);
  let serverTarget = new Date(Date.UTC(
    serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate(), hour, minute, 0
  ));
  if (serverTarget.getTime() <= serverNow.getTime()) {
    serverTarget = new Date(serverTarget.getTime() + 24 * 60 * 60 * 1000);
  }
  return new Date(serverTarget.getTime() + SERVER_TIME_OFFSET_HOURS * 60 * 60 * 1000);
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
    await channel.send({ content: pingPrefix(), embeds: [embed], allowedMentions: { parse: ['everyone', 'roles'] } });
  }
}

// Runs every minute: for each cheese event's configured daily time, checks
// whether we're in the 1-hour / 10-minute / start window and fires once per
// day per phase. Range checks (not exact equality) so a missed/delayed tick
// still catches it on the next run.
async function checkCheeseTimers() {
  const now = new Date();
  const today = serverDateString(now);

  for (const num of Object.keys(cheeseSchedule)) {
    const { hour, minute } = cheeseSchedule[num];
    const target = getTodaysRealTarget(hour, minute, now);
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
  if (LEADER_ROLE_ID) {
    return message.member && message.member.roles.cache.has(LEADER_ROLE_ID);
  }
  return message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function handleCheeseCommand(message) {
  const content = message.content.trim();

  // "!cheese status" is read-only - anyone can check it, no leader permission needed.
  if (/^!cheese\s+status$/i.test(content)) {
    const lines = Object.keys(cheeseSchedule).map(num => {
      const { hour, minute } = cheeseSchedule[num];
      const isDefault = hour === CHEESE_DEFAULTS[num].hour && minute === CHEESE_DEFAULTS[num].minute;
      const next = getNextRealTarget(hour, minute, new Date());
      const minutesLeft = Math.round((next.getTime() - Date.now()) / 60000);
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      return `Cheese ${num}: ${timeStr} server time daily${isDefault ? ' (default)' : ' (custom)'} - next in ${minutesLeft} min`;
    });
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
// 7-day event, starts Friday 03:00 SERVER TIME, repeats weekly.
// Fixed lookup table (NOT a formula - Day 4 restarts Day 2's pattern,
// Day 5 restarts Day 3's pattern, per confirmed screenshots).
// Slots each day: 03:00, 07:00, 11:00, 15:00, 19:00, 23:00 SERVER TIME
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

const SB_SLOT_HOURS = [3, 7, 11, 15, 19, 23];

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
// 6-day event, Monday-Saturday, starts 03:00 SERVER TIME Monday, no event Sunday.
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
    tip: 'Send gatherers out right after reset - queued/in-transit gathering still counts.',
    holdForCrossover: [
      { action: 'Level up Heroes using Antitoxin', hours: [3, 23], sbActivity: 'Enhance Heroes' },
    ],
    unconfirmedCrossover: ['Complete Falcon Quest', 'Consume 1 Raven Essence'],
    noCrossover: ['Consume 1 Stamina', 'Gather Grain/Timber/Herbs', 'Consume 1 Raven Fruit'],
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
      { action: 'Use 1m Construction Speedup', hours: [3, 23], sbActivity: 'Build Territory' },
      { action: 'Increase 1 Building Might', hours: [3, 23], sbActivity: 'Build Territory' },
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
      { action: 'Use 1m Research Speedup', hours: [7], sbActivity: 'Technology Research' },
      { action: 'Increase 1 Tech Might', hours: [7], sbActivity: 'Technology Research' },
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
      { action: 'Level up Heroes using Antitoxin', hours: [11], sbActivity: 'Enhance Heroes' },
      { action: 'Recruit heroes', hours: [11], sbActivity: 'Enhance Heroes' },
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
      { action: 'Use 1m Construction Speedup / Increase Building Might', hours: [11], sbActivity: 'Build Territory' },
      { action: 'Use 1m Training Boost / Train soldiers', hours: [15], sbActivity: 'Train Soldiers' },
      { action: 'Use 1m Research Speedup / Increase Tech Might', hours: [19], sbActivity: 'Technology Research' },
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
    tip: 'War day - defeating in a targeted alliance match scores far more per kill than general combat.',
    holdForCrossover: [
      { action: 'Use 1m Construction Speedup', hours: [7], sbActivity: 'Build Territory' },
      { action: 'Use 1m Training Boost', hours: [11], sbActivity: 'Train Soldiers' },
      { action: 'Use 1m Research Speedup', hours: [15], sbActivity: 'Technology Research' },
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

function pingPrefix() {
  // @everyone on every notification, plus an optional extra role ping if configured.
  return PING_ROLE_ID ? `@everyone <@&${PING_ROLE_ID}> ` : '@everyone ';
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
    await channel.send({ content: pingPrefix(), embeds: [embed], allowedMentions: { parse: ['everyone', 'roles'] } });
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
    await channel.send({ content: pingPrefix(), embeds: [embed], allowedMentions: { parse: ['everyone', 'roles'] } });
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
    await channel.send({ content: pingPrefix(), embeds: [embed], allowedMentions: { parse: ['everyone', 'roles'] } });
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
      return `Cheese ${num}: ${formatRealInstantInZone(next, zoneOffset)} (in ${minutesLeft} min, daily)`;
    })
    .join('\n');
  embed.addFields({ name: '🧀 Cheese Events', value: cheeseText });

  embed
    .setFooter({ text: 'Fixed UTC offset - not DST-aware. Pick CET vs CEST / EST vs EDT etc. based on what currently applies.' })
    .setColor(0x4a5568)
    .setTimestamp(realNow);

  await message.reply({ embeds: [embed] });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.toLowerCase();
  try {
    if (content.startsWith('!timezone')) {
      await handleTimezoneCommand(message);
    } else if (content.startsWith('!cheese')) {
      await handleCheeseCommand(message);
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

  const sbUTCHours = SB_SLOT_HOURS.map(serverHourToUTCHour); // e.g. [6,10,14,18,22,2]
  const resetUTCHour = serverHourToUTCHour(3); // AD + leader summary both fire at server 03:00

  // SB: every 4 hours, at the real UTC instants matching server-time slots
  cron.schedule(`0 ${sbUTCHours.join(',')} * * *`, postSBReminder, { timezone: 'Etc/UTC' });

  // AD: once daily at server-time 03:00 (skips itself internally on Sundays)
  cron.schedule(`0 ${resetUTCHour} * * *`, postADReminder, { timezone: 'Etc/UTC' });

  // Leaders channel: copy-paste summary, once daily alongside AD
  cron.schedule(`0 ${resetUTCHour} * * *`, postLeaderSummary, { timezone: 'Etc/UTC' });

  // Cheese events: checked every minute since custom times can have any minute value
  cron.schedule('* * * * *', checkCheeseTimers, { timezone: 'Etc/UTC' });

  console.log(`Cron jobs scheduled - SB every 4h (server hours ${SB_SLOT_HOURS.join(',')} -> UTC hours ${sbUTCHours.join(',')}), AD + leader summary daily at server 03:00 (UTC ${resetUTCHour}), cheese events checked every minute (defaults: Cheese 1 ${CHEESE_DEFAULTS[1].hour}:00, Cheese 2 ${CHEESE_DEFAULTS[2].hour}:00 server time).`);
});

client.login(TOKEN);
