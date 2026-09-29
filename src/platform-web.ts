import type { PickedFile, Platform } from './platform';

/**
 * The browser platform: an `<input type="file">` and drag-and-drop onto `dropTarget`.
 * Each file becomes an object URL, and the previous one is revoked when the next arrives.
 */
export function webPlatform(input: HTMLInputElement, dropTarget: HTMLElement): Platform {
  let current: string | null = null;

  return {
    onFile(cb: (file: PickedFile) => void): void {
      const deliver = (file: File) => {
        if (current) URL.revokeObjectURL(current);
        current = URL.createObjectURL(file);
        cb({ url: current, name: file.name });
      };

      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) deliver(file);
        input.value = '';
      });

      dropTarget.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropTarget.classList.add('dragging');
      });
      dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('dragging'));
      dropTarget.addEventListener('drop', (e) => {
        e.preventDefault();
        dropTarget.classList.remove('dragging');
        const file = e.dataTransfer?.files[0];
        if (file) deliver(file);
      });

      // Dev build only: `?src=<url>` loads a file once. The Safari test needs it, because
      // safaridriver cannot set a file input. A production build does not contain this.
      if (import.meta.env.DEV) {
        const src = new URLSearchParams(location.search).get('src');
        if (src) cb({ url: src, name: src.split('/').pop() ?? src });
      }
    },
  };
}
