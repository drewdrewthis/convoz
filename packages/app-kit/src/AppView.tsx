import type { App, AppContext } from "./types.ts";
import { Form, Picker } from "./tier1/Actions.tsx";
import { Chart } from "./tier1/Chart.tsx";
import { Code } from "./tier1/Code.tsx";
import { Gallery } from "./tier1/Gallery.tsx";
import { Checklist, Kv, Progress } from "./tier1/Simple.tsx";
import { Table } from "./tier1/Table.tsx";

/** AppView draws one Tier-1 app (every type except `frame`, which the host runs in a sandboxed iframe). */
export function AppView({ app, ctx }: { app: App; ctx: AppContext }) {
  switch (app.type) {
    case "chart":
      return <Chart props={app.props} title={app.title} height={app.height} />;
    case "table":
      return <Table props={app.props} title={app.title} />;
    case "code":
      return <Code props={app.props} />;
    case "gallery":
      return <Gallery props={app.props} ctx={ctx} />;
    case "kv":
      return <Kv props={app.props} />;
    case "progress":
      return <Progress props={app.props} />;
    case "checklist":
      return <Checklist props={app.props} ctx={ctx} />;
    case "picker":
      return <Picker props={app.props} title={app.title} ctx={ctx} />;
    case "form":
      return <Form props={app.props} title={app.title} ctx={ctx} />;
    default:
      return null;
  }
}
