/**
 * Montra Dynamic Alert Engine (v1.3.0)
 * Evaluates trigger events (calls, DMs, group mentions, messages, keywords) and formats
 * custom alerts using template variables: {name}, {text}, {action}, {time}, {date},
 * {day}, {jid}, {phone}, {group}, {chat_type}, {message_id}, {kind}, {type}, {keyword}.
 * Persists rules to data/alertRules.json and logs call events to data/callLogs.json.
 */
const fs = require('fs');
const path = require('path');
const timeEngine = require('./timeEngine');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const RULES_FILE = path.join(DATA_DIR, 'alertRules.json');
const CALLS_FILE = path.join(DATA_DIR, 'callLogs.json');

const DEFAULT_RULES = [
  {
    id: 'rule-call-default',
    trigger: 'call',
    template: '📞 <b>Incoming Call Alert!</b>\n{name} {action} at {time}.\nPhone: <code>{phone}</code>',
    enabled: true,
    createdAt: new Date().toISOString()
  },
  {
    id: 'rule-mention-default',
    trigger: 'mention',
    template: '📣 <b>Group Mention!</b>\n{name} mentioned you in <b>{group}</b>:\n"{text}"',
    enabled: true,
    createdAt: new Date().toISOString()
  }
];

class AlertEngine {
  constructor() {
    this.rules = this.loadRules();
    // Persist the defaults on first run so their ids stay stable and deleting every rule
    // later cannot resurrect them on the next restart.
    if (!fs.existsSync(RULES_FILE)) this.saveRules();
    this.callLogs = this.loadCalls();
  }

