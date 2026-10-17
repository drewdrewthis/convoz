import type { Page } from "@playwright/test";
import { addLatency, installNetworkReport, reportNetwork, type Reported } from "../lib/bind.ts";
import { requestLog } from "../lib/apps-wp11.ts";
import { createConversation } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { openConversation, voiceWorld } from "../lib/ui-wp10.ts";
import { png, postWith, uploadWhole } from "../lib/uploads-wp10.ts";

// Binding of settings.feature "Media auto-load decides when images load". The browser's link is what its Network Information API
// reports (lib/bind.ts), with the round trip added by the browser's own network emulation; the device setting is set where the owner
// sets it, in Settings -> Advanced. Page contract: a safe image of a message is an img named by its file name; while media waits for a
// tap the image is a button that names the file and says "<size> · tap to load".

const files = (urls: string[]) => urls.filter((u) => u.includes("/api/files/"));

/** Settings -> Advanced: pick the device's media auto-load. */
async function chooseSetting(page: Page, origin: string, name: "Automatic" | "Always" | "Never"): Promise<void> {
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("radio", { name }).check();
  await expect(page.getByRole("radio", { name })).toBeChecked();
}

scenario("Media auto-load decides when images load", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: owner "drew" with a conversation that holds an image, in a browser that reports what the test says
  const u = await voiceWorld({ server, page, context });
  await installNetworkReport(context);
  const owner = { srv: u.w.srv, owner: u.w.owner };
  let rows = 0;

  const row = async (setting: "Automatic" | "Always" | "Never", reported: Reported, rtt: number, loads: "at once" | "a tap") => {
    // Given a conversation with an image of its own (a file the browser has not seen: it cannot come from its memory)
    const chart = `chart-${(rows += 1)}.png`;
    const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: `Ship search filters ${rows}` });
    const up = await uploadWhole(owner, conv, "image", chart, png(8, 8, true));
    expect((await postWith(owner, conv, "The chart", [up.id])).status).toBe(201);

    // And the device setting "media auto-load" is "<setting>" and the network is <network>
    await chooseSetting(page, u.w.srv.origin, setting);
    await reportNetwork(page, reported);
    await addLatency(context, page, rtt);
    const requests = requestLog(page);

    // When the owner opens a conversation with an image
    await openConversation(page, u.w.srv, conv);

    // Then the image <loads>
    const image = page.getByRole("img", { name: chart });
    const wait = page.getByRole("button", { name: /tap to load/ });
    if (loads === "at once") {
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
      expect(files(requests)).toHaveLength(1);
      await expect(wait).toHaveCount(0);
      return;
    }
    await expect(wait).toContainText(chart);
    await expect(wait).toContainText(/\d+ (B|KB) · tap to load/);
    // a browser that cannot name its link is judged by its pings: let them come in before saying nothing was fetched
    if (reported.type === null) await expect.poll(() => requests.filter((r) => r.includes("/api/ping")).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(500);
    expect(files(requests)).toEqual([]);
    await expect(image).toHaveCount(0);
    await wait.click();
    await expect(image).toBeVisible();
    await expect.poll(() => files(requests).length).toBe(1);
  };

  await row("Automatic", { type: "4g" }, 40, "at once");
  await row("Automatic", { type: "3g" }, 0, "a tap");
  await row("Automatic", { type: null }, 450, "a tap");
  await row("Always", { type: "3g" }, 0, "at once");
  await row("Never", { type: "4g" }, 40, "a tap");
});
