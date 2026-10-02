import { useSyncExternalStore } from 'react';
import type { ConversationItem, SessionSnapshot, SessionState } from '../../shared/api';
import { api } from './api';

export interface SessionView {
  state: SessionState;
  items: ConversationItem[];
  sentFromApp: Set<string>;
  replay: { data: string; end: number } | null;
}

/**
 * Conversations for the sessions the window has open, kept up to date from main-process events.
 * Items arrive as upserts: a tool call is sent again when its result lands, and keeps its place.
 */
class SessionStore {
  private views = new Map<string, SessionView>();
  private positions = new Map<string, Map<string, number>>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor() {
    api.onItems((id, items) => this.upsert(id, items));
    api.onState((state) => this.patch(state.sessionId, (v) => ({ ...v, state })));
    api.onSentFromApp((id, itemId) => this.patch(id, (v) => ({ ...v, sentFromApp: new Set(v.sentFromApp).add(itemId) })));
  }

  async open(sessionId: string): Promise<string | null> {
    const r = await api.openSession(sessionId);
    if (!r.ok) return r.error;
    this.load(sessionId, r.value);
    return null;
  }

  close(sessionId: string): void {
    api.closeSessionView(sessionId);
  }

  get(sessionId: string | null): SessionView | undefined {
    return sessionId ? this.views.get(sessionId) : undefined;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshotVersion = () => this.version;

  private load(id: string, snap: SessionSnapshot) {
    const pos = new Map(snap.items.map((it, i) => [it.id, i]));
    this.positions.set(id, pos);
    this.views.set(id, { state: snap.state, items: snap.items, sentFromApp: new Set(snap.sentFromApp), replay: snap.replay });
    this.emit();
  }

  private upsert(id: string, incoming: ConversationItem[]) {
    const view = this.views.get(id);
    if (!view) return;
    const pos = this.positions.get(id)!;
    const items = [...view.items];
    for (const it of incoming) {
      const at = pos.get(it.id);
      if (at === undefined) {
        pos.set(it.id, items.length);
        items.push(it);
      } else {
        items[at] = it;
      }
    }
    this.views.set(id, { ...view, items });
    this.emit();
  }

  private patch(id: string, fn: (v: SessionView) => SessionView) {
    const view = this.views.get(id);
    if (!view) return;
    this.views.set(id, fn(view));
    this.emit();
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const sessions = new SessionStore();

export function useSession(sessionId: string | null): SessionView | undefined {
  useSyncExternalStore(sessions.subscribe, sessions.snapshotVersion);
  return sessions.get(sessionId);
}
