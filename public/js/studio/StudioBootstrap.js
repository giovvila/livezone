export default class StudioBootstrap {

    constructor({
        studioStateManager,
        configUrl = new URL("../../config/studio.json", import.meta.url)
    } = {}) {
        if (!studioStateManager ||
            typeof studioStateManager.registerScene !== "function") {
            throw new TypeError(
                "StudioBootstrap requires a StudioStateManager dependency."
            );
        }

        this.studioStateManager = studioStateManager;
        this.configUrl = configUrl;
        this.definitions = new Map();
        this.initializationPromise = null;
        this.report = null;
    }

    initialize() {
        if (!this.initializationPromise) {
            this.initializationPromise = this.initializeInternal();
        }

        return this.initializationPromise;
    }

    async initializeInternal() {
        let response;
        let document;

        try {
            response = await fetch(this.configUrl);

            if (!response.ok) {
                return this.finish("unavailable", 0, 0, [
                    this.createIssue("fetch-failed")
                ]);
            }

            document = await response.json();
        }
        catch {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("fetch-or-json-failed")
            ]);
        }

        if (!document || typeof document !== "object" ||
            Array.isArray(document)) {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("invalid-root")
            ]);
        }

        if (document.version !== 1) {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("unsupported-version")
            ]);
        }

        if (!("scenes" in document)) {
            return this.finish("empty", 0, 0, [
                this.createIssue("missing-scenes")
            ]);
        }

        if (!Array.isArray(document.scenes)) {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("invalid-scenes")
            ]);
        }

        if (document.scenes.length === 0) {
            return this.finish("empty", 0, 0, []);
        }

        const issues = [];
        const acceptedIds = new Set();
        const definitionBaseUrl = response.url || String(this.configUrl);
        let registeredCount = 0;

        document.scenes.forEach((candidate, index) => {
            const result = this.createDefinition(candidate, definitionBaseUrl);

            if (!result.definition) {
                issues.push(this.createIssue(result.reason, index, result.id));
                return;
            }

            const definition = result.definition;

            if (acceptedIds.has(definition.id) ||
                this.studioStateManager.getScene?.(definition.id)) {
                issues.push(this.createIssue("duplicate-id", index, definition.id));
                return;
            }

            const registered = this.studioStateManager.registerScene({
                id: definition.id,
                name: definition.name,
                type: definition.type
            });

            if (!registered) {
                issues.push(this.createIssue(
                    "registration-rejected",
                    index,
                    definition.id
                ));
                return;
            }

            acceptedIds.add(definition.id);
            this.definitions.set(definition.id, definition);
            registeredCount += 1;
        });

        const skippedCount = document.scenes.length - registeredCount;
        const status = registeredCount === 0
            ? "degraded"
            : skippedCount > 0
                ? "degraded"
                : "ready";

        return this.finish(status, registeredCount, skippedCount, issues);
    }

    getDefinition(sceneId) {
        const id = this.normalizeString(sceneId);
        return id ? this.definitions.get(id) || null : null;
    }

    getDefinitions() {
        return Object.freeze(Array.from(this.definitions.values()));
    }

    getReport() {
        return this.report;
    }

    createDefinition(candidate, baseUrl) {
        if (!candidate || typeof candidate !== "object" ||
            Array.isArray(candidate)) {
            return { definition: null, reason: "invalid-scene", id: null };
        }

        const id = this.normalizeString(candidate.id);
        const name = this.normalizeString(candidate.name);
        const type = this.normalizeString(candidate.type);

        if (!id || !name || !type) {
            return { definition: null, reason: "invalid-metadata", id };
        }

        const renderer = this.createRenderer(candidate.renderer, baseUrl);

        if (!renderer) {
            return { definition: null, reason: "invalid-renderer", id };
        }

        return {
            definition: Object.freeze({ id, name, type, renderer }),
            reason: null,
            id
        };
    }

    createRenderer(renderer, baseUrl) {
        if (!renderer || typeof renderer !== "object" ||
            Array.isArray(renderer)) {
            return null;
        }

        if (renderer.kind === "hls") {
            const configRef = this.normalizeString(renderer.source?.configRef);

            return configRef
                ? Object.freeze({
                    kind: "hls",
                    source: Object.freeze({ configRef })
                })
                : null;
        }

        if (renderer.kind === "slate") {
            const title = this.normalizeString(renderer.title);
            const message = this.normalizeString(renderer.message);
            const logo = this.normalizeString(renderer.logo);

            if (!title || !message || !logo) {
                return null;
            }

            let resolvedLogo;

            try {
                resolvedLogo = new URL(logo, baseUrl).href;
            }
            catch {
                return null;
            }

            return Object.freeze({
                kind: "slate",
                title,
                message,
                logo: resolvedLogo
            });
        }

        return null;
    }

    finish(status, registeredCount, skippedCount, issues) {
        this.report = Object.freeze({
            status,
            registeredCount,
            skippedCount,
            issues: Object.freeze(issues.map((issue) => Object.freeze(issue)))
        });

        return this.report;
    }

    createIssue(reason, index = null, sceneId = null) {
        return { reason, index, sceneId };
    }

    normalizeString(value) {
        if (typeof value !== "string") {
            return null;
        }

        const normalized = value.trim();
        return normalized || null;
    }
}
