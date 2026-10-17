// The contract of one service worker module (push, cache, ...).

/** SwModule is what a file in src/sw/ exports as `default`. */
export interface SwModule {
  /** A short name for logs. */
  name: string;
  /** Adds the module's listeners (push, fetch, ...) to the worker. Runs once, when the worker script starts. */
  install(scope: ServiceWorkerGlobalScope): void;
}
