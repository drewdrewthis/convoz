import { mustPlan, planLine, planOf, planUi } from "../lib/plan.ts";
import { expect, scenario, test } from "../lib/scenario.ts";

// plan.feature: the one scenario that needs the browser in a time zone of its own.
const ZONE = "Pacific/Auckland";
test.use({ timezoneId: ZONE });

scenario("Times show in the owner's time zone with \"~\" for an estimate", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner's browser is in the time zone "Pacific/Auckland"
  const p = await planUi({ server, page, context });
  // And "devtool" works on "Building invites" ready in 30 minutes
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);
  const eta = (await planOf(p, "devtool"))!.eta!;

  // When the owner opens conversation 41
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);

  // Then the line reads "Working · Building invites · ready ~" and the time of the estimate in "Pacific/Auckland"
  const local = new Date(eta).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const utc = new Date(eta).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  expect(local).not.toBe(utc);
  await expect(planLine(page)).toHaveText(`Working · Building invites · ready ~${local}`);
});
