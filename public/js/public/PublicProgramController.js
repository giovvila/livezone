import SponsorView from '../studio/renderers/SponsorView.js';
import OutputRevisionGate from '../program-output/OutputRevisionGate.js';
import {TextCrawlView} from '../studio/renderers/TextCrawlElement.js';
import { AUTO_LIVE_LOSS_SLATE_ID, createAutoLiveLossSlate } from "../program-output/AutoLiveLossSlate.js";
import { expectedPlaybackTime } from "../program-output/ProgramOutputContract.js";
import trace, { programTraceFields } from "../core/RuntimeTrace.js";

const MAX_RETAINED_AGE_MS = 6 * 60 * 60 * 1000;
const OUTPUT_MODES = Object.freeze({
    public: Object.freeze({ initialAudioEnabled: false, showWaitingSurface: true }),
    obs: Object.freeze({ initialAudioEnabled: true, showWaitingSurface: false })
});

export default class PublicProgramController {
    constructor({ root, status, audioButton, transport, now = () => Date.now(),
        outputMode = "public" }) {
        const outputConfig = OUTPUT_MODES[outputMode];
        if (!outputConfig) throw new TypeError("Unknown Program output mode.");
        Object.assign(this, { root, status, audioButton, transport, now });
        this.outputMode = outputMode;
        this.outputConfig = outputConfig;
        this.revisionBySession = new Map();
        this.activePublisherSessionId = null;
        this.retiredPublisherSessions = new Set();
        this.generation = 0;
        this.audioEnabled = outputConfig.initialAudioEnabled;
        this.audioBlockedElement = null;
        this.current = null;
        this.pendingRender = null;
        this.latestSnapshot = null;
        this.recoveryTimer = null;
        this.handleSnapshot = this.handleSnapshot.bind(this);
        this.enableAudio = this.enableAudio.bind(this);
    }

    start() {
        this.transport.start();
        this.renderWaiting();
        this.unsubscribe = this.transport.subscribe(this.handleSnapshot);
        this.audioButton?.addEventListener("click", this.enableAudio);
    }

    destroy() {
        this.cancelLossRecovery();
        clearTimeout(this.recoveryTimer);
        this.latestSnapshot = null;
        this.generation += 1;
        this.pendingRender?.abort?.abort();
        this.pendingRender = null;
        clearTimeout(this.staleTimer);
        this.unsubscribe?.();
        this.crawlView?.destroy();
        this.sponsorView?.destroy();
        this.audioButton?.removeEventListener("click", this.enableAudio);
        this.transport.destroy();
        this.releaseCurrent();
    }

    handleSnapshot(snapshot, { livePublisher = false } = {}) {
        this.trace("snapshot-received", snapshot);
        if (!this.acceptSnapshotRevision(snapshot, { livePublisher })) {
            this.trace(this.outputMode==='obs'?'OBS_EFFECTIVE_REJECT':'PUBLIC_EFFECTIVE_REJECT',snapshot);
            this.trace("snapshot-rejected", snapshot); return;
        }
        this.trace("snapshot-accepted", snapshot);
        this.trace(this.outputMode==='obs'?'OBS_EFFECTIVE_ACCEPT':'PUBLIC_EFFECTIVE_ACCEPT',snapshot);
        if (snapshot.output?.serverTime) this.outputClockOffset = Date.parse(snapshot.output.serverTime) - this.now();
        this.latestSnapshot = snapshot;
        const recovering = this.lossRecovery;
        if (recovering && (this.activationKey(snapshot) !== recovering.key ||
            JSON.stringify(snapshot.source) !== recovering.source ||
            snapshot.graphics?.items.some(item => item.id === AUTO_LIVE_LOSS_SLATE_ID)))
            this.cancelLossRecovery();
        if (snapshot.graphics?.items.some(item => item.id === AUTO_LIVE_LOSS_SLATE_ID))
            this.renderGraphics(snapshot.graphics.items);
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
        if (snapshot.scene === null && snapshot.source === null) {
            this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
            this.renderWaiting();
            this.renderOverlays(snapshot.overlays);
            return;
        }
        if (!snapshot.scene || !snapshot.source) return;
        if (this.pendingRender &&
            this.activationKey(this.pendingRender.snapshot) === this.activationKey(snapshot) &&
            JSON.stringify(this.pendingRender.snapshot.source) === JSON.stringify(snapshot.source)) {
            this.pendingRender.snapshot = snapshot;
            this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
            return;
        }
        const previousSnapshot = this.current?.snapshot;
        const sameActivation = previousSnapshot &&
            this.activationKey(previousSnapshot) === this.activationKey(snapshot);
        if (sameActivation) {
            if (this.pendingRender) {
                ++this.generation;
                this.pendingRender.abort.abort();
                this.pendingRender = null;
            }
            const sourceChanged = JSON.stringify(previousSnapshot.source) !==
                JSON.stringify(snapshot.source);
            if (sourceChanged) {
                this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
                void this.renderSnapshot(snapshot);
                return;
            }
            const playbackChanged = JSON.stringify(previousSnapshot.playback) !==
                JSON.stringify(snapshot.playback);
            this.current.snapshot = snapshot;
            if (snapshot.source.kind === "hls" &&
                previousSnapshot.graphics.items.some(item => item.id === AUTO_LIVE_LOSS_SLATE_ID) &&
                !snapshot.graphics.items.some(item => item.id === AUTO_LIVE_LOSS_SLATE_ID))
                this.verifyLossRecovery(snapshot);
            this.renderGraphics(snapshot.graphics.items);
            this.renderOverlays(snapshot.overlays);
            this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
            if (playbackChanged) void this.reconcilePlayback(snapshot, this.current);
            return;
        }
        this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
        void this.renderSnapshot(snapshot);
    }

