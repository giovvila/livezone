const SOURCE_TYPES = Object.freeze({
    media: "MEDIA",
    audio: "AUDIO",
    hls: "LIVE",
    image: "IMAGE"
});

export default class ScheduleTargetResolver {
    constructor({ catalog, namespace = "schedule-source" } = {}) {
        this.catalog = catalog;
        this.namespace = namespace;
    }

    resolve(target) {
        if (target?.kind === "scene") {
            const definition = this.catalog?.getDefinition(target.id);
            return definition ? Object.freeze({ sceneId: definition.id, definition,
                target: Object.freeze({ ...target }) }) : null;
        }
        if (target?.kind !== "source") return null;
        const source = this.catalog?.getSources?.().find(({ id }) => id === target.id);
        if (!source || source.available === false ||
            source.kind === "hls" && source.enabled === false) return null;
        const sceneId = this.getRuntimeSceneId(target);
        const definition = this.catalog.registerRuntimeDefinition?.({
            id: sceneId,
            name: source.name,
            type: SOURCE_TYPES[source.kind],
            renderer: { kind: "source", sourceId: source.id }
        });
        return definition ? Object.freeze({ sceneId, definition,
            target: Object.freeze({ ...target }) }) : null;
    }

    getRuntimeSceneId(target) {
        if (target?.kind === "scene") return target.id;
        if (target?.kind !== "source" || typeof target.id !== "string") return null;
        const slug = target.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "").slice(0, 80) || "source";
        return `${this.namespace}-${slug}-${hash(target.id)}`;
    }
}

function hash(value) {
    let result = 2166136261;
    for (const character of value) {
        result ^= character.codePointAt(0);
        result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
}
