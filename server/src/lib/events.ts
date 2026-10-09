/**
 * Change notifications for connected browsers (Server-Sent Events).
 *
 * After every successful write the API publishes the resource it changed
 * (e.g. "stock", "products"). Each browser listening on /api/events refreshes
 * its data, so changes made on one PC appear on the others without a reload.
 *
 * The bus lives in this process: run one server process per database.
 */
import { EventEmitter } from 'node:events';

export interface ChangeEvent {
  scope: string;
  at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(scope: string) {
  bus.emit('change', { scope, at: new Date().toISOString() } satisfies ChangeEvent);
}

export function subscribe(listener: (e: ChangeEvent) => void): () => void {
  bus.on('change', listener);
  return () => bus.off('change', listener);
}

export const subscriberCount = () => bus.listenerCount('change');