    acceptSnapshotRevision(snapshot, { livePublisher = false } = {}) {
        if (snapshot?.output) {
            this.outputRevisionGate ||= new OutputRevisionGate();
            return this.outputRevisionGate.accept(snapshot);
        }
        const sessionId = snapshot?.publisherSessionId;
        if (!sessionId || this.retiredPublisherSessions.has(sessionId)) return false;
        if (this.activePublisherSessionId &&
            this.activePublisherSessionId !== sessionId) {
            this.retiredPublisherSessions.add(this.activePublisherSessionId);
            this.activePublisherSessionId = sessionId;
        }
        else if (!this.activePublisherSessionId) {
            this.activePublisherSessionId = sessionId;
        }
        const previous = this.revisionBySession.get(snapshot.publisherSessionId) || 0;
        if (snapshot.revision <= previous) {
            if (livePublisher && snapshot.revision === previous) {
                this.scheduleStaleState(snapshot, this.now());
            }
            return false;
        }
        this.revisionBySession.set(snapshot.publisherSessionId, snapshot.revision);
        if (!livePublisher &&
            this.now() - Date.parse(snapshot.publishedAt) > MAX_RETAINED_AGE_MS) {
            this.renderWaiting("PROGRAM STATE STALE");
            return false;
        }
        return true;
    }

    async renderSnapshot(initialSnapshot) {
        const generation = ++this.generation;
        this.pendingRender?.abort?.abort();
        const pending = { generation, snapshot: initialSnapshot, abort: new AbortController() };
        this.pendingRender = pending;
        this.trace("surface-created", initialSnapshot);
        const layer = document.createElement("div");
        layer.className = "public-program__base-layer";
        pending.abort.signal.addEventListener("abort", () => layer.remove(), { once: true });
        if (this.outputMode === "public" || initialSnapshot.source.kind === "hls") {
            // Connected preparation allows browsers to load/play muted media reliably.
            layer.style.opacity = ".001";
            this.baseRoot.appendChild(layer);
        }
        let cleanup = () => {};
        try {
            cleanup = await this.createSource(layer, initialSnapshot, { signal: pending.abort.signal });
        }
        catch {
            this.trace("surface-failed", pending.snapshot);
            if (generation === this.generation) {
                this.renderWaiting("PROGRAM UNAVAILABLE");
                this.setStatus("PROGRAM UNAVAILABLE", "error");
                this.scheduleRecovery(pending.snapshot);
            }
            if (this.pendingRender === pending) this.pendingRender = null;
            cleanup();
            layer.remove();
            return;
        }
        if (generation !== this.generation) { cleanup(); layer.remove(); return; }
        this.trace("surface-ready", pending.snapshot);
        const snapshot = pending.snapshot;
        this.pendingRender = null;
        const outgoing = this.current;
        this.current = { snapshot, layer, cleanup };
        this.baseRoot.appendChild(layer);
        if (this.outputMode === "public" || snapshot.source.kind === "hls") layer.style.opacity = "";
        this.trace("surface-promoted", snapshot);
        if (this.outputMode === "public" && snapshot.source.kind === "hls" && this.audioEnabled) {
            // Permission is attempted only after visual promotion. A rejected or
            // unresolved audible play cannot hold the previous Program on screen.
            const video = this.getCurrentMedia();
            video.muted = false; video.defaultMuted = false;
            video.removeAttribute?.("muted");
            void video.play().catch(error => {
                if (this.getCurrentMedia() === video) this.handleAutoplayRejection(error, video);
            });
        }
        // Preparation may have coalesced a newer playback revision or taken time.
        // Apply the authoritative cue at promotion, not the original prepared cue.
        if (snapshot !== initialSnapshot) void this.reconcilePlayback(snapshot, this.current);
        else this.syncPlaybackPosition(this.getCurrentMedia());
        if (snapshot.transition.type === "dissolve" && outgoing?.layer?.isConnected) {
            layer.animate([{ opacity: 0 }, { opacity: 1 }],
                { duration: 400, easing: "linear" });
            const fade = outgoing.layer.animate([{ opacity: 1 }, { opacity: 0 }],
                { duration: 400, easing: "linear" });
            fade.finished.then(() => this.release(outgoing), () => this.release(outgoing));
        }
        else {
            this.release(outgoing);
            this.baseRoot.replaceChildren(layer);
        }
        this.renderGraphics(snapshot.graphics.items);
        this.renderOverlays(snapshot.overlays);
        this.syncCurrentAudioButton();
        this.setStatus(
            snapshot.playback.state === "error" ? "PROGRAM UNAVAILABLE"
                : snapshot.playback.ended ? "PROGRAM ENDED" : "PROGRAM",
            snapshot.playback.state === "error" ? "error" : "online"
        );
    }

