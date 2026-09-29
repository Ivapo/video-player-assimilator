import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PickedFile, Platform } from './platform';

/**
 * The desktop platform (spec vpa-001 §2.10). Every file comes through the shell, which adds
 * its path to the `stream:` scheme's allow-list (§2.9):
 * - "Open mp4…" cancels the page's file input and invokes `pick_file`, the system dialog;
 * - "Open with" paths arrive as the `opened` event, or from the shell's buffer when they came
 *   before this page subscribed. The most recent path wins.
 */
export function tauriPlatform(input: HTMLInputElement): Platform {
  return {
    onFile(cb: (file: PickedFile) => void): void {
      const deliver = (path: string) =>
        cb({ url: convertFileSrc(path, 'stream'), name: path.split(/[\\/]/).pop() ?? path });

      input.addEventListener('click', (e) => {
        e.preventDefault();
        invoke<string | null>('pick_file').then(
          (path) => path && deliver(path),
          (err) => console.error('pick_file', err),
        );
      });

      // Listen first, then subscribe: the shell hands over the buffer and emits from then on,
      // under one lock, so every path arrives exactly once.
      void (async () => {
        await listen<string[]>('opened', (e) => {
          const last = e.payload.at(-1);
          if (last) deliver(last);
        });
        const buffered = await invoke<string[]>('subscribe_opened');
        const last = buffered.at(-1);
        if (last) deliver(last);
      })().catch((err) => console.error('opened', err));
    },
  };
}
