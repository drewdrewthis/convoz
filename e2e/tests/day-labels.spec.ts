import type { Locator, Page } from "@playwright/test";
import { agentPost, agentSays, createConversation, startSession } from "../lib/chat.ts";
import { message, messageLog } from "../lib/chat-ui.ts";
import { send } from "../lib/http.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, inlineThread } from "../lib/threads-wp5.ts";
import { browserWorld, seedDb, type World } from "../lib/wp3.ts";

/*
 * DAY LABELS: specs/features/day-labels.feature (owner-approved UX plan, sections 2 and 3).
 * A message's time is moved by writing its created_at straight into the data file of the encryption-off build, after the API stored it,
 * and BEFORE the owner's browser signs in: the page keeps every message it has seen in its offline cache, so a time changed after it saw
 * the message never reaches it. The times are computed in the browser, so "yesterday at 9:30 AM" is the page's own local day.
 */

const TITLE = "Ship search filters";

/** The ms of `hour`:`minute` local time, `daysAgo` days before today, as the page counts days. */
const localAt = (page: Page, daysAgo: number, hour: number, minute: number): Promise<number> =>
  page.evaluate(([d, h, m]) => {
    const x = new Date();
    x.setDate(x.getDate() - d!);
    x.setHours(h!, m!, 0, 0);
    return x.getTime();
  }, [daysAgo, hour, minute]);

/** The label the plan gives a day older than yesterday: "Wed 21 Oct", with the year when it is not this year's. */
const olderLabel = (page: Page, ms: number): Promise<string> =>
  page.evaluate((at) => {
    const d = new Date(at);
    const base = `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}`;
    return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
  }, ms);

/** Move a stored message to another time. */
const backdate = (dataDir: string, id: number, at: number) => seedDb(dataDir, (db) => db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, id));

/** The names of the day labels in a part of the page, top to bottom (the "New messages" line is a separator too, and is left out). */
const dayLabels = (scope: Locator): Promise<(string | null)[]> =>
  scope.getByRole("separator").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).filter((n) => n !== "New messages"));

interface Seed {
  w: World;
  conv: number;
  /** Session leases of "devtool" and "docs". */
  dev: string;
  docs: string;
}

/** The Background, with `seed` run after conversation 41 exists and before the owner's browser signs in. */
async function seededWorld(fx: Parameters<typeof browserWorld>[0], seed: (s: Seed) => Promise<void>): Promise<Seed> {
  let s: Seed | undefined;
  await browserWorld(fx, {
    agents: ["devtool", "docs"],
    plaintext: true,
    beforeSignIn: async (w) => {
      const conv = await createConversation(w.owner, { participants: ["devtool", "docs"], title: TITLE });
      s = { w, conv, dev: (await startSession(w.box, "devtool", "ui-devtool")).lease, docs: (await startSession(w.box, "docs", "ui-docs")).lease };
      await seed(s);
    },
  });
  return s!;
}

const label = (page: Page, name: string) => messageLog(page).getByRole("separator", { name, exact: true });
const top = async (l: Locator) => (await l.boundingBox())!.y;

scenario("A conversation labels each day once, above its first message", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Given "devtool" posted "Old news" 5 days ago, "Yesterday news" yesterday and "Today news" today in conversation 41
  const oldAt = await localAt(page, 5, 10, 0);
  const { w, conv } = await seededWorld({ server, page, context }, async ({ w, conv, dev }) => {
    const old = await agentSays(w.srv, dev, conv, "Old news");
    const yday = await agentSays(w.srv, dev, conv, "Yesterday news");
    await agentSays(w.srv, dev, conv, "Today news");
    backdate(dataDir, old, oldAt);
    backdate(dataDir, yday, await localAt(page, 1, 10, 0));
  });
  const older = await olderLabel(page, oldAt);

  // When the owner opens conversation 41
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(message(page, "Today news")).toBeVisible();

  // Then the day labels read the date of 5 days ago, "Yesterday" and "Today", in that order and once each
  await expect.poll(() => dayLabels(messageLog(page))).toEqual([older, "Yesterday", "Today"]);

  // And each label is above its day's message and below the message of the day before
  expect(await top(label(page, older))).toBeLessThan(await top(message(page, "Old news")));
  expect(await top(label(page, "Yesterday"))).toBeGreaterThan(await top(message(page, "Old news")));
  expect(await top(label(page, "Yesterday"))).toBeLessThan(await top(message(page, "Yesterday news")));
  expect(await top(label(page, "Today"))).toBeGreaterThan(await top(message(page, "Yesterday news")));
  expect(await top(label(page, "Today"))).toBeLessThan(await top(message(page, "Today news")));
});

