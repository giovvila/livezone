import StudioStateManager from "../core/StudioStateManager.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioCatalogManager from "../studio/StudioCatalogManager.js";
import StudioBootstrap from "../studio/StudioBootstrap.js";
import ScheduleStore from "../scheduler/ScheduleStore.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import StudioAssetsUI from "../ui/StudioAssetsUI.js";
import StudioLiveSourcesUI from "../ui/StudioLiveSourcesUI.js";

StudioStateManager.initialize();
StudioSourceManager.initialize({});
StudioGraphicsManager.initialize();

const assetLibrary = new StudioAssetLibrary();
await assetLibrary.initialize();
const catalog = new StudioCatalogManager({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    assetResolver: (assetId) => assetLibrary.getAsset(assetId)
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
const scheduleUI = new ScheduleWorkspaceUI({
    root: workspace,
    store: scheduleStore,
    catalog,
    assetLibrary
});
const assetsUI = new StudioAssetsUI(workspace, assetLibrary);
const liveSourcesUI = new StudioLiveSourcesUI(workspace, catalog, scheduleStore);

scheduleUI.start();
assetsUI.start();
liveSourcesUI.start();
