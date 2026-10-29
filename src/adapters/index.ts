import { adaptDycast, looksLikeDycast } from './dycast.ts';
import { adaptGrabber, looksLikeGrabber } from './grabber.ts';
import type { BridgeMessage } from '../types.ts';

export type AdapterKind = 'auto' | 'dycast' | 'grabber';

export function adaptBridgePayload(
  payload: unknown,
  preferred: AdapterKind,
): { messages: BridgeMessage[]; adapter: 'dycast' | 'grabber' | 'unknown' } {
  if (preferred === 'dycast') {
    return { messages: adaptDycast(payload), adapter: 'dycast' };
  }
  if (preferred === 'grabber') {
    return { messages: adaptGrabber(payload), adapter: 'grabber' };
  }
  if (looksLikeDycast(payload)) {
    return { messages: adaptDycast(payload), adapter: 'dycast' };
  }
  if (looksLikeGrabber(payload)) {
    return { messages: adaptGrabber(payload), adapter: 'grabber' };
  }
  // Last resort: try dycast shape (arrays / Webcast*) then grabber
  if (Array.isArray(payload)) {
    return { messages: adaptDycast(payload), adapter: 'dycast' };
  }
  const grabber = adaptGrabber(payload);
  if (grabber.length) return { messages: grabber, adapter: 'grabber' };
  return { messages: adaptDycast(payload), adapter: 'unknown' };
}

export { adaptDycast, adaptGrabber, looksLikeDycast, looksLikeGrabber };