scenario("A thread has no day labels, and a reply from another day shows its day by its time", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Given "devtool" posted message 900 "Step 1 is the filter chips UI" 2 days ago
  // And "devtool" replied "Same day reply" in thread 900 that day, and "docs" replied "Next day reply" yesterday at 5:24 PM
  const rootAt = await localAt(page, 2, 10, 0);
  const { w, conv } = await seededWorld({ server, page, context }, async ({ w, conv, dev, docs }) => {
    const root = await agentSays(w.srv, dev, conv, ROOT_TEXT);
    const reply = async (lease: string, body: string) => Number(must(await agentPost(w.srv, lease, conv, body, { thread_root_id: root }), `reply ${body}`, 201).json().id);
    const same = await reply(dev, "Same day reply");
    const next = await reply(docs, "Next day reply");
    backdate(dataDir, root, rootAt);
    backdate(dataDir, same, await localAt(page, 2, 10, 5));
    backdate(dataDir, next, await localAt(page, 1, 17, 24));
  });

  // When the owner opens conversation 41
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const thread = inlineThread(page, ROOT_TEXT);
  const reply = (text: string) => thread.getByRole("article").filter({ hasText: text });
  await expect(reply("Next day reply")).toBeVisible();

  // Then the thread under message 900 shows no day label
  await expect.poll(() => dayLabels(thread)).toEqual([]);
  await expect.poll(() => dayLabels(messageLog(page))).toEqual([await olderLabel(page, rootAt)]); // the root's day, in the main list only

  // And the time of "Next day reply" reads "Yesterday" and then the clock
  await expect(reply("Next day reply").locator("time")).toHaveText(/^Yesterday \d{1,2}[:.]24/);

  // And the time of "Same day reply" is the clock alone
  await expect(reply("Same day reply").locator("time")).toHaveText(/^\d{1,2}[:.]05/);
});

scenario("Hovering the time of a message shows its full date and time", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Given "devtool" posted "Dated news" yesterday at 9:30 AM in conversation 41
  const at = await localAt(page, 1, 9, 30);
  const { w, conv } = await seededWorld({ server, page, context }, async ({ w, conv, dev }) => {
    backdate(dataDir, await agentSays(w.srv, dev, conv, "Dated news"), at);
  });
  const year = String(await page.evaluate((ms) => new Date(ms).getFullYear(), at));

  // When the owner opens conversation 41 and hovers the time of "Dated news"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const time = message(page, "Dated news").locator("time");
  await time.hover();

  // Then the time shows its full date with the year as its title
  await expect(time).toHaveAttribute("title", new RegExp(`\\b${year}\\b`));
  await expect(time).not.toContainText(year); // the time itself stays the clock

  // And the time carries the moment of the message as its machine-readable date
  await expect(time).toHaveAttribute("datetime", new Date(at).toISOString());
});

scenario("On a wide screen a notice line starts at the same left edge as the messages", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the window is 1600 px wide
  await page.setViewportSize({ width: 1600, height: 900 });
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { participants: ["devtool", "docs"], title: TITLE });

  // And "devtool" posted "A message in the column" and the line "Added @docs" is in conversation 41
  await agentSays(w.srv, w.sessions.devtool!.lease, conv, "A message in the column");
  must(await send(w.srv.target, "POST", "/__test/system-line", { json: { conversation: conv, t: "member.added", identity: "docs", by: "drew", via: "add" } }), "write a system line");

  // When the owner opens conversation 41
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const notice = messageLog(page).getByRole("note").filter({ hasText: "Added @docs" });
  const msg = message(page, "A message in the column");
  await expect(notice).toBeVisible();
  await expect(msg).toBeVisible();
  // the pane is wider than the column, or one left edge would prove nothing
  expect((await messageLog(page).boundingBox())!.width).toBeGreaterThan(800);

  // Then the line "Added @docs" starts within 2 px of the left edge of the message
  const left = async (l: Locator) => (await l.boundingBox())!.x;
  expect(Math.abs((await left(notice)) - (await left(msg)))).toBeLessThanOrEqual(2);
});
