import fs from "node:fs";
import { expect, scenario } from "../lib/scenario.ts";

scenario("The server refuses a key file others can read", { tag: ["@cli"] }, async ({ dataDir, kekFile, convoz }) => {
  // Given the KEK credential file has mode 0644
  fs.chmodSync(kekFile, 0o644);

  // When "convoz serve" starts
  const res = await convoz(["serve", "--data-dir", dataDir, "--kek-file", kekFile, "--listen", "127.0.0.1:0"]);

  // Then it exits non-zero (10) with a message naming the file and the mode it needs
  expect(res.code).toBe(10);
  expect(res.stderr).toContain(kekFile);
  expect(res.stderr).toContain("0644");
  expect(res.stderr).toContain("needs 0600");
});

scenario("The server refuses to start without its key", { tag: ["@cli"] }, async ({ dataDir, convoz }) => {
  // Given no KEK credential is provided (no --kek-file, no CREDENTIALS_DIRECTORY)
  // When "convoz serve" starts
  const res = await convoz(["serve", "--data-dir", dataDir, "--listen", "127.0.0.1:0"]);

  // Then it exits non-zero (10) with a message that the key is missing
  expect(res.code).toBe(10);
  expect(res.stderr).toContain("convoz: no KEK credential: set --kek-file or CREDENTIALS_DIRECTORY/convoz-kek");
});
