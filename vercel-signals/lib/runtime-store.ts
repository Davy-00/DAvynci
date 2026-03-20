import type { SignalSnapshot } from "@/lib/signals";

type RuntimeStore = {
  snapshot: SignalSnapshot | null;
  lastEmailDigest: string;
  subscriberEmail: string;
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
    };
  }
  return globalThis.__davynciStore__;
}

export function getSnapshot(): SignalSnapshot {
  return getStore().snapshot ?? defaultSnapshot;
}

export function setSnapshot(snapshot: SignalSnapshot): void {
  getStore().snapshot = snapshot;
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