    async createSource(root, snapshot, { signal } = {}) {
        const { source } = snapshot;
        if (source.kind === "break") return this.createBreak(root, source);
        if (source.kind === "audio") return this.createAudio(root, snapshot, { signal });
        if (source.kind === "image") return this.createImage(root, source, { signal });
        if(source.kind==='media')this.trace('mp4-source-resolved',snapshot);
        const video = document.createElement("video");
        if(source.kind==='media')this.trace('mp4-element-created',snapshot);
        video.className = "public-program__media";
        video.autoplay = source.kind === "hls" ||
            (snapshot.playback.playing && !snapshot.playback.ended);
        video.muted = !this.audioEnabled || this.outputMode === "public" && source.kind === "hls";
        video.defaultMuted = video.muted;
        if (video.muted) video.setAttribute?.("muted", "");
        video.playsInline = true;
        video.preload = "auto";
        root.appendChild(video);
        let hls = null;
        let released = false;
        const preparationAbort = new AbortController();
        let lastSampleAt = -Infinity;
        const observedEvents = ["timeupdate", "waiting", "stalled", "pause", "seeked", "error"];
        if(source.kind==='media')observedEvents.push('loadstart','loadedmetadata','durationchange','loadeddata','canplay','seeking');
        const observe = event => {
            if (released || event.type === "timeupdate" && this.now() - lastSampleAt < 1000) return;
            if (event.type === "timeupdate") lastSampleAt = this.now();
            const current = this.getCurrentMedia() === video ? this.current.snapshot : snapshot;
            this.trace(`player-${event.type}`, current, { currentTime: video.currentTime,
                expectedTime: expectedPlaybackTime(current, this.now()), readyState: video.readyState,
                networkState: video.networkState, mediaErrorCode: video.error?.code ?? 0,
                paused: video.paused, muted: video.muted, ended: video.ended });
            if(source.kind==='media'&&trace.enabled){
                for(const property of ['buffered','seekable']){
                    try{const ranges=video[property];for(let index=0;index<Math.min(ranges.length,4);index++)
                        this.trace('mp4-'+property,current,{phase:event.type,rangeIndex:index,rangeStart:ranges.start(index),rangeEnd:ranges.end(index)});
                    }catch{/* Diagnostic ranges must never affect playback. */}
                }
            }
        };
        const handlePlaying = () => { if (!released) {
            this.trace("player-playing", snapshot, { muted: video.muted, currentTime: video.currentTime });
            this.syncPlaybackPosition(video);
        } };
        const handleEnded = () => {
            if (this.audioBlockedElement === video) this.audioBlockedElement = null;
            if (this.getCurrentMedia() === video) this.hideAudioButton();
        };
        const cleanup = () => {
            if (released) return;
            released = true;
            preparationAbort.abort();
            signal?.removeEventListener("abort", cleanup);
            video.removeEventListener("ended", handleEnded);
            video.removeEventListener("playing", handlePlaying);
            observedEvents.forEach(event => video.removeEventListener(event, observe));
            hls?.destroy();
            if (this.audioBlockedElement === video) this.audioBlockedElement = null;
            video.pause(); video.removeAttribute("src"); video.load();
        };
        signal?.addEventListener("abort", cleanup, { once: true });
        video.addEventListener("ended", handleEnded);
        video.addEventListener("playing", handlePlaying);
        observedEvents.forEach(event => video.addEventListener(event, observe));
        const requestPlayback = () => {
            if (released) return;
            this.trace("play-request", snapshot, { muted: video.muted, readyState: video.readyState });
            void video.play().catch(error => {
                if (!released) this.handleAutoplayRejection(error, video);
            });
        };
        let rejectPreparation;
        const fatalPreparation = new Promise((_, reject) => { rejectPreparation = reject; });
        try {
            if (signal?.aborted) throw new Error("Source superseded");
            if (source.kind === "hls") this.trace("hls-prepare-start", snapshot);
            if (source.kind === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
                if (!globalThis.Hls?.isSupported?.()) throw new Error("HLS unsupported");
                hls = new globalThis.Hls({ enableWorker: true, lowLatencyMode: true,
                    backBufferLength: 90 });
                let playlistRequests = 0;
                if (globalThis.Hls.Events.LEVEL_LOADING) hls.on(globalThis.Hls.Events.LEVEL_LOADING, () => {
                    if (!released) this.trace("hls-playlist-request", snapshot, { requestCount: ++playlistRequests });
                });
                if (globalThis.Hls.Events.LEVEL_LOADED) hls.on(globalThis.Hls.Events.LEVEL_LOADED, (_event, data) => {
                    if (!released) this.trace("hls-playlist-loaded", snapshot, {
                        playlistSequence: data?.details?.endSN, fragmentCount: data?.details?.fragments?.length });
                });
                hls.on(globalThis.Hls.Events.MANIFEST_PARSED, () => {
                    if (released) return;
                    this.trace("hls-manifest", snapshot);
                    requestPlayback();
                });
                hls.on(globalThis.Hls.Events.ERROR, (_event, data) => {
                    if (!released) this.trace(data?.fatal ? "hls-fatal" : "hls-warning", snapshot);
                    if (!released && data?.fatal) {
                        rejectPreparation(new Error("HLS preparation failed"));
                        if (this.getCurrentMedia() === video && !this.pendingRender &&
                            this.activationKey(this.current.snapshot) === this.activationKey(this.latestSnapshot))
                            this.scheduleRecovery(this.latestSnapshot);
                    }
                });
                hls.loadSource(source.url);
                hls.attachMedia(video);
            }
            else { video.src = source.url;
                if(source.kind==='media')this.trace('mp4-src-assigned',snapshot,{state:video.preload});
                video.load(); }
            const ready = this.waitForReady(video, ["loadeddata", "canplay"], 12000, preparationAbort.signal);
            // Some native HLS implementations do not decode enough data to emit
            // canplay until explicitly played, even with autoplay on the element.
            if (source.kind === "hls") requestPlayback();
            await Promise.race([ready, fatalPreparation]);
            if (source.kind === "hls") this.trace("hls-ready", snapshot, {
                readyState: video.readyState, muted: video.muted });
            if (source.kind === "media") {
                await this.seekRecordedMedia(video, snapshot, 12000, signal);
            }
            if (released) throw new Error("Source superseded");
            if (source.kind !== "hls" && snapshot.playback.playing) requestPlayback();
            if (["media", "hls"].includes(source.kind) && !this.audioEnabled &&
                snapshot.playback.playing && !snapshot.playback.ended) this.showAudioButton();
            return cleanup;
        } catch (error) { cleanup(); throw error; }
    }

