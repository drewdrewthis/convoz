// Tier-1 app types: the props of each of the 10 app types of schemas/app.json (app.v1), written by hand to match schemas/components/*.json.
// An app arrives validated (validateApp); these types only describe what a component may rely on then.

export type Tone = "default" | "muted" | "accent" | "good" | "warn" | "bad";

export interface ChartProps {
  kind: "line" | "bar" | "spark";
  x?: { labels: string[]; title?: string };
  y?: { unit?: string; min?: number; max?: number; title?: string };
  series: { name: string; values: (number | null)[]; tone?: Tone }[];
  stacked?: boolean;
  refLines?: { value: number; label: string; tone?: Tone }[];
}
export interface TableProps {
  caption?: string;
  columns: { label: string; kind?: "text" | "number"; align?: "left" | "right" }[];
  rows: (string | number | null)[][];
  sortable?: boolean;
  highlightRow?: number;
}
export interface ChecklistProps {
  mode?: "view" | "select";
  items: { id: string; label: string; done: boolean; note?: string }[];
  submitLabel?: string;
  minChecked?: number;
}
export interface KvProps {
  pairs: { k: string; v: string | number; tone?: Tone }[];
  columns?: 1 | 2;
}
export interface PickerProps {
  prompt?: string;
  options: { id: string; label: string; hint?: string }[];
  multi?: boolean;
  min?: number;
  max?: number;
  submitLabel?: string;
}
export interface FormField {
  id: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select" | "toggle" | "date";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: unknown;
  options?: { id: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
}
export interface FormProps {
  intro?: string;
  submitLabel: string;
  fields: FormField[];
}
export interface ProgressProps {
  label?: string;
  value?: number;
  done?: number;
  total?: number;
  tone?: Tone;
  etaAt?: number;
  steps?: { label: string; state: "todo" | "doing" | "done" | "failed" | "skipped" }[];
}
export interface CodeProps {
  mode: "code" | "diff";
  text: string;
  language?: string;
  filename?: string;
  startLine?: number;
  wrap?: boolean;
}
export interface GalleryProps {
  layout?: "grid" | "carousel" | "compare";
  images: { upload: string; alt: string; caption?: string }[];
}
export interface FrameProps {
  bundle: { upload: string; sha256: string; size: number };
  manifest: {
    name: string;
    version: string;
    description?: string;
    icon?: string;
    height?: { initial?: number; min?: number; max?: number };
    results?: boolean;
    permissions: [];
    bridge: number;
    kit: string;
  };
  data?: unknown;
}

interface Base<T extends string, P> {
  v: 1;
  type: T;
  title?: string;
  fallback: string;
  height?: number;
  props: P;
}
export type AppOf =
  | Base<"chart", ChartProps>
  | Base<"table", TableProps>
  | Base<"checklist", ChecklistProps>
  | Base<"kv", KvProps>
  | Base<"picker", PickerProps>
  | Base<"form", FormProps>
  | Base<"progress", ProgressProps>
  | Base<"code", CodeProps>
  | Base<"gallery", GalleryProps>
  | Base<"frame", FrameProps>;
export type App = AppOf;
export type AppType = App["type"];
/** What a message page carries instead of an app over 4096 bytes. */
export interface AppStub {
  stub: true;
  v: number;
  type: string;
  title?: string;
  fallback: string;
  bytes: number;
}

/** A result an app proposes: the host turns it into app-result.v1 (source = the app type that made it). */
export type ResultSource = "picker" | "checklist" | "form" | "frame";

/** A result a Tier-1 component proposes. `rows` are the labelled values the host sheet shows (label, text). */
export interface ProposedResult {
  source: ResultSource;
  summary: string;
  value: unknown;
  rows?: [string, string][];
  direct?: boolean;
}

/** What a Tier-1 component may do. The host decides what a result does; a component only proposes. */
export interface AppContext {
  /** The URL of an uploaded image. */
  fileUrl(publicId: string): string;
  /** A trusted tap proposed a result. `direct` is true for the single picker, whose one tap answers without a sheet. */
  onResult(result: ProposedResult): void;
  /** Set on a Save-Data or slow link: images wait for a tap. */
  saveData?: boolean;
  /** The app sits on an ask: it helps the owner decide and never answers (no result can leave it). */
  onAsk?: boolean;
}
