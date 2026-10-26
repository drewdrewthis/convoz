// The few Chrome extension APIs the extension uses, typed by hand: a whole @types/chrome for these calls is not worth a dependency.

declare namespace chrome {
  namespace storage.local {
    function get(key: string): Promise<Record<string, unknown>>;
    function set(items: Record<string, unknown>): Promise<void>;
  }
  namespace permissions {
    interface Permissions {
      origins?: string[];
    }
    function request(p: Permissions): Promise<boolean>;
    function contains(p: Permissions): Promise<boolean>;
  }
  namespace windows {
    interface Window {
      id?: number;
    }
    function getLastFocused(o: { windowTypes: "normal"[] }): Promise<Window>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      active: boolean;
      url?: string;
      title?: string;
    }
    interface Event<F> {
      addListener(cb: F): void;
      removeListener(cb: F): void;
    }
    function get(tabId: number): Promise<Tab>;
    function query(q: { active: boolean; windowId: number }): Promise<Tab[]>;
    function create(p: { url: string }): Promise<Tab>;
    function captureVisibleTab(windowId: number, o: { format: "png" }): Promise<string>;
    const onRemoved: Event<(tabId: number) => void>;
    const onUpdated: Event<(tabId: number, change: { url?: string }) => void>;
  }
  namespace scripting {
    function executeScript<T>(i: { target: { tabId: number }; func: () => T }): Promise<{ result?: T }[]>;
  }
  namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      onMessage: { addListener(cb: (message: unknown) => void): void };
      onDisconnect: { addListener(cb: () => void): void };
    }
    function connect(o: { name: string }): Port;
    const onConnect: { addListener(cb: (port: Port) => void): void };
  }
  namespace action {
    const onClicked: { addListener(cb: (tab: tabs.Tab) => void): void };
  }
  namespace sidePanel {
    function open(o: { windowId: number }): Promise<void>;
  }
}
