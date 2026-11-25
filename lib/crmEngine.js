/**
 * Montra Contact CRM & Tagging Engine
 * Stores private local tags, priority levels, and custom CRM notes per contact/chat.
 * Persists to data/contactCrm.json with atomic writes.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const CRM_FILE = path.join(DATA_DIR, 'contactCrm.json');

const DEFAULT_TAGS = ['VIP', 'Client', 'Urgent', 'Work', 'Family', 'Archived'];

class CrmEngine {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CRM_FILE)) {
        const raw = fs.readFileSync(CRM_FILE, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        return {
          contacts: parsed.contacts || {}, // jid -> { name, tags: [], notes: '', priority: 'normal', updatedAt }
          availableTags: Array.from(new Set([...(parsed.availableTags || []), ...DEFAULT_TAGS]))
        };
      }
    } catch (e) {
      console.warn('[CrmEngine] Fallback to empty CRM store:', e.message);
    }
    return {
      contacts: {},
      availableTags: [...DEFAULT_TAGS]
    };
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CRM_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, CRM_FILE);
    } catch (e) {
      console.error('[CrmEngine] Save failed:', e.message);
    }
  }

  cleanJid(jid) {
    if (!jid) return '';
    return String(jid).trim().toLowerCase();
  }

  cleanTag(tag) {
    if (!tag) return '';
    return String(tag).trim().slice(0, 30);
  }

  getContact(jid) {
    const key = this.cleanJid(jid);
    if (!key) return null;
    return this.data.contacts[key] || {
      jid: key,
      name: '',
      tags: [],
      notes: '',
      priority: 'normal',
      updatedAt: null
    };
  }

  addTag(jid, tag, name = '') {
    const key = this.cleanJid(jid);
    const cleanTag = this.cleanTag(tag);
    if (!key || !cleanTag) return false;

    if (!this.data.contacts[key]) {
      this.data.contacts[key] = {
        jid: key,
        name: name || key,
        tags: [],
        notes: '',
        priority: 'normal',
        updatedAt: Date.now()
      };
    }

    if (!this.data.contacts[key].tags.includes(cleanTag)) {
      this.data.contacts[key].tags.push(cleanTag);
      this.data.contacts[key].updatedAt = Date.now();
      if (!this.data.availableTags.includes(cleanTag)) {
        this.data.availableTags.push(cleanTag);
      }
      this.save();
      return true;
    }
    return false;
  }

  removeTag(jid, tag) {
    const key = this.cleanJid(jid);
    const cleanTag = this.cleanTag(tag);
    if (!key || !cleanTag || !this.data.contacts[key]) return false;

    const initialLen = this.data.contacts[key].tags.length;
    this.data.contacts[key].tags = this.data.contacts[key].tags.filter(t => t.toLowerCase() !== cleanTag.toLowerCase());

    if (this.data.contacts[key].tags.length !== initialLen) {
      this.data.contacts[key].updatedAt = Date.now();
      this.save();
      return true;
    }
    return false;
  }

  setNote(jid, note, name = '') {
    const key = this.cleanJid(jid);
    if (!key) return false;

    if (!this.data.contacts[key]) {
      this.data.contacts[key] = {
        jid: key,
        name: name || key,
        tags: [],
        notes: '',
        priority: 'normal',
        updatedAt: Date.now()
      };
    }

    this.data.contacts[key].notes = String(note || '').slice(0, 4000);
    this.data.contacts[key].updatedAt = Date.now();
    if (name) this.data.contacts[key].name = name;
    this.save();
    return true;
  }

  setPriority(jid, priority = 'normal') {
    const key = this.cleanJid(jid);
    if (!key || !this.data.contacts[key]) return false;
    const valid = ['low', 'normal', 'high', 'urgent'];
    this.data.contacts[key].priority = valid.includes(priority) ? priority : 'normal';
    this.data.contacts[key].updatedAt = Date.now();
    this.save();
    return true;
  }

  listByTag(tag) {
    const cleanTag = this.cleanTag(tag).toLowerCase();
    const result = [];
    for (const contact of Object.values(this.data.contacts)) {
      if (contact.tags && contact.tags.some(t => t.toLowerCase() === cleanTag)) {
        result.push(contact);
      }
    }
    return result;
  }

  getAll() {
    return {
      contacts: this.data.contacts,
      availableTags: this.data.availableTags,
      totalTagged: Object.values(this.data.contacts).filter(c => c.tags?.length > 0).length
    };
  }
}

module.exports = new CrmEngine();
