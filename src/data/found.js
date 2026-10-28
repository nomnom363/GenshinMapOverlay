// Als gefunden markierte Marker, nur lokal in found.json.
const fs = require('fs');
const path = require('path');

class FoundStore {
  constructor(file) {
    this.file = file;
    this.ids = new Set();
    this.timer = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const id of data.ids || []) this.ids.add(Number(id));
    } catch {
      // noch nichts markiert
    }
  }

  toggle(id) {
    const n = Number(id);
    if (this.ids.has(n)) this.ids.delete(n);
    else this.ids.add(n);
    this.saveSoon();
    return this.ids.has(n);
  }

  merge(newIds) {
    let added = 0;
    for (const id of newIds) {
      const n = Number(id);
      if (Number.isFinite(n) && !this.ids.has(n)) {
        this.ids.add(n);
        added++;
      }
    }
    if (added > 0) this.saveNow();
    return added;
  }

  list() {
    return [...this.ids];
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ ids: this.list() }), 'utf8');
  }
}

module.exports = { FoundStore };
