# LIVEZONE local OBS Program Output

Use the OBS Browser Source URL:

`http://127.0.0.1:8080/output/obs/`

Recommended initial OBS settings:

- Width: `1920`
- Height: `1080`
- FPS: `30`
- Control audio via OBS: enabled
- Shutdown source when not visible: disabled
- Refresh browser when scene becomes active: disabled
- Custom CSS: none

Validate BREAK, IMAGE, VIDEO with audio, AUDIO, AUDIO with still artwork,
AUDIO with motion artwork, LIVE/LL-HLS, graphics, TEXT/CRAWL, CUT and DISSOLVE.

LIVEZONE requests audible autoplay immediately in OBS mode. Actual playback
still depends on the OBS/CEF media policy and on enabling **Control audio via
OBS**. No visible click or gesture fallback is added to the broadcast surface.

LIVE/HLS retains the Public Viewer native-HLS/HLS.js recovery behavior. A
terminal playback failure that those players cannot recover requires a newer
Program snapshot or an OBS Browser Source refresh; LOCAL-3B does not add a
second HLS retry owner.

The OBS page is an anonymous Program Output subscriber and contains no
publisher token or operator credentials. Anonymous access is acceptable for
this local build only while the LIVEZONE HTTP application is bound to
`127.0.0.1`. Before any VPS or public deployment, `/output/obs/` requires a
dedicated read capability or an equivalent reverse-proxy access restriction.
