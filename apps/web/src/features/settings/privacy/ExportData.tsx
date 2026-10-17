import { useEffect, useState } from "react";
import { call, client, humanError, stepUp } from "../../../shared/api.ts";
import { useNotice } from "../../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../../shared/sheets.tsx";

type Job = { id: string; status: "running" | "done" | "failed" };

const POLL_MS = 500;

/** ExportData is /settings/export: one passkey check starts the export; a download is offered when the job is done. */
export function ExportData() {
  const { fail } = useNotice();
  const { sheet, open } = useSheets();
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setTimeout(() => {
      call(client.GET("/api/me/export/{id}", { params: { path: { id: job.id } } }))
        .then((next) => setJob({ id: job.id, status: (next as Job).status }))
        .catch((err) => fail(humanError(err)));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, fail]);

  const start = () =>
    open((close) => (
      <StepUpSheet
        title="Export your data"
        intro="Every conversation you can see is packed into one zip file."
        confirm="Export"
        action="data.export"
        close={close}
        perform={async (stepId) => {
          const started = await call(client.POST("/api/me/export", { body: {}, params: { header: stepUp(stepId) } }));
          setJob({ id: started.id, status: started.status });
        }}
      />
    ));

  return (
    <>
      <p className="lead">Export your data</p>
      <p className="muted">The file stays ready for one hour. Nothing is kept on the server after that.</p>
      <div className="actions">
        <button className="btn primary" type="button" onClick={start} disabled={job?.status === "running"}>
          Export my data
        </button>
      </div>
      {job?.status === "running" ? <p role="status">Preparing your export.</p> : null}
      {job?.status === "failed" ? <p role="alert">The export failed. Try again.</p> : null}
      {job?.status === "done" ? (
        <div className="actions">
          <a className="btn primary" href={`/api/me/export/${job.id}?download=1`} download>
            Download export
          </a>
        </div>
      ) : null}
      {sheet}
    </>
  );
}
