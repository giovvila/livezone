import { expectedPlaybackTime } from "../program-output/ProgramOutputContract.js";

const MAX_RETAINED_AGE_MS = 6 * 60 * 60 * 1000;

export default class PublicProgramController {
    constructor({ root, status, audioButton, transport, now = () => Date.now() }) {
        Object.assign(this, { root, status, audioButton, transport, now });
        this.revisionBySession = new Map();
        this.activePublisherSessionId = null;
        this.retiredPublisherSessions = new Set();
        this.generation = 0;
        this.audioEnabled = false;
        this.current = null;
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
        clearTimeout(this.staleTimer);
        this.unsubscribe?.();
        this.audioButton?.removeEventListener("click", this.enableAudio);
        this.transport.destroy();
        this.releaseCurrent();
    }

    handleSnapshot(snapshot, { livePublisher = false } = {}) {
        if (!this.acceptSnapshotRevision(snapshot, { livePublisher })) return;
        if (snapshot.scene === null && snapshot.source === null) {
            this.scheduleStaleState(snapshot, livePublisher ? this.now() : null);
            this.renderWaiting();
            return;
        }
        if (!snapshot.scene || !snapshot.source) return;
        const previousSnapshot = this.current?.snapshot;
        const sameActivation = previousSnapshot &&
            this.activationKey(previousSnapshot) === this.activationKey(snapshot);
        if (sameActivation) {
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

    async renderSnapshot(snapshot) {
        const generation = ++this.generation;
        const layer = document.createElement("div");
        layer.className = "public-program__base-layer";
        let cleanup = () => {};
        try {
            cleanup = await this.createSource(layer, snapshot);
        }
        catch {
            if (generation === this.generation) this.setStatus("PROGRAM UNAVAILABLE", "error");
            cleanup();
            return;
        }
        if (generation !== this.generation) { cleanup(); return; }
        const outgoing = this.current;
        this.current = { snapshot, layer, cleanup };
        this.baseRoot.appendChild(layer);
        if (snapshot.transition.type === "dissolve" && outgoing?.layer?.isConnected) {
            layer.animate([{ opacity: 0 }, { opacity: 1 }],
                { duration: 400, easing: "linear" });
            const fade = outgoing.layer.animate([{ opacity: 1 }, { opacity: 0 }],
                { duration: 400, easing: "linear" });
            fade.finished.finally(() => this.release(outgoing));
        }
        else {
            this.release(outgoing);
            this.baseRoot.replaceChildren(layer);
        }
        this.renderGraphics(snapshot.graphics.items);
        this.renderOverlays(snapshot.overlays);
        this.setStatus(
            snapshot.playback.state === "error" ? "PROGRAM UNAVAILABLE"
                : snapshot.playback.ended ? "PROGRAM ENDED" : "PROGRAM",
            snapshot.playback.state === "error" ? "error" : "online"
        );
    }

    async createSource(root, snapshot) {
        const { source } = snapshot;
        if (source.kind === "break") return this.createBreak(root, source);
        if (source.kind === "audio") return this.createAudio(root, snapshot);
        const video = document.createElement("video");
        video.className = "public-program__media";
        video.autoplay = source.kind === "hls" ||
            (snapshot.playback.playing && !snapshot.playback.ended);
        video.muted = !this.audioEnabled;
        video.defaultMuted = video.muted;
        video.playsInline = true;
        root.appendChild(video);
        let hls = null;
        if (source.kind === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
            if (!globalThis.Hls?.isSupported?.()) throw new Error("HLS unsupported");
            hls = new globalThis.Hls({ enableWorker: true, lowLatencyMode: true,
                backBufferLength: 90 });
            hls.loadSource(source.url);
            hls.attachMedia(video);
            hls.on(globalThis.Hls.Events.MANIFEST_PARSED, () => {
                void video.play().catch((error) =>
                    this.handleAutoplayRejection(error));
            });
        }
        else video.src = source.url;
        try { await this.waitForReady(video, ["loadeddata", "canplay"]); }
        catch (error) {
            hls?.destroy();
            video.removeAttribute("src");
            video.load();
            throw error;
        }
        if (source.kind === "media") {
            await this.seekRecordedMedia(video, snapshot);
        }
        if (source.kind === "hls" || snapshot.playback.playing) {
            try { await video.play(); }
            catch (error) {
                this.handleAutoplayRejection(error);
            }
        }
        if (source.kind === "hls" && !this.audioEnabled) this.showAudioButton();
        return () => { hls?.destroy(); video.pause(); video.removeAttribute("src"); video.load(); };
    }

    async createAudio(root, snapshot) {
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
        try {
            await this.waitForReady(audio, ["loadeddata", "canplay"]);
        }
        catch (error) {
            cleanup();
            throw error;
        }
        await this.seekRecordedMedia(audio, snapshot);
        if (this.audioEnabled && snapshot.playback.playing) {
            try { await audio.play(); } catch { this.showAudioButton(); }
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

    waitForReady(element, readyEvents, timeoutMs = 12000) {
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                readyEvents.forEach((event) => element.removeEventListener(event, ready));
                element.removeEventListener("error", fail);
                clearTimeout(timer);
            };
            const ready = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error("Public source unavailable")); };
            readyEvents.forEach((event) => element.addEventListener(event, ready, { once: true }));
            element.addEventListener("error", fail, { once: true });
            timer = setTimeout(fail, timeoutMs);
        });
    }

    seekRecordedMedia(element, snapshot, timeoutMs = 12000) {
        const expected = expectedPlaybackTime(snapshot, this.now());
        const duration = Number.isFinite(element.duration) && element.duration >= 0
            ? element.duration : snapshot.playback.duration;
        const target = duration === null || !Number.isFinite(duration)
            ? Math.max(0, expected)
            : Math.min(Math.max(0, expected), Math.max(0, duration - 0.05));
        if (Math.abs(element.currentTime - target) <= 0.05) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                element.removeEventListener("seeked", ready);
                element.removeEventListener("error", fail);
                clearTimeout(timer);
            };
            const ready = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error("Public seek unavailable")); };
            element.addEventListener("seeked", ready, { once: true });
            element.addEventListener("error", fail, { once: true });
            timer = setTimeout(fail, timeoutMs);
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
        try { await this.seekRecordedMedia(media, snapshot); }
        catch { return; }
        if (this.current !== entry || entry.snapshot !== snapshot) return;
        if (snapshot.playback.playing && !snapshot.playback.ended) {
            if (snapshot.source.kind !== "audio" || this.audioEnabled) {
                try { await media.play(); }
                catch { this.showAudioButton(); }
            }
            else this.showAudioButton();
        }
        else media.pause();
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
        const layer = this.getGraphicsLayer("overlays");
        if (!layer) return;
        const item = overlays?.textCrawl;
        if (!item?.enabled || !item.text) {
            layer.replaceChildren();
            return;
        }
        const overlay = document.createElement("div");
        const text = document.createElement("span");
        overlay.className = ["public-text-crawl", `public-text-crawl--${item.mode}`,
            `public-text-crawl--${item.direction}`,
            `public-text-crawl--${item.speed}`,
            `public-text-crawl--${item.position}`,
            item.background ? "public-text-crawl--background" : ""
        ].filter(Boolean).join(" ");
        text.className = "public-text-crawl__text";
        text.textContent = item.text;
        overlay.appendChild(text);
        layer.replaceChildren(overlay);
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
        const playback = this.current?.snapshot.playback;
        if (playback?.playing && !playback.ended) {
            void media.play().then(() => {
                if (this.audioButton) this.audioButton.hidden = true;
            }).catch((error) => this.handleAutoplayRejection(error));
        }
        else if (this.audioButton) this.audioButton.hidden = true;
    }

    showAudioButton() { if (this.audioButton) this.audioButton.hidden = false; }

    handleAutoplayRejection(error) {
        if (error?.name !== "NotAllowedError") return false;
        this.showAudioButton();
        this.setStatus("TAP TO START PROGRAM", "error");
        return true;
    }
    renderWaiting(message = "WAITING FOR PROGRAM") {
        this.releaseCurrent();
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
                current.revision === revision) this.renderWaiting("PROGRAM STATE STALE");
        }, remaining);
    }
    setStatus(text, variant) {
        if (!this.status) return;
        this.status.textContent = text;
        this.status.dataset.state = variant;
    }
    releaseCurrent() { this.release(this.current); this.current = null; }
    release(entry) { if (!entry) return; entry.cleanup(); entry.layer.remove(); }

    get baseRoot() { return this.root?.querySelector("[data-public-base]") || null; }
    get graphicsRoot() { return this.root?.querySelector("[data-public-graphics]") || null; }
}
