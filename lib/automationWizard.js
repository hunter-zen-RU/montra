'use strict';
/**
 * Step definitions and state machine for the interactive automation wizards.
 *
 * Every automation setting is asked for in its own message, and every step declares
 * the same four escape hatches: a typed answer, a list of tappable choices, a default
 * and (where switching the thing off is meaningful) an explicit "disabled" value. That
 * keeps the flows declarative — this module holds no Telegram, WhatsApp or store code,
 * so a flow can be tested by feeding it strings and reading the payload it produces.
 */

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WHEN_TEXT = /^(\d{1,2}:\d{2}|\+\d+[mhd]$|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?)$/i;
const SCHEDULE_TEXT = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*[-–—]\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/;

function text(raw) {
  return String(raw ?? '').trim();
}

/** Free-text step that must not be empty. */
function requiredText(maxLength) {
  return (raw) => {
    const value = text(raw);
    if (!value) return { ok: false, error: 'Type something, or use the buttons below.' };
    if (value.length > maxLength) return { ok: false, error: `That is ${value.length} characters; the limit is ${maxLength}.` };
    return { ok: true, value };
  };
}

function integerBetween(min, max) {
  return (raw) => {
    const value = text(raw);
    if (!/^-?\d+$/.test(value)) return { ok: false, error: `Give a whole number between ${min} and ${max}.` };
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}.` };
    return { ok: true, value: n };
  };
}

function minutesAtLeastZero(label) {
  return (raw) => {
    const value = text(raw);
    if (!/^\d+$/.test(value)) return { ok: false, error: `Give ${label} as whole minutes, e.g. 30.` };
    const n = Number(value);
    if (n > 24 * 60) return { ok: false, error: `${label} cannot exceed 1440 minutes (24 hours).` };
    return { ok: true, value: n };
  };
}

/**
 * A step. The "Disabled" button stores `disabledValue`; a step whose "off" state would be
 * meaningless declares neither default nor disabled, which makes it a required answer.
 */
function step(spec) {
  const hasDefault = 'defaultValue' in spec && spec.defaultValue !== undefined;
  const hasDisabled = 'disabledValue' in spec && spec.disabledValue !== undefined;
  return {
    key: spec.key,
    label: spec.label,
    question: spec.question,
    hint: spec.hint || '',
    choices: spec.choices || [],
    defaultValue: hasDefault ? spec.defaultValue : undefined,
    defaultLabel: spec.defaultLabel || '',
    hasDefault,
    disabledValue: hasDisabled ? spec.disabledValue : undefined,
    disabledLabel: spec.disabledLabel || '',
    hasDisabled,
    parse: spec.parse || ((raw) => ({ ok: true, value: text(raw) })),
    display: spec.display || ((value) => (Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? 'off' : String(value)))
  };
}

const autoreplyFlow = {
  id: 'autoreply',
  title: '📣 Auto-reply rule',
  description: 'Creates one trigger-based WhatsApp reply. Nothing is saved until you confirm.',
  steps: [
    step({
      key: 'trigger', label: 'Trigger',
      question: 'Which word or phrase should set the reply off?',
      hint: 'Required. Matching is controlled on the next steps.',
      parse: requiredText(100)
    }),
    step({
      key: 'message', label: 'Reply text',
      question: 'What should Montra send back?',
      hint: 'Required. Placeholders: {name} = sender name, {trigger} = the matched text.',
      parse: requiredText(800)
    }),
    step({
      key: 'usage', label: 'Where',
      question: 'Where should this rule answer?',
      choices: [
        { label: '🙋 Private chats', value: 'dms' },
        { label: '👥 Groups, only when mentioned', value: 'groups-mentioned' }
      ],
      defaultValue: 'dms', defaultLabel: 'private chats',
      disabledValue: 'dms', disabledLabel: 'private chats — the safest default',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['dms', 'dm', 'private'].includes(value)) return { ok: true, value: 'dms' };
        if (['groups', 'groups-mentioned', 'groups mentioned', 'groups-mention'].includes(value)) return { ok: true, value: 'groups-mentioned' };
        return { ok: false, error: 'Answer with "dms" or "groups-mentioned", or tap a button.' };
      },
      display: (value) => (value === 'groups-mentioned' ? 'groups, when mentioned' : 'private chats')
    }),
    step({
      key: 'match', label: 'Match style',
      question: 'How closely must the incoming message match the trigger?',
      choices: [
        { label: '🔎 Contains it', value: 'contains' },
        { label: '🎯 Exactly it', value: 'exact' },
        { label: '🔝 Starts with it', value: 'startsWith' },
        { label: '🧩 Regex', value: 'regex' }
      ],
      defaultValue: 'contains', defaultLabel: 'contains',
      disabledValue: 'contains', disabledLabel: 'contains — matches any message holding the trigger',
      parse: (raw) => {
        const value = text(raw);
        const alias = { contains: 'contains', contain: 'contains', exact: 'exact', equals: 'exact', startswith: 'startsWith', starts: 'startsWith', 'starts-with': 'startsWith', regex: 'regex' };
        const mapped = alias[value.toLowerCase().replace(/[\s_-]/g, '')] || alias[value.toLowerCase()];
        if (!mapped) return { ok: false, error: 'Use contains, exact, startsWith or regex.' };
        return { ok: true, value: mapped };
      }
    }),
    step({
      key: 'priority', label: 'Priority',
      question: 'If several rules match, which wins?',
      hint: 'Higher runs first. 0 is ordinary; use 10 for an urgent rule.',
      choices: [
        { label: '0 — ordinary', value: 0 },
        { label: '10 — high', value: 10 },
        { label: '-10 — low', value: -10 }
      ],
      defaultValue: 0, defaultLabel: '0',
      disabledValue: 0, disabledLabel: '0 — no special ranking',
      parse: integerBetween(-100, 100),
      display: (value) => String(value)
    }),
    step({
      key: 'cooldown', label: 'Cooldown',
      question: 'How long should Montra wait before replying to the same chat again?',
      hint: 'Minutes. Leave it on the default to inherit the global cooldown.',
      choices: [
        { label: '⏱ 5 minutes', value: 5 },
        { label: '⏱ 30 minutes', value: 30 },
        { label: '⏱ 60 minutes', value: 60 },
        { label: '🚫 Disabled — reply every time', value: 'off' }
      ],
      defaultValue: null, defaultLabel: 'global cooldown',
      disabledValue: 'off', disabledLabel: 'no wait between replies to the same chat',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['off', 'none', 'never', 'disabled', 'no'].includes(value)) return { ok: true, value: 'off' };
        return minutesAtLeastZero('The cooldown')(value);
      },
      display: (value) => (value === 'off' ? 'disabled (every matching message replies)' : value === null ? 'global cooldown' : `${value} min`)
    }),
    step({
      key: 'contacts', label: 'Who it applies to',
      question: 'Restrict the rule to certain contacts? Type names, numbers or JIDs separated by commas.',
      hint: 'Empty means everyone, which is the default.',
      defaultValue: [], defaultLabel: 'every contact',
      disabledValue: [], disabledLabel: 'no restriction — any contact can trigger it',
      choices: [{ label: '🚫 Disabled — everyone', value: [] }],
      parse: (raw) => {
        const value = text(raw);
        if (!value || ['off', 'none', 'all', 'any', 'disabled', '-'].includes(value.toLowerCase())) return { ok: true, value: [] };
        const list = value.split(',').map(x => x.trim()).filter(Boolean);
        if (!list.length) return { ok: false, error: 'Give at least one name, number or JID, or "off" for everyone.' };
        if (list.length > 100) return { ok: false, error: 'A rule can list at most 100 contacts.' };
        return { ok: true, value: list };
      },
      display: (value) => (Array.isArray(value) && value.length ? value.join(', ') : 'every contact')
    }),
    step({
      key: 'schedule', label: 'Active hours',
      question: 'Limit the rule to a window of the day? Type HH:MM-HH:MM, e.g. 09:00-17:30.',
      hint: 'Server local time. Outside the window the rule stays silent.',
      choices: [
        { label: '🌅 09:00-17:00', value: { start: '09:00', end: '17:00' } },
        { label: '🌙 18:00-22:00', value: { start: '18:00', end: '22:00' } },
        { label: '🚫 Disabled — always active', value: null }
      ],
      defaultValue: null, defaultLabel: 'always active',
      disabledValue: null, disabledLabel: 'no time restriction',
      parse: (raw) => {
        const value = text(raw);
        if (!value || ['off', 'none', 'always', 'disabled', '-'].includes(value.toLowerCase())) return { ok: true, value: null };
        const m = SCHEDULE_TEXT.exec(value);
        if (!m) return { ok: false, error: 'Use HH:MM-HH:MM, for example 09:00-17:30, or "off".' };
        const start = `${m[1].padStart(2, '0')}:${m[2]}`;
        const end = `${m[3].padStart(2, '0')}:${m[4]}`;
        return { ok: true, value: { start, end } };
      },
      display: (value) => (value ? `${value.start}–${value.end}` : 'always active')
    }),
    step({
      key: 'enabled', label: 'Arm the rule',
      question: 'Turn the rule on straight away?',
      hint: 'Choosing disabled stores it switched off, so you can review it first.',
      choices: [
        { label: '▶️ On', value: true },
        { label: '⏸ Disabled — store it switched off', value: false }
      ],
      defaultValue: true, defaultLabel: 'on',
      disabledValue: false, disabledLabel: 'created switched off',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['on', 'yes', 'y', 'enable', 'true'].includes(value)) return { ok: true, value: true };
        if (['off', 'no', 'n', 'disable', 'false'].includes(value)) return { ok: true, value: false };
        return { ok: false, error: 'Answer "on" or "off".' };
      },
      display: (value) => (value ? 'on' : 'disabled (stored switched off)')
    })
  ],
  build(values) {
    const cooldown = values.cooldown;
    return {
      trigger: values.trigger,
      message: values.message,
      usage: values.usage,
      match: values.match,
      priority: values.priority,
      // "off" is explicit: the engine treats a zero per-rule cooldown as "inherit the global one".
      cooldownMin: cooldown === 'off' || cooldown === null ? 0 : cooldown,
      cooldownOff: cooldown === 'off',
      contacts: values.contacts,
      schedule: values.schedule,
      enabled: values.enabled
    };
  }
};

function whenStep(key = 'when') {
  return step({
    key, label: 'When',
    question: 'When should it fire?',
    hint: 'HH:MM repeats daily, +30m / +2h / +1d fire once, 2026-12-31T15:00 fires at that date/time.',
    choices: [
      { label: '⏳ In 30 minutes', value: '+30m' },
      { label: '⏳ In 2 hours', value: '+2h' },
      { label: '⏳ Tomorrow 09:00', value: '09:00' },
      { label: '🚫 Disabled — do not schedule', value: null }
    ],
    defaultValue: '+30m', defaultLabel: 'in 30 minutes',
    disabledValue: null, disabledLabel: 'nothing is scheduled',
    parse: (raw) => {
      const value = text(raw);
      if (!value || ['off', 'none', 'never', 'disabled', '-'].includes(value.toLowerCase())) return { ok: true, value: null };
      if (!WHEN_TEXT.test(value)) return { ok: false, error: 'Use HH:MM, +30m, +2h, +1d or a date like 2026-12-31T15:00.' };
      if (value.includes(':') && !TIME.test(value.replace(' ', 'T').split('T')[0])) return { ok: false, error: 'Times are HH:MM on a 24-hour clock.' };
      return { ok: true, value };
    },
    display: (value) => (value === null ? 'disabled' : value)
  });
}

function textStep(key = 'text', label = 'Message') {
  return step({
    key, label,
    question: `What ${label.toLowerCase()} should it send?`,
    hint: 'Plain text. It is delivered as written.',
    parse: requiredText(2000)
  });
}

function expiryStep() {
  return step({
    key: 'expiry', label: 'Expiry',
    question: 'For a daily job, when should it stop?',
    hint: 'Type +7d, +30d or a date like 2026-12-31. Ignored for a one-off job.',
    choices: [
      { label: '♾ Never', value: 'never' },
      { label: '📅 After 7 days', value: '+7d' },
      { label: '📅 After 30 days', value: '+30d' }
    ],
    defaultValue: 'never', defaultLabel: 'never',
    disabledValue: 'never', disabledLabel: 'no expiry — keeps repeating',
    parse: (raw) => {
      const value = text(raw);
      if (!value || ['never', 'off', 'none', '-'].includes(value.toLowerCase())) return { ok: true, value: 'never' };
      if (!/^\+\d+[mhd]$|^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/i.test(value)) {
        return { ok: false, error: 'Use "never", +7d / +12h, or a date like 2026-12-31.' };
      }
      return { ok: true, value };
    },
    display: (value) => (value === 'never' ? 'never (disabled)' : value)
  });
}

function targetStep(allowWhatsApp) {
  return step({
    key: 'target', label: 'Target',
    question: allowWhatsApp
      ? 'Where should the message go? Type "me" for this Telegram chat, or a WhatsApp number, JID or contact name.'
      : 'Which Telegram chat should receive it? Type "me" to keep it here.',
    hint: allowWhatsApp ? 'Numbers need the country code, e.g. 2348012345678.' : 'Only this Telegram chat and its IDs are accepted.',
    defaultValue: 'me', defaultLabel: 'this Telegram chat',
    disabledValue: 'me', disabledLabel: 'this Telegram chat',
    choices: [
      { label: '💬 This Telegram chat', value: 'me' },
      ...(allowWhatsApp ? [{ label: '📱 A WhatsApp contact', value: '__ask__' }] : [])
    ],
    parse: (raw) => {
      const value = text(raw);
      if (!value) return { ok: false, error: 'Type "me", a number or a JID — or use the buttons.' };
      if (['me', 'tg', 'telegram', 'here', 'this'].includes(value.toLowerCase())) return { ok: true, value: 'me' };
      if (value.startsWith('tg:')) return { ok: true, value };
      if (/@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/.test(value)) return { ok: true, value };
      if (allowWhatsApp && /^[+\d][\d\s-]{5,}$/.test(value)) return { ok: true, value: value.replace(/[^\d+]/g, '') };
      if (allowWhatsApp && value.length <= 60) return { ok: true, value };
      return { ok: false, error: 'Give "me", a phone number, a JID or a contact name.' };
    },
    display: (value) => (value === 'me' ? 'this Telegram chat' : value)
  });
}

const cronFlow = {
  id: 'cron',
  title: '⏰ Scheduled job',
  description: 'Schedules a message to Telegram or WhatsApp. The job only runs while Montra is up.',
  context: { allowWhatsAppTarget: true, kind: 'cron' },
  steps: [
    whenStep(),
    targetStep(true),
    textStep('text', 'message'),
    expiryStep(),
    step({
      key: 'enabled', label: 'Arm the job',
      question: 'Start the job immediately?',
      hint: 'Choosing disabled stores it paused; resume it later with /jobs resume <n>.',
      choices: [
        { label: '▶️ Start it', value: true },
        { label: '⏸ Disabled — store it paused', value: false }
      ],
      defaultValue: true, defaultLabel: 'pending',
      disabledValue: false, disabledLabel: 'created paused',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['on', 'yes', 'y', 'true', 'start'].includes(value)) return { ok: true, value: true };
        if (['off', 'no', 'n', 'false', 'pause'].includes(value)) return { ok: true, value: false };
        return { ok: false, error: 'Answer "on" or "off".' };
      },
      display: (value) => (value ? 'starts now' : 'disabled (stored paused)')
    })
  ],
  build(values) {
    return { kind: 'cron', when: values.when, target: values.target, text: values.text, expiry: values.expiry, enabled: values.enabled };
  }
};

const reminderFlow = {
  id: 'remind',
  title: '🔔 Reminder',
  description: 'A reminder always lands in this Telegram chat — nothing is sent to WhatsApp.',
  context: { allowWhatsAppTarget: false, kind: 'reminder' },
  steps: [
    whenStep(),
    textStep('text', 'reminder'),
    expiryStep()
  ],
  build(values) {
    return { kind: 'reminder', when: values.when, target: 'me', text: values.text, expiry: values.expiry, enabled: true };
  }
};

const notifyFlow = {
  id: 'notify',
  title: '📬 Notification',
  description: 'A one-shot notification in this Telegram chat.',
  context: { allowWhatsAppTarget: false, kind: 'notify' },
  steps: [
    whenStep(),
    textStep('text', 'notification'),
    expiryStep()
  ],
  build(values) {
    return { kind: 'notify', when: values.when, target: 'me', text: values.text, expiry: values.expiry, enabled: true };
  }
};

const forwardFlow = {
  id: 'forward',
  title: '🔁 Incoming forwarding',
  description: 'How WhatsApp traffic streams into Telegram.',
  context: {},
  steps: [
    step({
      key: 'forwardIncoming', label: 'Forwarding',
      question: 'Stream incoming WhatsApp messages into Telegram?',
      choices: [
        { label: '▶️ On', value: true },
        { label: '🚫 Disabled', value: false }
      ],
      defaultValue: true, defaultLabel: 'on',
      disabledValue: false, disabledLabel: 'nothing streams in',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['on', 'yes', 'y', 'true'].includes(value)) return { ok: true, value: true };
        if (['off', 'no', 'n', 'false'].includes(value)) return { ok: true, value: false };
        return { ok: false, error: 'Answer "on" or "off".' };
      },
      display: (value) => (value ? 'on' : 'disabled')
    }),
    step({
      key: 'forwardMode', label: 'Which chats',
      question: 'Which chats should stream?',
      choices: [
        { label: '🌐 Every chat', value: 'all' },
        { label: '🎧 Only chats opened with /open', value: 'active' }
      ],
      defaultValue: 'all', defaultLabel: 'every chat',
      disabledValue: 'active', disabledLabel: 'only the chats you open',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['all', 'every', 'everything'].includes(value)) return { ok: true, value: 'all' };
        if (['active', 'opened', 'open'].includes(value)) return { ok: true, value: 'active' };
        return { ok: false, error: 'Answer "all" or "active".' };
      }
    }),
    step({
      key: 'forwardOwn', label: 'Your own sends',
      question: 'Also forward messages you send from WhatsApp?',
      choices: [
        { label: '▶️ On', value: true },
        { label: '🚫 Disabled — off', value: false }
      ],
      defaultValue: false, defaultLabel: 'off',
      disabledValue: false, disabledLabel: 'off — only incoming messages stream',
      parse: (raw) => {
        const value = text(raw).toLowerCase();
        if (['on', 'yes', 'y', 'true'].includes(value)) return { ok: true, value: true };
        if (['off', 'no', 'n', 'false'].includes(value)) return { ok: true, value: false };
        return { ok: false, error: 'Answer "on" or "off".' };
      },
      display: (value) => (value ? 'on' : 'disabled')
    })
  ],
  build(values) {
    return { forwardIncoming: values.forwardIncoming, forwardMode: values.forwardMode, forwardOwn: values.forwardOwn };
  }
};

const flows = {
  autoreply: autoreplyFlow,
  cron: cronFlow,
  remind: reminderFlow,
  notify: notifyFlow,
  forward: forwardFlow
};

function getFlow(id) {
  const flow = flows[text(id).toLowerCase()];
  if (!flow) throw new Error(`Unknown automation flow "${id}".`);
  return flow;
}

function listFlows() {
  return Object.values(flows).map(flow => ({ id: flow.id, title: flow.title, description: flow.description, steps: flow.steps.length }));
}

function createSession(flowId, context = {}) {
  const flow = getFlow(flowId);
  return {
    flowId: flow.id,
    values: {},
    marks: {},
    index: 0,
    confirmed: false,
    createdAt: Date.now(),
    context,
    chatId: String(context.chatId ?? ''),
    stepCount: flow.steps.length
  };
}

function currentStepOf(session) {
  const flow = getFlow(session.flowId);
  if (session.confirmed || session.index >= flow.steps.length) return null;
  return flow.steps[session.index];
}

/** Marks the active step with a value and remembers how it was obtained. */
function assign(session, value, mark) {
  const stepDef = currentStepOf(session);
  if (!stepDef) return session;
  session.values[stepDef.key] = value;
  session.marks[stepDef.key] = mark;
  return session;
}

function answerText(session, raw) {
  const stepDef = currentStepOf(session);
  if (!stepDef) return { ok: false, error: 'This wizard has no open question.' };
  const result = stepDef.parse(raw);
  if (!result.ok) return result;
  assign(session, result.value, 'typed');
  return { ok: true };
}

function chooseOption(session, choiceIndex) {
  const stepDef = currentStepOf(session);
  if (!stepDef) return { ok: false, error: 'This wizard has no open question.' };
  const choice = stepDef.choices[Number(choiceIndex)];
  if (!choice) return { ok: false, error: 'That option no longer exists — the list may have moved on.' };
  // A "__ask__" choice means "then type the value", so the index does not advance.
  if (choice.value === '__ask__') return { ok: true, ask: true, prompt: stepDef.question };
  assign(session, choice.value, 'choice');
  return { ok: true };
}

function useDefault(session) {
  const stepDef = currentStepOf(session);
  if (!stepDef) return { ok: false, error: 'This wizard has no open question.' };
  if (!stepDef.hasDefault) return { ok: false, error: `${stepDef.label} has no default — it needs an answer.` };
  assign(session, stepDef.defaultValue, 'default');
  return { ok: true };
}

function useDisabled(session) {
  const stepDef = currentStepOf(session);
  if (!stepDef) return { ok: false, error: 'This wizard has no open question.' };
  if (!stepDef.hasDisabled) return { ok: false, error: `${stepDef.label} cannot be disabled — it is required.` };
  assign(session, stepDef.disabledValue, 'disabled');
  return { ok: true };
}

/** Moves to the next question, or flags the wizard ready for confirmation. */
function advance(session) {
  const flow = getFlow(session.flowId);
  if (session.confirmed) return { done: true };
  if (session.index + 1 >= flow.steps.length) {
    session.index = flow.steps.length;
    return { confirm: true };
  }
  session.index += 1;
  return { step: flow.steps[session.index] };
}

function goBack(session) {
  const flow = getFlow(session.flowId);
  if (session.confirmed) { session.confirmed = false; session.index = flow.steps.length - 1; return flow.steps[session.index]; }
  if (session.index === 0) return null;
  session.index -= 1;
  return flow.steps[session.index];
}

function jumpTo(session, key) {
  const flow = getFlow(session.flowId);
  const index = flow.steps.findIndex(x => x.key === key);
  if (index < 0) return false;
  session.index = index;
  session.confirmed = false;
  return true;
}

/** Answers an out-of-order question, e.g. from an edit jump. */
function setKeyValue(session, key, raw) {
  const flow = getFlow(session.flowId);
  const stepDef = flow.steps.find(x => x.key === key);
  if (!stepDef) return { ok: false, error: `This wizard has no "${key}" field.` };
  const result = stepDef.parse(raw);
  if (!result.ok) return result;
  session.values[key] = result.value;
  session.marks[key] = 'typed';
  return { ok: true };
}

function missingRequired(session) {
  const flow = getFlow(session.flowId);
  return flow.steps
    .filter(s => !s.hasDefault && !s.hasDisabled)
    .filter(s => session.values[s.key] === undefined || session.values[s.key] === '' || session.values[s.key] === null)
    .map(s => s.label);
}

/** Ordered [label, value, mark] rows for the confirmation screen. */
function summaryRows(session) {
  const flow = getFlow(session.flowId);
  return flow.steps.map(s => [s.label, s.display(session.values[s.key]), session.marks[s.key] || 'default']);
}

function buildPayload(session) {
  const flow = getFlow(session.flowId);
  const missing = missingRequired(session);
  if (missing.length) throw new Error(`Still needs an answer: ${missing.join(', ')}.`);
  const values = {};
  for (const s of flow.steps) values[s.key] = session.values[s.key] === undefined ? s.defaultValue : session.values[s.key];
  return flow.build(values, session.context);
}

module.exports = {
  flows,
  getFlow,
  listFlows,
  createSession,
  currentStepOf,
  answerText,
  chooseOption,
  useDefault,
  useDisabled,
  advance,
  goBack,
  jumpTo,
  setKeyValue,
  summaryRows,
  missingRequired,
  buildPayload,
  assign
};
