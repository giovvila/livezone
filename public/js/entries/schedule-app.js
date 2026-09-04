import StudioStateManager from "../core/StudioStateManager.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioAssetResolver from "../studio/StudioAssetResolver.js";
import StudioCatalogManager from "../studio/StudioCatalogManager.js";
import StudioBootstrap from "../studio/StudioBootstrap.js";
import MediaLibraryClient from "../media-library/MediaLibraryClient.js";
import MediaLibraryManager from "../media-library/MediaLibraryManager.js";
import ScheduleStore from "../scheduler/ScheduleStore.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import StudioAssetsUI from "../ui/StudioAssetsUI.js";
import StudioLiveSourcesUI from "../ui/StudioLiveSourcesUI.js";
import DominantLiveConfig from "../studio/DominantLiveConfig.js";
import SchedulerRuntimeState from "../scheduler/SchedulerRuntimeState.js";
import { requireOperatorSession } from "../auth/OperatorSessionClient.js";
import OperatorSessionUI from "../ui/OperatorSessionUI.js";

await requireOperatorSession();
const operatorSessionUI = new OperatorSessionUI(
    document.getElementById("operator-logout"));
operatorSessionUI.start();

StudioStateManager.initialize();
StudioSourceManager.initialize({});
StudioGraphicsManager.initialize();

const assetLibrary = new StudioAssetLibrary();
await assetLibrary.initialize();
const mediaLibraryManager = new MediaLibraryManager(new MediaLibraryClient());
await mediaLibraryManager.initialize();
const assetResolver = new StudioAssetResolver({
    legacyLibrary: assetLibrary,
    mediaLibraryManager
});
const catalog = new StudioCatalogManager({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    assetResolver
});
const bootstrap = new StudioBootstrap({
    studioCatalogManager: catalog,
    studioGraphicsManager: StudioGraphicsManager
});
await bootstrap.initialize();

assetLibrary.setReferenceGuard((asset) =>
    ["logo", "still"].includes(asset.kind) ||
    catalog.getSources().some((source) =>
        [source.assetId, source.audioAssetId, source.stillAssetId].includes(asset.id))
        ? "asset-still-referenced"
        : null);

const workspace = document.getElementById("schedule-workspace");
const scheduleStore = new ScheduleStore();
const dominantLiveConfig = new DominantLiveConfig();
const schedulerRuntimeState = new SchedulerRuntimeState();
document.body.dataset.schedulerEnabled = String(schedulerRuntimeState.load().enabled);
const scheduleUI = new ScheduleWorkspaceUI({
    root: workspace,
    store: scheduleStore,
    catalog,
    assetLibrary,
    assetResolver,
    mediaLibraryManager
});
const assetsUI = new StudioAssetsUI(workspace, assetLibrary);
const liveSourcesUI = new StudioLiveSourcesUI(
    workspace, catalog, scheduleStore, dominantLiveConfig
);

scheduleUI.start();
assetsUI.start();
liveSourcesUI.start();
