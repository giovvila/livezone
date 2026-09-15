# Sponsor and crawl concurrency

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

The server selects one active winner per overlay type. EffectiveProgramOutput projects
the sponsor and crawl into separate `overlays.sponsor` and `overlays.textCrawl` fields.
Sponsor assets resolve through the managed image library. Missing images do not affect
the crawl or the accepted Program. Publisher writes cannot supply sponsor state.

Control, Public and OBS consume the same composite. Each overlay owns its node and
expiry timer. Updating the other overlay neither detaches its node nor changes its
deadline. Recovery uses the original schedule interval and elapsed crawl phase.
ENTRY (including session-specific scene IDs) and LOSS disable both; BREAK allows both.
Expired events are not restored. The merge does not issue Program or Preview commands.

Layer order, back to front: base video; channel graphics (1), lower third (2),
sponsor (3), crawl (4). Public uses separate full-frame containers for graphics,
sponsor and crawl. Control retains the sponsor and crawl nodes independently.
The technical loss slate remains above all overlays at layer 100.

## Automated verification

`node --test test/programmable-crawl.test.js`

The concurrency cases cover the requested matrix:

1. Sponsor only.
2. Crawl only.
3. Sponsor and crawl.
4. Channel logo, sponsor and crawl.
5. Sponsor starts during crawl; crawl node, phase and timer remain unchanged.
6. Crawl starts during sponsor; sponsor node and timer remain unchanged.
7. Sponsor ends while crawl continues.
8. Crawl ends while sponsor continues.
9. ENTRY suppresses both, using the production session-specific scene identity.
10. Recovery restores both with original deadlines; expired events stay absent.
11. LOSS suppresses both.
12. BREAK retains both.
13. Public and Control consume matching overlay state.
14. OBS and Control consume matching overlay state.
15. Program ingress remains unchanged and Preview rendering is untouched.

These are HTTP/server and DOM unit tests, not a live OBS or visual browser acceptance run.