  loadRules() {
    try {
      if (fs.existsSync(RULES_FILE)) {
        const raw = fs.readFileSync(RULES_FILE, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        // An empty array is a valid configuration: the user removed every rule.
        if (Array.isArray(data)) return data;
      }
    } catch (e) {
      console.warn('[AlertEngine] Fallback to default alert rules:', e.message);
    }
    return [...DEFAULT_RULES];
  }

  saveRules() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${RULES_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rules, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, RULES_FILE);
    } catch (e) {
      console.error('[AlertEngine] Save rules failed:', e.message);
    }
  }

  loadCalls() {
    try {
      if (fs.existsSync(CALLS_FILE)) {
        const raw = fs.readFileSync(CALLS_FILE, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
      }
    } catch { /* ignore */ }
    return [];
  }

  saveCalls() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CALLS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.callLogs.slice(-100), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, CALLS_FILE);
    } catch (e) {
      console.error('[AlertEngine] Save calls failed:', e.message);
    }
  }

  formatTemplate(template, vars) {
    let result = String(template || '');
    for (const [key, val] of Object.entries(vars)) {
      const regex = new RegExp(`\\{${key}\\}`, 'gi');
      // A function replacer keeps "$&"-style sequences in message text from being treated
      // as replacement patterns.
      result = result.replace(regex, () => String(val ?? ''));
    }
    return result;
  }

  addRule(trigger, template, customName = null) {
    const cleanTrigger = String(trigger || 'dm').toLowerCase().trim();
    const cleanTemplate = String(template || '').trim();
    if (!cleanTemplate) throw new Error('Alert templates cannot be empty.');
    if (cleanTemplate.length > 2000) throw new Error('Alert templates must be 2000 characters or fewer.');

    const known = new Set(['call', 'dm', 'mention', 'message', 'channel', 'any']);
    let triggerValue = cleanTrigger;
    if (cleanTrigger.startsWith('keyword:')) {
      const word = cleanTrigger.slice('keyword:'.length).trim();
      if (!word) throw new Error('Keyword alerts need a word, e.g. keyword:invoice.');
      triggerValue = `keyword:${word}`;
    } else if (!known.has(cleanTrigger)) {
      throw new Error('Use call, dm, mention, message, channel, any, or keyword:<word>.');
    }

    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newRule = {
      id,
      name: customName || `Alert on ${triggerValue}`,
      trigger: triggerValue,
      template: cleanTemplate,
      enabled: true,
      createdAt: new Date().toISOString()
    };
    this.rules.push(newRule);
    this.saveRules();
    return newRule;
  }

  removeRule(ruleId) {
    const initLen = this.rules.length;
    this.rules = this.rules.filter(r => r.id !== ruleId);
    if (this.rules.length !== initLen) {
      this.saveRules();
      return true;
    }
    return false;
  }

  toggleRule(ruleId, enabled = null) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled !== null ? enabled : !rule.enabled;
      this.saveRules();
      return rule;
    }
    return null;
  }

  listRules() {
    return this.rules;
  }

  /**
   * Log an incoming WhatsApp call event and trigger matching alerts.
   */
  recordCall({ id, from, isGroup, isVideo, status }) {
    const entry = {
      id: id || `call-${Date.now()}`,
      from: from || 'unknown',
      phone: String(from || '').split('@')[0],
      isGroup: Boolean(isGroup),
      isVideo: Boolean(isVideo),
      status: status || 'offer',
      time: timeEngine.timeOfDay(Date.now()),
      timestamp: Date.now()
    };
    this.callLogs.unshift(entry);
    if (this.callLogs.length > 100) this.callLogs.pop();
    this.saveCalls();
    return entry;
  }

  getCallLogs(limit = 20) {
    return this.callLogs.slice(0, limit);
  }

  /**
   * Evaluate incoming event against alert rules.
   * Returns an array of formatted alert messages to deliver to Telegram.
   */
  evaluate({
    type, // 'call' | 'dm' | 'mention' | 'message' | 'group'
    name = '',
    phone = '',
    text = '',
    action = '',
    jid = '',
    group = 'Direct Message',
    keyword = '',
    messageId = '',
    kind = '',
    fromMe = false,
    status = '',
    timestamp = Date.now()
  }) {
    const activeRules = this.rules.filter(r => r.enabled);
    const notifications = [];
    const at = Number(timestamp) || Date.now();
    const isMessageEvent = ['dm', 'mention', 'message', 'group', 'channel'].includes(type);
    const chatType = type === 'call'
        ? 'call'
        : (type === 'channel' ? 'channel' : (String(group || '').toLowerCase() === 'direct message' || type === 'dm' ? 'dm' : 'group'));

    const vars = {
      name: name || phone || 'Unknown Contact',
      phone: phone || jid.split('@')[0],
      text: text || '',
      action: action || (type === 'call' ? 'tried to call you' : type === 'mention' ? 'mentioned you' : 'sent a message'),
      time: timeEngine.timeOfDay(at),
      date: timeEngine.format(at, { dateStyle: 'medium' }),
      day: timeEngine.weekday(at),
      jid,
      group: group || 'Direct Message',
      chat_type: chatType,
      message_id: messageId || '',
      kind: kind || (type === 'call' ? 'call' : 'message'),
      type: type || 'message',
      from_me: fromMe ? 'yes' : 'no',
      status: status || '',
      keyword: keyword || ''
    };

    for (const rule of activeRules) {
      let matches = false;
      let matchedKeyword = '';
      if (rule.trigger === 'any') {
        matches = true;
      } else if (rule.trigger === type) {
        matches = true;
      } else if (rule.trigger === 'message' && isMessageEvent) {
        matches = true;
      } else if (rule.trigger.startsWith('keyword:') && isMessageEvent) {
        const targetWord = rule.trigger.slice('keyword:'.length).toLowerCase();
        if (text && text.toLowerCase().includes(targetWord)) {
          matches = true;
          matchedKeyword = targetWord;
        }
      }

      if (matches) {
        const rendered = this.formatTemplate(rule.template, {
          ...vars,
          keyword: matchedKeyword || keyword,
          rule: rule.name || rule.trigger,
          trigger: rule.trigger
        });
        notifications.push({
          ruleId: rule.id,
          trigger: rule.trigger,
          message: rendered
        });
      }
    }

    return notifications;
  }
}

module.exports = new AlertEngine();
