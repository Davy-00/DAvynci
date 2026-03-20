import type { SignalSnapshot } from "@/lib/signals";

type PerformancePoint = {
  timestamp_utc: string;
  equity: number;
  balance: number;
};

type RuntimeStore = {
  snapshot: SignalSnapshot | null;
  lastEmailDigest: string;
  subscriberEmail: string;
  performanceHistory: PerformancePoint[];
};

declare global {
  var __davynciStore__: RuntimeStore | undefined;
}

const defaultSnapshot: SignalSnapshot = {
  timestamp_utc: new Date().toISOString(),
  halted: false,
  halt_reason: "Waiting for bot webhook",
  signals: [],
};

export function getStore(): RuntimeStore {
  if (!globalThis.__davynciStore__) {
    globalThis.__davynciStore__ = {
      snapshot: defaultSnapshot,
      lastEmailDigest: "",
      subscriberEmail: "",
      performanceHistory: [],
    };
  }
  return globalThis.__davynciStore__;
}

export function getSnapshot(): SignalSnapshot {
  const store = getStore();
  const snapshot = store.snapshot ?? defaultSnapshot;
  return {
    ...snapshot,
    performance_history: store.performanceHistory,
  };
}

export function setSnapshot(snapshot: SignalSnapshot): void {
  const store = getStore();
  store.snapshot = snapshot;

  const eq = Number(snapshot.account?.equity);
  const bal = Number(snapshot.account?.balance);
  if (Number.isFinite(eq) && Number.isFinite(bal)) {
    const ts = String(snapshot.timestamp_utc || new Date().toISOString());
    const last = store.performanceHistory[store.performanceHistory.length - 1];
    if (!last || last.timestamp_utc !== ts) {
      store.performanceHistory.push({
        timestamp_utc: ts,
        equity: eq,
        balance: bal,
      });
      if (store.performanceHistory.length > 400) {
        store.performanceHistory = store.performanceHistory.slice(-400);
      }
    }
  }
}

export function getLastDigest(): string {
  return getStore().lastEmailDigest;
}

export function setLastDigest(value: string): void {
  getStore().lastEmailDigest = value;
}

export function getSubscriberEmail(): string {
  return getStore().subscriberEmail;
}

export function setSubscriberEmail(email: string): void {
  getStore().subscriberEmail = email;
}
