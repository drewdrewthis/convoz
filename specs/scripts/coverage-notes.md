### Partial coverage: parts of an invariant that an end-to-end scenario cannot see

Every v1 invariant and AC has at least one scenario. These parts are not visible from outside the server. A Go
regression aid (design draft 9 §8) may cover them; it is optional and never a gate:

- **I-4**: "no network or file I/O inside a tx" and "a tx open > 250 ms panics in test builds" (`TestTx_LongTxPanicsInTest`).
- **I-5**: "every FK child column leads an index" (`TestSchema_EveryFKIndexed`). `foreign_keys=ON` and `secure_delete=ON` are seen only through their effects (cross-record refusals, the purge byte scan).
- **I-9**: the 1k-run property test is written as one end-to-end scenario; a full property run is cheaper as a Go aid.
- **I-48**: "a push subscription's human owns its device" and "an ask sits on its own asker's ask message" have no API path a client can abuse, so only the schema probe can hit them.
- **I-25**: "a machine-key copy moved to another row fails to decrypt" needs the test to edit the data file (`@invariant`, test build only).
- **I-43**: the exact claim, merge, extend and ack SQL was also probed directly on SQLite 3.50.4 (design draft 9 end of §7; 44 of 44 probes).

### Later by design

- **I-35** (push action buttons, S-10b) and **AC-23** (delete my data, members in S-15; C-7) are covered only by `@later` scenarios. In v1 the owner's purge carries the same byte scan (`contracts/ops` · Purging a message scrubs every copy of its content).

### User-facing and contract scenarios

- `specs/features/` holds what Drew or an agent sees and does. The checker rejects routes, status codes, headers, data-file scans, database words, benchmarks and `@invariant` there.
- `specs/contracts/` holds status codes, headers, races, byte scans, DB probes and CI gates. Both kinds run end to end against the real binary.
- `quality-gates` has only a contracts file: AC-1, AC-9, AC-16 and AC-17 are CI gates, not product behaviour.
- `search` has only a user-facing file.

### Driver and owner-run notes

- `@needs-owner` scenarios are run by hand with Drew's phone or a live tailnet machine: approve a real machine (AC-8), message on the phone over Tailscale, DERP RTT in admin health, off-tailnet refusal, iPhone Home Screen push, first setup on a real phone.
- `@C-n` tags trace the 10 contradiction picks (design draft 9 §17, Q28–Q37); `@Mn` tags trace the DA must-fixes on draft 8, all applied in draft 9.
