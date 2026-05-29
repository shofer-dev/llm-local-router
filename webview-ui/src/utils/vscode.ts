/**
 * VS Code API wrapper for the webview.
 *
 * Provides a type-safe postMessage bridge that mirrors the pattern
 * used by the shofer extension's webview.
 */

import type { HostMessage, WebviewMessage } from '../types';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let _vscodeApi: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!_vscodeApi) {
    _vscodeApi = acquireVsCodeApi();
  }
  return _vscodeApi;
}

/**
 * Send a message to the extension host.
 */
export function postMessage(message: WebviewMessage): void {
  getVsCodeApi().postMessage(message);
}

/**
 * Listen for messages from the extension host.
 */
export function onMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => {
    handler(event.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

declare function acquireVsCodeApi(): VsCodeApi;
