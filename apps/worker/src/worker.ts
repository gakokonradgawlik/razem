import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { calendarReminderAt, localDate, localTimeToInstant, pushEndpointSchema, taskOccurrence, taskRecipients } from '@razem/contracts';
import type { AccountScope, EntityType, SyncRecord } from '@razem/contracts';
import { AccountRepository, RecordRepository } from '@razem/db';
import type { Database, PushTransport, Subscription } from '@razem/db';

type Kind = 'reminder' | 'assignment' | 'shopping';
type Spec = { type: EntityType; target: SyncRecord; kind: Kind; at: string; sequence: number | null; revision: unknown };
type Job = { id: string; subscription_id: string; user_id: string; target_type: EntityType; target_id: string; kind: Kind; event_sequence: number | null; deduplication_key: string; scheduled_at: string; attempts: number; lease_token: string };
type Event = { sequence: number; task_id?: string; entity_id: string; entity_type?: EntityType; kind?: string; version: number; changed_at: string;
  actor_id: string | null; previous_assignee?: 'self' | 'partner' | 'both' | null };
const DAY = 86_400_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: number | string) => new Date(value).toISOString();

/** SQLite owns planning and leases. Transport must time out before the 60s lease. */
export class ReminderWorker {
  private readonly records: RecordRepository;
  private readonly accounts: AccountRepository;
  constructor(private readonly database: Database, private readonly send: PushTransport, private readonly clock = () => new Date()) {
    this.records = new RecordRepository(database); this.accounts = new AccountRepository(database);
  }
  private get sql() { return this.database.sqlite; }
  private scope(userId: string): AccountScope | null {
    const user = this.accounts.userById(userId);
    return user && !user.mustChangePassword ? { userId, householdId: user.householdId } : null;
  }
  private subscriptions(now: string) {
    return this.sql.prepare(`SELECT p.* FROM push_subscriptions p JOIN sessions s ON s.id=p.session_id AND s.user_id=p.user_id
      JOIN users u ON u.id=p.user_id WHERE s.expires_at>? AND u.must_change_password=0
      AND (p.expiration_time IS NULL OR p.expiration_time>?)`).all(now, Date.parse(now)) as Subscription[];
  }
  private key(spec: Spec, subscription: string) {
    return hash([subscription, spec.type, spec.target.id, spec.target.version, spec.kind, spec.at, spec.kind === 'assignment' ? null : spec.sequence, spec.revision]);
  }
  private schedules(scope: AccountScope, now: string, targetId?: string, scheduledAt?: string): Spec[] {
    const result: Spec[] = [];
    const settings = this.accounts.settings(this.accounts.userById(scope.userId)!);
    const prefs = settings.notifications;
    const members = settings.members.map((m) => m.id);
    const allReminders = this.records.list(scope, 'reminder').filter((r) => r.entityType === 'reminder')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    // Legacy clients could store several configurations. The newest one governs a target.
    const reminders = allReminders.filter((r, index) => allReminders.findIndex((other) => other.data.targetType === r.data.targetType && other.data.targetId === r.data.targetId) === index);
    const inWindow = (at: string) => Date.parse(at) >= Date.parse(now) - DAY && Date.parse(at) <= Date.parse(now) + 32 * DAY;
    for (const task of this.records.list(scope, 'task')) {
      if ((targetId && task.id !== targetId) || task.entityType !== 'task' || task.data.completedAt || !taskRecipients(task, members).includes(scope.userId) || prefs.taskReminders === false) continue;
      const config = reminders.filter((r) => r.data.targetType === 'task' && r.data.targetId === task.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
      if (config && !config.data.enabled) continue;
      const completed = new Set(this.records.list(scope, 'task_occurrence').filter((r) => r.entityType === 'task_occurrence' && r.data.taskId === task.id && r.data.completedAt).map((r) => r.entityType === 'task_occurrence' ? r.data.occurrenceKey : ''));
      const dues = [];
      if (task.data.recurrence) {
        const minutes = config?.data.minutesBefore ?? prefs.taskMinutesBefore ?? 0;
        let keys: string[];
        if (scheduledAt) {
          // Validate only the claimed occurrence, including historical timezone segments.
          const base = iso(Date.parse(scheduledAt) + minutes * 60_000);
          const zones = new Set([task.data.timezone, ...(task.data.recurrence.history ?? []).map((segment) => segment.timezone)]);
          keys = [...new Set([...zones].map((zone) => localDate(base, zone)))];
        } else {
          const day = Temporal.PlainDate.from(localDate(iso(Date.parse(now) + minutes * 60_000), task.data.timezone)).subtract({ days: 2 });
          keys = Array.from({ length: 43 }, (_, offset) => day.add({ days: offset }).toString());
        }
        for (const key of keys) {
          if (!completed.has(key)) { const due = taskOccurrence(task.data, key); if (due) dues.push(due); }
        }
      } else dues.push(task.data);
      for (const due of dues) {
        const base = due.dueAt ?? (due.dueDate ? localTimeToInstant(due.dueDate, config?.data.localTime ?? prefs.taskReminderTime ?? '09:00', due.timezone) : null);
        if (!base) continue;
        const at = iso(Date.parse(base) - (config?.data.minutesBefore ?? prefs.taskMinutesBefore ?? 0) * 60_000);
        if (inWindow(at)) result.push({ type: 'task', target: task, kind: 'reminder', at, sequence: null,
          revision: [config?.id, config?.version, due.dueAt ? null : config?.data.localTime ?? prefs.taskReminderTime ?? '09:00', config?.data.minutesBefore ?? prefs.taskMinutesBefore ?? 0, 'occurrenceKey' in due ? due.occurrenceKey : null] });
      }
    }
    for (const config of reminders) {
      if ((targetId && config.data.targetId !== targetId) || !config.data.enabled || config.data.targetType === 'task') continue;
      const target = this.records.get(scope, config.data.targetType, config.data.targetId);
      if (!target || target.deletedAt || (target.entityType !== 'calendar_event' && target.entityType !== 'important_date')) continue;
      const year = Temporal.Instant.from(now).toZonedDateTimeISO(settings.household.timezone).year;
      for (const occurrenceYear of target.entityType === 'important_date' ? [year - 1, year, year + 1, year + 2] : [year]) {
        const raw = calendarReminderAt(target.data, config.data, occurrenceYear, settings.household.timezone);
        if (raw && inWindow(raw)) result.push({ type: target.entityType, target, kind: 'reminder', at: iso(raw), sequence: null,
          revision: [config.id, config.version, target.entityType === 'important_date' ? settings.household.timezone : null] });
      }
    }
    return result;
  }
  private eventSpec(scope: AccountScope, event: Event, kind: Kind, now: string): Spec | null {
    // Unknown legacy/system actors cannot safely produce a partner notification.
    if (!event.actor_id || event.actor_id === scope.userId) return null;
    if (Date.parse(event.changed_at) < Date.parse(now) - DAY) return null;
    const type = kind === 'assignment' ? 'task' : event.entity_type!;
    let target = this.records.get(scope, type, event.task_id ?? event.entity_id);
    if (!target || target.version !== event.version) return null;
    const settings = this.accounts.settings(this.accounts.userById(scope.userId)!);
    if (target.entityType === 'task') {
      if (target.deletedAt) return null;
      if (settings.notifications.taskAssignments === false || target.data.completedAt || !taskRecipients(target, settings.members.map((m) => m.id)).includes(scope.userId)) return null;
      if (event.previous_assignee && taskRecipients({ ...target, data: { assignee: event.previous_assignee } }, settings.members.map((m) => m.id)).includes(scope.userId)) return null;
    } else {
      if (!settings.notifications.shoppingNotifications) return null;
      if (target.entityType === 'shopping_item') {
        const parent = this.records.get(scope, 'shopping_list', target.data.listId);
        if (!parent || parent.deletedAt) return null;
        if (target.deletedAt) target = parent;
      } else if (target.deletedAt) return null;
    }
    return { type: target.entityType, target, kind, at: event.changed_at, sequence: event.sequence, revision: [] };
  }
  /** Full startup scan plus transactional event checkpoints: restart never loses or repeats an insertion. */
  plan() {
    const now = this.clock().toISOString();
    this.sql.transaction(() => {
      this.sql.prepare('DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time<=?').run(Date.parse(now));
      const state = this.sql.prepare('SELECT * FROM worker_state WHERE id=1').get() as { task_sequence: number; shopping_sequence: number };
      const tasks = this.sql.prepare('SELECT * FROM task_events WHERE sequence>? ORDER BY sequence LIMIT 1000').all(state.task_sequence) as Event[];
      const shopping = this.sql.prepare('SELECT * FROM sync_changes WHERE sequence>? ORDER BY sequence LIMIT 1000').all(state.shopping_sequence) as Event[];
      const subscriptions = this.subscriptions(now);
      for (const userId of new Set(subscriptions.map((s) => s.user_id))) {
        const scope = this.scope(userId); if (!scope) continue;
        const specs = this.schedules(scope, now);
        for (const event of tasks.filter((e) => e.kind === 'task.created' || e.kind === 'task.assigned')) {
          const spec = this.eventSpec(scope, event, 'assignment', now); if (spec) specs.push(spec);
        }
        for (const event of shopping.filter((e) => e.entity_type === 'shopping_item' || e.entity_type === 'shopping_list')) {
          const spec = this.eventSpec(scope, event, 'shopping', now); if (spec) specs.push(spec);
        }
        for (const sub of subscriptions.filter((s) => s.user_id === userId)) for (const spec of specs) {
          // A new opt-in never gets old assignments or already elapsed reminders.
          if (spec.at < sub.created_at) continue;
          // Editing a title/preference after a successful send must not repeat the same deadline.
          if (spec.kind === 'reminder' && this.sql.prepare("SELECT 1 FROM reminder_dispatches WHERE subscription_id=? AND target_type=? AND target_id=? AND kind='reminder' AND scheduled_at=? AND state='sent'").get(sub.id, spec.type, spec.target.id, spec.at)) continue;
          this.sql.prepare(`INSERT INTO reminder_dispatches (id,subscription_id,user_id,target_type,target_id,kind,event_sequence,deduplication_key,scheduled_at,state,next_attempt_at)
            VALUES (?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(deduplication_key) DO UPDATE SET state='pending' WHERE reminder_dispatches.state='cancelled' AND reminder_dispatches.scheduled_at>?`)
            .run(randomUUID(), sub.id, userId, spec.type, spec.target.id, spec.kind, spec.sequence, this.key(spec, sub.id), spec.at, spec.at, now);
        }
      }
      this.sql.prepare('UPDATE worker_state SET task_sequence=?,shopping_sequence=? WHERE id=1').run(tasks.at(-1)?.sequence ?? state.task_sequence, shopping.at(-1)?.sequence ?? state.shopping_sequence);
      for (const job of this.sql.prepare("SELECT * FROM reminder_dispatches WHERE state='pending'").all() as Job[]) {
        if (!this.current(job, now)) this.sql.prepare("UPDATE reminder_dispatches SET state='cancelled' WHERE id=? AND state='pending'").run(job.id);
      }
    }).immediate();
  }
  claim(): Job | undefined {
    const now = this.clock().toISOString();
    return this.sql.transaction(() => {
      const job = this.sql.prepare(`SELECT * FROM reminder_dispatches WHERE (state='pending' AND next_attempt_at<=?)
        OR (state='processing' AND lease_until<=?) ORDER BY scheduled_at,id LIMIT 1`).get(now, now) as Job | undefined;
      if (!job) return undefined;
      const token = randomUUID();
      this.sql.prepare("UPDATE reminder_dispatches SET state='processing',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?")
        .run(iso(Date.parse(now) + 60_000), token, job.id);
      return { ...job, attempts: job.attempts + 1, lease_token: token };
    }).immediate();
  }
  private current(job: Job, now: string): { subscription: Subscription; spec: Spec } | null {
    const subscription = this.subscriptions(now).find((s) => s.id === job.subscription_id && s.user_id === job.user_id);
    const scope = this.scope(job.user_id);
    if (!subscription || !scope || !pushEndpointSchema.safeParse(subscription.endpoint).success) return null;
    let specs: Spec[];
    if (job.kind === 'reminder') specs = this.schedules(scope, now, job.target_id, job.scheduled_at);
    else {
      const event = this.sql.prepare(`SELECT * FROM ${job.kind === 'assignment' ? 'task_events' : 'sync_changes'} WHERE sequence=?`).get(job.event_sequence) as Event | undefined;
      const spec = event && this.eventSpec(scope, event, job.kind, now);
      specs = spec ? [spec] : [];
    }
    const spec = specs.find((s) => this.key(s, subscription.id) === job.deduplication_key);
    return spec ? { subscription, spec } : null;
  }
  async dispatchOne(): Promise<boolean> {
    const job = this.claim(); if (!job) return false;
    // No await between this ACL/version/session/preferences check and starting the transport.
    const current = this.current(job, this.clock().toISOString());
    const finish = (state: string, next: string | null = null) => this.sql.prepare(`UPDATE reminder_dispatches SET state=?,next_attempt_at=coalesce(?,next_attempt_at),lease_until=NULL,lease_token=NULL,sent_at=? WHERE id=? AND lease_token=? AND state='processing'`)
      .run(state, next, state === 'sent' ? this.clock().toISOString() : null, job.id, job.lease_token);
    if (!current) { finish('cancelled'); return true; }
    const { subscription, spec } = current;
    const preference = this.accounts.settings(this.accounts.userById(job.user_id)!).notifications;
    const title = 'title' in spec.target.data ? spec.target.data.title : 'name' in spec.target.data ? spec.target.data.name : '';
    try {
      await this.send(subscription, { title: 'Razem', body: preference.includeTitles ? title : 'Masz przypomnienie w Razem',
        tag: job.deduplication_key, url: `/powiadomienie/${spec.type}/${spec.target.id}` });
      finish('sent');
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
      if (status === 404 || status === 410) {
        this.sql.prepare('DELETE FROM push_subscriptions WHERE id=?').run(subscription.id);
      } else if (job.attempts >= 8 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) finish('failed');
      else finish('pending', iso(this.clock().getTime() + Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1))));
      // Never log a transport error: it may include the endpoint, payload and VAPID headers.
    }
    return true;
  }
  async tick() { this.plan(); for (let n = 0; n < 100 && await this.dispatchOne(); n++) { /* bounded batch */ } }
}
