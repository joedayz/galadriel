// Mira el repo y vuelve a indexar cuando un archivo se guarda.
// Solo node:fs. Al cerrar, el último cambio pendiente entra al índice.

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { ignoredPath, scan, type ScanResult } from "./scan.js";

export interface WatchHandle {
  close(): Promise<void>;
}

export function watchWorkspace(
  root: string,
  opts: { debounceMs?: number; onScan?: (result: ScanResult) => void; onError?: (err: unknown) => void } = {},
): WatchHandle {
  const dir = resolve(root);
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let dirty = false;
  let closed = false;

  // El await inicial deja asignada `running` antes de escanear. Sin eso, un
  // scan síncrono pondría la promesa otra vez en `running` y el siguiente
  // cambio no entraría nunca.
  const scanNow = (): Promise<void> => {
    if (running) {
      dirty = true;
      return running.then(() => (dirty ? scanNow() : undefined));
    }
    running = (async () => {
      await Promise.resolve();
      try {
        do {
          dirty = false;
          try {
            opts.onScan?.(scan(dir));
          } catch (err) {
            opts.onError?.(err);
          }
        } while (dirty);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const schedule = () => {
    dirty = true;
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void scanNow();
    }, debounceMs);
  };

  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, filename) => {
    const name = filename?.toString() ?? "";
    if (name && ignoredPath(name)) return;
    schedule();
  });
  watcher.on("error", (err) => opts.onError?.(err));

  void scanNow();

  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
      if (running) await running;
      try {
        opts.onScan?.(scan(dir));
      } catch (err) {
        opts.onError?.(err);
      }
    },
  };
}
