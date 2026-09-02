export default function createStudioRemovalGuard({
    dominantLiveConfig,
    transitionCoordinator,
    studioRenderer,
    scheduleStore
} = {}) {
    return ({ sourceId = null, sceneId = null } = {}) => {
        if (sourceId &&
            dominantLiveConfig?.getSnapshot?.().authorizedSourceId === sourceId) {
            return "source-authorized";
        }
        if (sourceId && scheduleStore?.getSnapshot?.().schedule.items.some(
            (item) => item.target?.kind === "source" && item.target.id === sourceId
        )) {
            return "scheduler-reference";
        }
        if (sceneId && scheduleStore?.getSnapshot?.().schedule.items.some(
            (item) => item.sceneId === sceneId ||
                item.target?.kind === "scene" && item.target.id === sceneId
        )) {
            return "scheduler-reference";
        }
        if (sceneId && studioRenderer?.isSceneInUse?.(sceneId)) {
            return "active-runtime-reference";
        }
        if (transitionCoordinator?.isBusy?.()) {
            return "active-runtime-reference";
        }
        return null;
    };
}
