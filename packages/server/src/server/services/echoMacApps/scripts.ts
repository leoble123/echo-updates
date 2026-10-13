// JavaScript for Automation (JXA) run by osascript. Each script's run() gets a
// single JSON argument and returns JSON. Bulk property reads (`items.name()`)
// are one Apple Event for the whole collection, which is what keeps these fast.

const SAFE = "function safe(f, d) { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } }";

/** Every list, and every reminder not yet completed. */
export const REMINDERS_LIST = `${SAFE}
function run(argv) {
  const R = Application("Reminders");
  const out = { lists: [], reminders: [], defaultList: safe(() => R.defaultList().id(), null) };
  const lists = R.lists();
  for (const l of lists) {
    const lid = l.id();
    out.lists.push({ id: lid, name: l.name(), color: safe(() => l.color(), null) });
    const rs = l.reminders.whose({ completed: false });
    const ids = safe(() => rs.id(), []);
    if (!ids.length) continue;
    const names = safe(() => rs.name(), []);
    const dues = safe(() => rs.dueDate(), []);
    const bodies = safe(() => rs.body(), []);
    const flagged = safe(() => rs.flagged(), []);
    const prio = safe(() => rs.priority(), []);
    for (let i = 0; i < ids.length; i++) {
      out.reminders.push({
        id: ids[i], list: lid, name: names[i] || "",
        due: dues[i] ? dues[i].getTime() : null,
        body: bodies[i] || "", flagged: !!flagged[i], priority: prio[i] || 0
      });
    }
  }
  return JSON.stringify(out);
}`;

export const REMINDER_CREATE = `${SAFE}
function run(argv) {
  const a = JSON.parse(argv[0]);
  const R = Application("Reminders");
  const list = a.list ? R.lists.byId(a.list) : R.defaultList();
  const props = { name: a.name };
  if (a.body) props.body = a.body;
  if (a.due) props.dueDate = new Date(a.due);
  const r = R.Reminder(props);
  list.reminders.push(r);
  return JSON.stringify({ id: safe(() => r.id(), null) });
}`;

export const REMINDER_UPDATE = `
function run(argv) {
  const a = JSON.parse(argv[0]);
  const r = Application("Reminders").reminders.byId(a.id);
  if (a.completed !== undefined) r.completed = !!a.completed;
  if (a.name !== undefined) r.name = a.name;
  if (a.flagged !== undefined) r.flagged = !!a.flagged;
  if (a.due !== undefined) r.dueDate = a.due ? new Date(a.due) : null;
  return JSON.stringify({ ok: true });
}`;

export const REMINDER_DELETE = `
function run(argv) {
  const a = JSON.parse(argv[0]);
  const R = Application("Reminders");
  R.delete(R.reminders.byId(a.id));
  return JSON.stringify({ ok: true });
}`;

/** The most recently changed notes: titles and dates first, then a snippet for each of the newest. */
export const NOTES_LIST = `${SAFE}
function run(argv) {
  const a = JSON.parse(argv[0] || "{}");
  const N = Application("Notes");
  const all = N.notes;
  const ids = all.id(), names = all.name(), mods = all.modificationDate();
  const locked = safe(() => all.passwordProtected(), []);
  const order = ids.map((_, i) => i).sort((x, y) => mods[y] - mods[x]).slice(0, a.limit || 100);
  const out = [];
  for (const i of order) {
    const isLocked = !!locked[i];
    const note = all.byId(ids[i]);
    const text = isLocked ? "" : safe(() => note.plaintext(), "");
    out.push({
      id: ids[i], name: names[i] || "", modified: mods[i] ? mods[i].getTime() : null, locked: isLocked,
      folder: safe(() => note.container().name(), null),
      snippet: text.replace(/\\s+/g, " ").slice(names[i] ? names[i].length : 0).trim().slice(0, 160)
    });
  }
  return JSON.stringify(out);
}`;

export const NOTE_GET = `${SAFE}
function run(argv) {
  const a = JSON.parse(argv[0]);
  const n = Application("Notes").notes.byId(a.id);
  const locked = safe(() => n.passwordProtected(), false);
  const body = locked ? "" : n.body();
  return JSON.stringify({
    id: a.id, name: n.name(), locked: locked,
    modified: safe(() => n.modificationDate().getTime(), null),
    folder: safe(() => n.container().name(), null),
    text: locked ? "" : safe(() => n.plaintext(), ""),
    html: body,
    // Images, drawings, tables and checklists don't survive a plain-text edit.
    rich: /<img|<object|<table|checklist|<ul class="Apple-dash-list"/i.test(body)
  });
}`;

export const NOTE_CREATE = `${SAFE}
function run(argv) {
  const a = JSON.parse(argv[0]);
  const N = Application("Notes");
  const folder = N.defaultAccount().defaultFolder();
  const n = N.Note({ body: a.html });
  folder.notes.push(n);
  return JSON.stringify({ id: safe(() => n.id(), null) });
}`;

export const NOTE_UPDATE = `
function run(argv) {
  const a = JSON.parse(argv[0]);
  Application("Notes").notes.byId(a.id).body = a.html;
  return JSON.stringify({ ok: true });
}`;
