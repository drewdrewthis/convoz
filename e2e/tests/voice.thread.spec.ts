import fs from "node:fs";
import path from "node:path";
import { expect, scenario, test } from "../lib/scenario.ts";
import { ROOT_TEXT, mainList, openThread, threadLog, threadOf, threadPane, threadWorld } from "../lib/threads-wp5.ts";
import { scratch, setEngine, wav } from "../lib/uploads-wp10.ts";

/*
 * VOICE NOTES IN A THREAD: specs/features/voice.feature, rule "Voice notes work in a thread". The reply box of the thread has the
 * same microphone as the main composer: a button "Record a voice message" inside the thread, the bar "Recording a voice message" in
 * place of the box, and "Send voice message".
 */

const mic = path.join(scratch(), "fixture-thread-recording.wav");
fs.writeFileSync(mic, wav(60));
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`] } });

scenario("The owner can record a voice note in a thread", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Given "devtool" posted message 900 in conversation 41 and the owner opened its thread
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await page.getByRole("log", { name: "Messages" }).waitFor();
  await openThread(page, ROOT_TEXT);

  // And the workspace transcription engine is set
  await setEngine({ srv: t.w.srv, owner: t.w.owner }, "fake", "ship the filters on Thursday");

  // When the owner records a voice note in the thread's reply box and sends it
  const pane = threadPane(page);
  await pane.getByRole("button", { name: "Record a voice message" }).click();
  await expect(pane.getByRole("group", { name: "Recording a voice message" })).toBeVisible();
  await new Promise((r) => setTimeout(r, 2_500));
  await pane.getByRole("button", { name: "Send voice message" }).click();

  // Then the thread shows one voice reply with the transcript
  const notes = threadLog(page).getByRole("article").filter({ has: page.getByRole("button", { name: /^(Play|Pause) voice message$/ }) });
  await expect(notes).toHaveCount(1);
  await notes.first().getByRole("button", { name: "Transcript" }).click({ timeout: 30_000 }).catch(async (err: Error) => {
    // Tell a server that did not finish (state pending here too) from a page that missed the update (state done here, "Transcribing…" on screen).
    const replies = (await threadOf(t.w.owner, t.root)).messages as unknown as { id: number; uploads?: { id: string; kind: string; transcript?: unknown }[] }[];
    const state = replies.flatMap((m) => (m.uploads ?? []).map((u) => ({ message: m.id, upload: u.id, kind: u.kind, transcript: u.transcript ?? null })));
    throw new Error(`${err.message}\nthe thread as the API reads it now: ${JSON.stringify(state)}`);
  });
  await expect(notes.first().getByText("ship the filters on Thursday")).toBeVisible();

  // And the main list of conversation 41 shows no new message: the one voice note in the log is the reply in the thread
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
  await expect(page.getByRole("log", { name: "Messages", exact: true }).getByRole("article").filter({ has: page.getByRole("button", { name: /^(Play|Pause) voice message$/ }) })).toHaveCount(1);
});
