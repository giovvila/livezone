export const RESUME_POLICIES = Object.freeze({
    SHIFT: "RESUME_SHIFT",
    FIXED: "RESUME_FIXED",
    FILLER: "FILLER"
});

export function isHardClock(item) {
    return item?.behavior === "NORMAL" && item.startMode === "ABSOLUTE" &&
        item.resumePolicy !== RESUME_POLICIES.FILLER;
}

export function calculateEffectiveSchedule(schedule, runtimeShiftMs = new Map()) {
    if (!schedule) return schedule;
    const normalItems = schedule.items.filter(({ behavior }) => behavior === "NORMAL");
    const interruptItems = schedule.items.filter(({ behavior }) => behavior === "INTERRUPT");
    const effectiveNormals = [];

    normalItems.forEach((item, index) => {
        const previous = effectiveNormals.at(-1) || null;
        const nextHardStart = normalItems.slice(index + 1)
            .find(isHardClock)?.startMs ?? Infinity;
        const shift = finiteShift(runtimeShiftMs.get(item.id));
        let startMs;
        let naturalEndMs;

        if (isHardClock(item)) {
            startMs = item.startMs;
            naturalEndMs = startMs + item.durationSeconds * 1000 + shift;
        }
        else if (item.resumePolicy === RESUME_POLICIES.FILLER) {
            startMs = Math.max(item.startMs, previous?.endMs ?? item.startMs);
            naturalEndMs = startMs + item.durationSeconds * 1000;
        }
        else {
            startMs = previous?.endMs ?? item.startMs;
            naturalEndMs = startMs + item.durationSeconds * 1000 + shift;
        }

        const endMs = Math.max(startMs, Math.min(naturalEndMs, nextHardStart));
        effectiveNormals.push(Object.freeze({
            ...item,
            startMs,
            endMs,
            effectiveStart: new Date(startMs).toISOString(),
            effectiveEnd: new Date(endMs).toISOString(),
            effectiveDurationSeconds: (endMs - startMs) / 1000,
            skipped: endMs <= startMs
        }));
    });

    const items = [...effectiveNormals, ...interruptItems.map((item) =>
        Object.freeze({ ...item, effectiveEnd: new Date(item.endMs).toISOString(),
            effectiveDurationSeconds: item.durationSeconds, skipped: false }))]
        .sort((left, right) => left.startMs - right.startMs ||
            Number(right.behavior === "INTERRUPT") - Number(left.behavior === "INTERRUPT") ||
            left.id.localeCompare(right.id));
    return Object.freeze({ ...schedule, items: Object.freeze(items) });
}

export function applyInterruptionShift(runtimeShiftMs, itemId, durationMs) {
    const next = new Map(runtimeShiftMs || []);
    if (typeof itemId !== "string" || !Number.isFinite(durationMs) || durationMs <= 0) {
        return next;
    }
    next.set(itemId, finiteShift(next.get(itemId)) + durationMs);
    return next;
}

function finiteShift(value) {
    return Number.isFinite(value) && value > 0 ? value : 0;
}
