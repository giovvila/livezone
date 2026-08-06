# Release Fix 001 — Test checklist

1. Replace the files preserving their paths.
2. Hard-refresh the browser (Ctrl+F5).
3. Open DevTools Console and verify there are no JavaScript errors.
4. Verify video playback still starts normally.
5. Open Engine Inspector.
6. Verify Resolution changes from `0×0` to the actual video dimensions after metadata/video is available.
7. Verify Buffer is no longer the hard-coded `2.80 s` and is read from the live video element.
8. Leave the stream playing for at least 20 seconds and verify Buffer updates over time.
9. Pause/resume if controls permit it and verify Player changes between PAUSED/PLAYING.
10. Collapse/reopen Inspector and verify the preference persists after refresh.