    async createImage(root, source, { signal } = {}) {
        const image = document.createElement("img");
        image.className = "public-program__media";
        image.alt = "";
        root.appendChild(image);
        const cleanup = () => { image.removeAttribute("src"); };
        try {
            const ready = this.waitForReady(image, ["load"], 12000, signal);
            image.src = source.url;
            await ready;
            return cleanup;
        }
        catch (error) {
            cleanup();
            throw error;
        }
    }

    async createAudio(root, snapshot, { signal } = {}) {
        const audio = document.createElement("audio");
        const placeholder = document.createElement("div");
        const image = snapshot.source.stillUrl ? document.createElement("img") : null;
        const motion = snapshot.source.motionUrl ? document.createElement("video") : null;
        let imageReady = false;
        let imageFailed = false;
        let motionReady = false;
        let motionFailed = false;
        let released = false;
        placeholder.className = "public-program-audio-placeholder";
        placeholder.textContent = "AUDIO";
        if (image) {
            image.className = "public-program-audio-still";
            image.alt = "";
            image.hidden = true;
        }
        if (motion) {
            motion.className = "public-program-audio-motion";
            motion.muted = true;
            motion.defaultMuted = true;
            motion.loop = true;
            motion.autoplay = true;
            motion.playsInline = true;
            motion.controls = false;
            motion.preload = "auto";
            motion.hidden = true;
        }
        audio.hidden = true;
        audio.src = snapshot.source.audioUrl;
        audio.preload = "auto";
        audio.muted = !this.audioEnabled;
        audio.defaultMuted = audio.muted;
        const refreshArtwork = () => {
            if (released) return;
            const showMotion = Boolean(motion && motionReady && !motionFailed);
            const showStill = !showMotion && Boolean(image && imageReady && !imageFailed);
            if (motion) motion.hidden = !showMotion;
            if (image) image.hidden = !showStill;
            placeholder.hidden = showMotion || showStill;
        };
        const handleImageLoad = () => {
            imageReady = true; imageFailed = false; refreshArtwork();
        };
        const handleImageError = () => {
            imageReady = false; imageFailed = true; refreshArtwork();
        };
        const handleMotionError = () => {
            motionReady = false; motionFailed = true; refreshArtwork();
        };
        const handleMotionReady = async () => {
            if (released || !motion) return;
            try {
                await motion.play();
                if (released) return;
                motionReady = true; motionFailed = false; refreshArtwork();
            }
            catch { handleMotionError(); }
        };
        const handleAudioPlaying = () => { void handleMotionReady(); };
        const handleAudioEnded = () => {
            if (this.audioBlockedElement === audio) this.audioBlockedElement = null;
            if (this.getCurrentMedia() === audio) this.hideAudioButton();
            if (!motion) return;
            motion.pause();
            try { motion.currentTime = 0; }
            catch { /* An unavailable media timeline is safe to leave paused. */ }
        };
        image?.addEventListener("load", handleImageLoad);
        image?.addEventListener("error", handleImageError);
        motion?.addEventListener("loadeddata", handleMotionReady);
        motion?.addEventListener("error", handleMotionError);
        audio.addEventListener("playing", handleAudioPlaying);
        audio.addEventListener("ended", handleAudioEnded);
        root.append(audio, placeholder, ...(image ? [image] : []), ...(motion ? [motion] : []));
        if (image) {
            image.src = snapshot.source.stillUrl;
            if (image.complete && image.naturalWidth > 0) handleImageLoad();
        }
        if (motion) {
            motion.src = snapshot.source.motionUrl;
            motion.load();
        }
        refreshArtwork();
        const cleanup = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener("abort", cleanup);
            image?.removeEventListener("load", handleImageLoad);
            image?.removeEventListener("error", handleImageError);
            motion?.removeEventListener("loadeddata", handleMotionReady);
            motion?.removeEventListener("error", handleMotionError);
            audio.removeEventListener("playing", handleAudioPlaying);
            audio.removeEventListener("ended", handleAudioEnded);
            if (motion) {
                motion.pause(); motion.removeAttribute("src"); motion.load();
            }
            audio.pause(); audio.removeAttribute("src"); audio.load();
        };
        signal?.addEventListener("abort", cleanup, { once: true });
        try {
            const ready = this.waitForReady(audio, ["loadeddata", "canplay"], 12000, signal);
            audio.load();
            await ready;
            await this.seekRecordedMedia(audio, snapshot, 12000, signal);
        }
        catch (error) {
            cleanup();
            throw error;
        }
        if ((this.outputMode === "public" || this.audioEnabled) && snapshot.playback.playing) {
            void audio.play().catch(error => {
                if (!released) this.handleAutoplayRejection(error, audio);
            });
        }
        else if (snapshot.playback.playing) this.showAudioButton();
        return cleanup;
    }

    createBreak(root, source) {
        const slate = document.createElement("div");
        const image = document.createElement("img");
        const title = document.createElement("strong");
        const message = document.createElement("span");
        slate.className = "public-program__slate";
        image.src = source.logoUrl; image.alt = "";
        title.textContent = source.title; message.textContent = source.message;
        slate.append(image, title, message); root.appendChild(slate);
        return () => {};
    }

    waitForReady(element, readyEvents, timeoutMs = 12000, signal = null) {
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                readyEvents.forEach((event) => element.removeEventListener(event, ready));
                element.removeEventListener("error", fail);
                signal?.removeEventListener("abort", fail);
                clearTimeout(timer);
            };
            const ready = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error("Public source unavailable")); };
            readyEvents.forEach((event) => element.addEventListener(event, ready, { once: true }));
            element.addEventListener("error", fail, { once: true });
            timer = setTimeout(fail, timeoutMs);
            signal?.addEventListener("abort", fail, { once: true });
            if (signal?.aborted) fail();
            else if (element.readyState >= 2) ready();
        });
    }

    seekRecordedMedia(element, snapshot, timeoutMs = 12000, signal = null) {
        if (signal?.aborted) return Promise.reject(new Error("Source superseded"));
        const expected = expectedPlaybackTime(snapshot, this.now());
        const duration = Number.isFinite(element.duration) && element.duration >= 0
            ? element.duration : snapshot.playback.duration;
        const target = duration === null || !Number.isFinite(duration)
            ? Math.max(0, expected)
            : Math.min(Math.max(0, expected), Math.max(0, duration - 0.05));
        if(snapshot.source?.kind==='media')this.trace('mp4-seek-target',snapshot,{expectedTime:target,currentTime:element.currentTime,readyState:element.readyState,duration});
        if (Math.abs(element.currentTime - target) <= 0.05) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                element.removeEventListener("seeked", ready);
                element.removeEventListener("error", fail);
                signal?.removeEventListener("abort", fail);
                clearTimeout(timer);
            };
            const ready = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error("Public seek unavailable")); };
            element.addEventListener("seeked", ready, { once: true });
            element.addEventListener("error", fail, { once: true });
            signal?.addEventListener("abort", fail, { once: true });
            timer = setTimeout(fail, timeoutMs);
            if(snapshot.source?.kind==='media')this.trace('mp4-seek-request',snapshot,{expectedTime:target,readyState:element.readyState});
            element.currentTime = target;
            queueMicrotask(() => {
                if (!element.seeking && Math.abs(element.currentTime - target) <= 0.05) {
                    ready();
                }
            });
        });
    }

    async reconcilePlayback(snapshot, entry) {
        if (!entry || this.current !== entry ||
            !["media", "audio"].includes(snapshot.source.kind)) return;
        const media = entry.layer.querySelector(
            snapshot.source.kind === "audio" ? "audio" : "video"
        );
        if (!media) return;
        if (snapshot.source.kind === "audio" && snapshot.playback.ended) {
            this.resetAudioMotion(entry);
        }
        if (!snapshot.playback.playing || snapshot.playback.ended) media.pause();
        if (snapshot.playback.ended) {
            if (this.audioBlockedElement === media) this.audioBlockedElement = null;
            this.hideAudioButton();
        }
        try { await this.seekRecordedMedia(media, snapshot); }
        catch { return; }
        if (this.current !== entry || entry.snapshot !== snapshot) return;
        if (snapshot.playback.playing && !snapshot.playback.ended) {
            if (this.outputMode === "public" || snapshot.source.kind !== "audio" || this.audioEnabled) {
                try { await media.play(); }
                catch (error) {
                    if (this.current === entry && entry.snapshot === snapshot)
                        this.handleAutoplayRejection(error, media);
                }
            }
            else this.showAudioButton();
        }
        else media.pause();
        if (this.current !== entry || entry.snapshot !== snapshot) return;
        this.setStatus(snapshot.playback.ended ? "PROGRAM ENDED" : "PROGRAM", "online");
    }

    resetAudioMotion(entry) {
        const motion = entry?.layer?.querySelector(".public-program-audio-motion");
        if (!motion) return;
        motion.pause();
        try { motion.currentTime = 0; }
        catch { /* An unavailable media timeline is safe to leave paused. */ }
    }

    activationKey(snapshot) {
        return [snapshot.publisherSessionId, snapshot.committedAt,
            snapshot.scene?.id || "", snapshot.source?.id || ""].join("|");
    }

    renderGraphics(items) {
        this.lossSlateElement?.remove(); this.lossSlateElement = null;
        const loss = items.find(item => item.id === AUTO_LIVE_LOSS_SLATE_ID && item.kind === "image");
        if (loss && this.graphicsRoot) {
            this.lossSlateElement = createAutoLiveLossSlate(loss.url);
            this.graphicsRoot.appendChild(this.lossSlateElement);
        }
        items = items.filter(item => item.id !== AUTO_LIVE_LOSS_SLATE_ID);
        const layer = this.getGraphicsLayer("items");
        if (!layer) return;
        const elements = items.map((item) => {
            if (item.kind === "image") {
                const image = document.createElement("img");
                image.src = item.url; image.alt = "";
                image.className = `public-graphic public-graphic--image public-graphic--${item.position}`;
                return image;
            }
            const graphic = document.createElement("div");
            const title = document.createElement("strong");
            graphic.className = `public-graphic public-lower-third public-graphic--${item.position}`;
            title.textContent = item.title; graphic.appendChild(title);
            if (item.subtitle) { const subtitle = document.createElement("span");
                subtitle.textContent = item.subtitle; graphic.appendChild(subtitle); }
            return graphic;
        });
        layer.replaceChildren(...elements);
    }

    renderOverlays(overlays = {}) {
        try {
            const layer=(overlays.sponsor || this.sponsorView) && this.getGraphicsLayer('sponsor');
            if(layer){
                layer.style.zIndex=overlays.sponsor?.layout==='FULLSCREEN'?'5':'3';
                this.sponsorView ||= new SponsorView({now:()=>this.now()+(this.outputClockOffset||0)});
                const element=this.sponsorView.node(overlays.sponsor);
                if(!element || element.parentNode!==layer)layer.replaceChildren(...(element?[element]:[]));
            }
        } catch { this.trace('sponsor-render-failed',this.latestSnapshot); }
        try { this.renderCrawlOverlay(overlays); }
        catch {
            this.trace('crawl-render-failed',this.latestSnapshot);
            try { this.crawlView?.destroy(); } catch {}
            this.crawlView=null;
            try { this.getGraphicsLayer('overlays')?.replaceChildren(); } catch {}
        }
    }

    renderCrawlOverlay(overlays = {}) {
        const layer = this.getGraphicsLayer("overlays");
        if (!layer) return;
        if (this.graphicsRoot?.dataset) this.graphicsRoot.dataset.scheduledCrawlPosition = overlays?.textCrawl?.enabled && overlays.textCrawl.scheduled ? overlays.textCrawl.position : "";
        this.crawlView ||= new TextCrawlView({ prefix: "public", now: () => this.now() + (this.outputClockOffset || 0) });
        const element = this.crawlView.node(overlays?.textCrawl);
        if (element && element.parentNode === layer) return;
        layer.replaceChildren(...(element ? [element] : []));
    }

    getGraphicsLayer(kind) {
        const root = this.graphicsRoot;
        if (!root) return null;
        const selector = `[data-public-${kind}]`;
        let layer = root.querySelector(selector);
        if (!layer) {
            layer = document.createElement("div");
            layer.className = `public-program__${kind}`;
            layer.setAttribute(`data-public-${kind}`, "");
            root.appendChild(layer);
        }
        return layer;
    }

    enableAudio() {
        this.audioEnabled = true;
        const media = this.current?.layer.querySelector(
            this.current?.snapshot.source.kind === "audio" ? "audio" : "video"
        );
        if (!media) {
            if (this.audioButton) this.audioButton.hidden = true;
            return;
        }
        media.muted = false;
        media.defaultMuted = false;
        media.removeAttribute?.("muted");
        this.syncPlaybackPosition(media);
        const playback = this.current?.snapshot.playback;
        if (playback?.playing && !playback.ended) {
            void media.play().then(() => {
                if (this.getCurrentMedia() !== media) return;
                if (this.audioBlockedElement === media) this.audioBlockedElement = null;
                this.hideAudioButton();
            }).catch((error) => {
                if (this.getCurrentMedia() !== media) return;
                if (!this.handleAutoplayRejection(error, media) &&
                    this.getCurrentMedia() === media) this.hideAudioButton();
            });
        }
        else this.hideAudioButton();
    }

    showAudioButton() { if (this.audioButton) this.audioButton.hidden = false; }
    hideAudioButton() { if (this.audioButton) this.audioButton.hidden = true; }

    syncPlaybackPosition(media) {
        const entry = this.current;
        if (!media || this.getCurrentMedia() !== media ||
            !["media", "audio"].includes(entry?.snapshot.source.kind)) return;
        const expected = expectedPlaybackTime(entry.snapshot, this.now());
        const duration = Number.isFinite(media.duration) ? media.duration : entry.snapshot.playback.duration;
        const target = duration === null ? expected : Math.min(expected, Math.max(0, duration - 0.05));
        // Event-driven catch-up: tolerate sub-frame/startup variation rather than
        // creating a seek -> playing -> seek feedback loop.
        if (Math.abs(media.currentTime - target) > 0.5)
            void this.seekRecordedMedia(media, entry.snapshot).catch(() => {});
        this.trace("playback-sync", entry.snapshot, { currentTime: media.currentTime,
            expectedTime: expectedPlaybackTime(entry.snapshot, this.now()), paused: media.paused });
    }

    trace(event, snapshot, fields = {}) {
        trace.record(this.outputMode, event, { ...programTraceFields(snapshot),
            generation: this.generation, ...fields });
    }

    handleAutoplayRejection(error, media = null) {
        if (error?.name !== "NotAllowedError") return false;
        if (media) this.audioBlockedElement = media;
        this.showAudioButton();
        if (this.outputMode === "public" && media && !media.muted) {
            media.muted = true;
            media.defaultMuted = true;
            this.trace("autoplay-muted-retry", this.latestSnapshot);
            void media.play().catch(() => {});
            return true;
        }
        this.setStatus("TAP TO START PROGRAM", "error");
        return true;
    }
    getCurrentMedia() {
        const kind = this.current?.snapshot?.source?.kind;
        if (!this.current || !["audio", "media", "hls"].includes(kind)) return null;
        return this.current.layer.querySelector(kind === "audio" ? "audio" : "video");
    }
    syncCurrentAudioButton() {
        const media = this.getCurrentMedia();
        const playback = this.current?.snapshot?.playback;
        if (!media || !playback?.playing || playback.ended) return this.hideAudioButton();
        if (!this.audioEnabled || this.audioBlockedElement === media) this.showAudioButton();
        else this.hideAudioButton();
    }
    renderWaiting(message = "WAITING FOR PROGRAM") {
        clearTimeout(this.recoveryTimer);
        this.generation += 1;
        this.pendingRender?.abort?.abort();
        this.pendingRender = null;
        this.releaseCurrent();
        this.audioBlockedElement = null;
        this.hideAudioButton();
        if (message !== "PROGRAM STATE STALE" &&
            this.latestSnapshot?.graphics?.items.some(item => item.id === AUTO_LIVE_LOSS_SLATE_ID)) {
            this.baseRoot.replaceChildren();
            this.renderGraphics(this.latestSnapshot.graphics.items);
            return;
        }
        if (!this.outputConfig.showWaitingSurface) {
            this.baseRoot.replaceChildren();
            this.graphicsRoot.replaceChildren();
            return;
        }
        const waiting = document.createElement("div");
        waiting.className = "public-program__waiting";
        waiting.textContent = message;
        this.baseRoot.replaceChildren(waiting);
        this.graphicsRoot.replaceChildren();
        this.setStatus("OFFLINE", "offline");
    }
    scheduleStaleState(snapshot, freshnessTime = null) {
        clearTimeout(this.staleTimer);
        const remaining = MAX_RETAINED_AGE_MS -
            (this.now() - (freshnessTime ?? Date.parse(snapshot.publishedAt)));
        if (remaining <= 0) return;
        const sessionId = snapshot.publisherSessionId;
        const revision = snapshot.revision;
        this.staleTimer = setTimeout(() => {
            const current = this.current?.snapshot;
            if (current?.publisherSessionId === sessionId &&
                current.revision === revision) {
                this.renderWaiting("PROGRAM STATE STALE");
                this.renderOverlays(this.latestSnapshot?.overlays);
            }
        }, remaining);
    }
    setStatus(text, variant) {
        if (!this.status) return;
        this.status.textContent = text;
        this.status.dataset.state = variant;
    }
    cancelLossRecovery() {
        const recovery = this.lossRecovery;
        this.lossRecovery = null;
        if (!recovery) return;
        clearTimeout(recovery.timer);
        recovery.video?.removeEventListener("timeupdate", recovery.progress);
    }

    verifyLossRecovery(snapshot) {
        this.cancelLossRecovery();
        const video = this.getCurrentMedia();
        if (!video) return;
        const recovery = { key: this.activationKey(snapshot),
            source: JSON.stringify(snapshot.source), video, time: video.currentTime };
        this.lossRecovery = recovery;
        const valid = () => this.lossRecovery === recovery &&
            this.activationKey(this.latestSnapshot) === recovery.key &&
            this.getCurrentMedia() === video;
        recovery.progress = () => {
            if (!valid() || video.paused || video.ended || video.readyState < 2 ||
                video.currentTime <= recovery.time + .01) return;
            this.trace("loss-recovery-reused", this.latestSnapshot);
            this.cancelLossRecovery();
        };
        video.addEventListener("timeupdate", recovery.progress);
        this.trace("loss-recovery-check", snapshot);
        recovery.timer = setTimeout(() => {
            if (this.lossRecovery !== recovery) return;
            if (!valid()) { this.cancelLossRecovery(); return; }
            recovery.progress();
            if (this.lossRecovery !== recovery) return;
            const latest = this.latestSnapshot;
            this.cancelLossRecovery();
            if (this.pendingRender) return;
            this.trace("loss-recovery-rebuild", latest);
            void this.renderSnapshot(latest);
        }, 5000);
    }

    scheduleRecovery(snapshot) {
        if (this.lossRecovery) return;
        if (this.outputMode !== "public" && snapshot?.source?.kind !== "hls" ||
            this.latestSnapshot !== snapshot || this.pendingRender) return;
        clearTimeout(this.recoveryTimer);
        this.trace("surface-retry-scheduled", snapshot);
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            if (this.latestSnapshot === snapshot) void this.renderSnapshot(snapshot);
        }, 1000);
    }
    releaseCurrent() { this.release(this.current); this.current = null; }
    release(entry) { if (!entry || entry.released) return; entry.released = true;
        entry.cleanup(); entry.layer.remove(); this.trace("surface-destroyed", entry.snapshot); }

    get baseRoot() { return this.root?.querySelector("[data-public-base]") || null; }
    get graphicsRoot() { return this.root?.querySelector("[data-public-graphics]") || null; }
}
