import { messageLog, sendButton, uiWorld } from "../lib/chat-ui.ts";
import { listConversations } from "../lib/chat.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { filesToSend, pasteFiles } from "../lib/ui-wp10.ts";
import { png } from "../lib/uploads-wp10.ts";

/*
 * A NEW CONVERSATION CAN START WITH A FILE (conv 15 msgs 316, 317): specs/features/conversations.feature. The image goes in by the Attach
 * button or by paste, with no text or with text, and the first message carries it. A file-only first message names the conversation after the file.
 */

const chart = { name: "chart.png", type: "image/png", bytes: png(16, 16, true) };

// Owner (Drew, conv 15 msg 316): "I can send an image as the first message"; msg 317: "*can't"
scenario("The owner can start a conversation with an image and no text", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" has a live session
  const u = await uiWorld({ server, page, context }, { live: ["devtool"] });
  const seen = new Set<number>();

  for (const how of ["picker", "paste"] as const) {
    for (const words of ["", "Here is the chart"]) {
      // When the owner opens New conversation with "devtool" and attaches "chart.png" by the Attach button or by paste
      await page.goto(`${u.w.srv.origin}/chats/new?with=devtool`);
      const box = page.getByRole("textbox", { name: /^Message/ });
      if (words) await box.fill(words);
      if (how === "picker") {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach a file" }).click({ timeout: 3_000 })]);
        await chooser.setFiles({ name: chart.name, mimeType: chart.type, buffer: chart.bytes });
      } else {
        expect(await pasteFiles(box, [chart])).toBe(true);
      }

      // Then the composer shows "chart.png" under "Files to send" and Send is enabled
      await expect(filesToSend(page)).toContainText("chart.png");
      await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });
      await expect(sendButton(page)).toBeEnabled();

      // When the owner sends
      await sendButton(page).click();
      await expect(page).toHaveURL(/\/chats\/\d+$/);
      const conv = Number(/\/chats\/(\d+)$/.exec(page.url())![1]);

      // Then the new conversation holds one message with the image, and with the words when there are any
      await expect(messageLog(page).getByRole("article")).toHaveCount(1);
      await expect(messageLog(page).getByRole("img", { name: "chart.png" })).toBeVisible();
      const posted = await pageOf(u.w.owner, conv);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toBe(words);
      expect(posted[0]!.uploads!.map((x) => x.name)).toEqual(["chart.png"]);
      expect(seen.has(conv)).toBe(false);
      seen.add(conv);

      // And the conversation is titled by the words, or by the file name when there are none
      const row = (await listConversations(u.w.owner)).find((c) => c.id === conv)!;
      expect(row.title).toBe(words || "chart.png");
    }
  }
  if ((page.viewportSize()?.width ?? 0) < 500) await page.screenshot({ path: "/tmp/firstimg-mobile.png" });
});
