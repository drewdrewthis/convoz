// The few Chrome extension APIs the extension uses, typed by hand: a whole @types/chrome for eight calls is not worth a dependency.

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
      url?: string;
      title?: string;
    }
    function query(q: { active: boolean; windowId: number }): Promise<Tab[]>;
    function create(p: { url: string }): Promise<Tab>;
    function captureVisibleTab(windowId: number, o: { format: "png" }): Promise<string>;
  }
  namespace scripting {
    function executeScript<T>(i: { target: { tabId: number }; func: () => T }): Promise<{ result?: T }[]>;
  }
  namespace action {
    const onClicked: { addListener(cb: (tab: tabs.Tab) => void): void };
  }
  namespace sidePanel {
    function open(o: { windowId: number }): Promise<void>;
  }
}
