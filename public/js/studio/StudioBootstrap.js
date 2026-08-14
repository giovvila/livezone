export default class StudioBootstrap {

    constructor({
        studioStateManager,
        studioSourceManager,
        studioGraphicsManager,
        configUrl = new URL("../../config/studio.json", import.meta.url)
    } = {}) {
        if (!studioStateManager ||
            typeof studioStateManager.registerScene !== "function") {
            throw new TypeError(
                "StudioBootstrap requires a StudioStateManager dependency."
            );
        }

        if (!studioSourceManager ||
            typeof studioSourceManager.registerSource !== "function") {
            throw new TypeError(
                "StudioBootstrap requires a StudioSourceManager dependency."
            );
        }

        if (!studioGraphicsManager ||
            typeof studioGraphicsManager.registerGraphic !== "function") {
            throw new TypeError(
                "StudioBootstrap requires a StudioGraphicsManager dependency."
            );
        }

        this.studioStateManager = studioStateManager;
        this.studioSourceManager = studioSourceManager;
        this.studioGraphicsManager = studioGraphicsManager;
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

        if (!("sources" in document) || !Array.isArray(document.sources)) {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("invalid-sources")
            ], 0, 0);
        }

        if ("graphics" in document && !Array.isArray(document.graphics)) {
            return this.finish("unavailable", 0, 0, [
                this.createIssue("invalid-graphics")
            ], 0, 0, 0, 0);
        }

        const graphics = document.graphics || [];

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
        const acceptedSourceIds = new Set();
        const acceptedGraphicIds = new Set();
        const acceptedIds = new Set();
        const definitionBaseUrl = response.url || String(this.configUrl);
        let registeredSourceCount = 0;
        let registeredGraphicCount = 0;
        let registeredCount = 0;

        document.sources.forEach((candidate, index) => {
            const source = this.createSourceDefinition(
                candidate,
                definitionBaseUrl
            );

            if (!source) {
                issues.push(this.createIssue("invalid-source", index, candidate?.id));
                return;
            }

            if (acceptedSourceIds.has(source.id) ||
                this.studioSourceManager.getSource(source.id)) {
                issues.push(this.createIssue("duplicate-source-id", index, source.id));
                return;
            }

            if (!this.studioSourceManager.registerSource(source)) {
                issues.push(this.createIssue("source-registration-rejected", index, source.id));
                return;
            }

            acceptedSourceIds.add(source.id);
            registeredSourceCount += 1;
        });

        graphics.forEach((candidate, index) => {
            const graphic = this.createGraphicDefinition(
                candidate,
                definitionBaseUrl
            );

            if (!graphic) {
                issues.push(this.createIssue("invalid-graphic", index, candidate?.id));
                return;
            }

            if (acceptedGraphicIds.has(graphic.id) ||
                this.studioGraphicsManager.getGraphic(graphic.id)) {
                issues.push(this.createIssue("duplicate-graphic-id", index, graphic.id));
                return;
            }

            if (!this.studioGraphicsManager.registerGraphic(graphic)) {
                issues.push(this.createIssue(
                    "graphic-registration-rejected",
                    index,
                    graphic.id
                ));
                return;
            }

            acceptedGraphicIds.add(graphic.id);
            registeredGraphicCount += 1;
        });

        document.scenes.forEach((candidate, index) => {
            const result = this.createDefinition(
                candidate,
                definitionBaseUrl,
                acceptedSourceIds
            );

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

        const skippedSourceCount = document.sources.length - registeredSourceCount;
        const skippedGraphicCount = graphics.length - registeredGraphicCount;
        const skippedCount = document.scenes.length - registeredCount;
        const status = registeredCount === 0
            ? "degraded"
            : skippedCount > 0 || skippedSourceCount > 0 ||
                skippedGraphicCount > 0
                ? "degraded"
                : "ready";

        return this.finish(
            status,
            registeredCount,
            skippedCount,
            issues,
            registeredSourceCount,
            skippedSourceCount,
            registeredGraphicCount,
            skippedGraphicCount
        );
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

    createDefinition(candidate, baseUrl, acceptedSourceIds) {
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

        const renderer = this.createRenderer(
            candidate.renderer,
            baseUrl,
            acceptedSourceIds
        );

        if (!renderer) {
            return { definition: null, reason: "invalid-renderer", id };
        }

        return {
            definition: Object.freeze({ id, name, type, renderer }),
            reason: null,
            id
        };
    }

    createRenderer(renderer, baseUrl, acceptedSourceIds) {
        if (!renderer || typeof renderer !== "object" ||
            Array.isArray(renderer)) {
            return null;
        }

        if (renderer.kind === "source") {
            const sourceId = this.normalizeString(renderer.sourceId);

            return sourceId && acceptedSourceIds.has(sourceId)
                ? Object.freeze({
                    kind: "source",
                    sourceId
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

    createSourceDefinition(candidate, baseUrl) {
        if (!candidate || typeof candidate !== "object" ||
            Array.isArray(candidate)) {
            return null;
        }

        const id = this.normalizeString(candidate.id);
        const kind = this.normalizeString(candidate.kind);

        if (!id || !kind) {
            return null;
        }

        if (kind === "hls") {
            const hasConfigRef = Object.prototype.hasOwnProperty.call(
                candidate,
                "configRef"
            );
            const hasUrl = Object.prototype.hasOwnProperty.call(
                candidate,
                "url"
            );
            const configRef = this.normalizeString(candidate.configRef);
            const url = this.normalizeString(candidate.url);

            if (hasConfigRef === hasUrl) {
                return null;
            }

            if (hasConfigRef) {
                if (!configRef) {
                    return null;
                }

                return Object.freeze({ id, kind, configRef });
            }

            if (!url) {
                return null;
            }

            const canonicalUrl = this.createHttpUrl(url, baseUrl);

            return canonicalUrl
                ? Object.freeze({ id, kind, url: canonicalUrl })
                : null;
        }

        if (kind === "media") {
            const url = this.normalizeString(candidate.url);

            if (!url) {
                return null;
            }

            const canonicalUrl = this.createHttpUrl(url, baseUrl);

            return canonicalUrl
                ? Object.freeze({ id, kind, url: canonicalUrl })
                : null;
        }

        return null;
    }

    createHttpUrl(value, baseUrl) {
        const url = this.normalizeString(value);

        if (!url) {
            return null;
        }

        try {
            const parsed = new URL(url, baseUrl);
            return parsed.protocol === "http:" || parsed.protocol === "https:"
                ? parsed.href
                : null;
        }
        catch {
            return null;
        }
    }

    createGraphicDefinition(candidate, baseUrl) {
        if (!candidate || typeof candidate !== "object" ||
            Array.isArray(candidate)) {
            return null;
        }

        const id = this.normalizeString(candidate.id);
        const kind = this.normalizeString(candidate.kind);
        const position = this.normalizeString(candidate.position);

        if (!id || typeof candidate.defaultVisible !== "boolean") {
            return null;
        }

        if (kind === "image" && this.isImagePosition(position)) {
            const asset = this.normalizeString(candidate.asset);

            if (!asset) {
                return null;
            }

            try {
                return Object.freeze({
                    id,
                    kind,
                    asset: new URL(asset, baseUrl).href,
                    position,
                    defaultVisible: candidate.defaultVisible
                });
            }
            catch {
                return null;
            }
        }

        if (kind === "lower-third" && position === "bottom-left") {
            if (["asset", "payload", "title", "subtitle"].some((key) =>
                Object.prototype.hasOwnProperty.call(candidate, key)
            )) {
                return null;
            }

            return Object.freeze({
                id,
                kind,
                position,
                defaultVisible: candidate.defaultVisible
            });
        }

        return null;
    }

    isImagePosition(position) {
        return [
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right"
        ].includes(position);
    }

    finish(
        status,
        registeredCount,
        skippedCount,
        issues,
        registeredSourceCount = 0,
        skippedSourceCount = 0,
        registeredGraphicCount = 0,
        skippedGraphicCount = 0
    ) {
        this.report = Object.freeze({
            status,
            registeredCount,
            skippedCount,
            registeredSourceCount,
            skippedSourceCount,
            registeredGraphicCount,
            skippedGraphicCount,
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
