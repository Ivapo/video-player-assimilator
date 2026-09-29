// How a file reaches the player (spec vpa-001 §2.2). The web build implements it with the
// file input and drag-and-drop; Phase 2 adds a Tauri implementation of the same interface.

export interface PickedFile { url: string; name: string }
export interface Platform { onFile(cb: (file: PickedFile) => void): void }
