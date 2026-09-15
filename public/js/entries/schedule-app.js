import StudioStateManager from "../core/StudioStateManager.js";
import MediaLibraryUI from '../ui/MediaLibraryUI.js';
import ScheduleWorkspacePanels from '../ui/ScheduleWorkspacePanels.js';
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioAssetResolver from "../studio/StudioAssetResolver.js";
import StudioCatalogManager from "../studio/StudioCatalogManager.js";
import StudioReferenceAuthority from '../studio/StudioReferenceAuthority.js';
import ReferenceClient from '../studio/ReferenceClient.js';
import LegacyAssetReferenceAuthority from '../studio/LegacyAssetReferenceAuthority.js';
import StudioBootstrap from "../studio/StudioBootstrap.js";
import MediaLibraryClient from "../media-library/MediaLibraryClient.js";
import MediaLibraryManager from "../media-library/MediaLibraryManager.js";
import ScheduleStore from "../scheduler/ServerScheduleStore.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import StudioAssetsUI from "../ui/StudioAssetsUI.js";
import StudioLiveSourcesUI from "../ui/StudioLiveSourcesUI.js";
import DominantLiveConfig from "../studio/DominantLiveConfig.js";
import SchedulerRuntimeState from "../scheduler/SchedulerRuntimeState.js";
import initializeScheduleSources from "../scheduler/InitializeScheduleSources.js";
import { requireOperatorSession } from "../auth/OperatorSessionClient.js";
import OperatorSessionUI from "../ui/OperatorSessionUI.js";

// Panel visibility is independent of network/bootstrap success.
const workspace = document.getElementById("schedule-workspace");
const workspacePanels=new ScheduleWorkspacePanels(workspace);workspacePanels.start();
globalThis.addEventListener('pagehide',()=>workspacePanels.destroy(),{once:true});
await requireOperatorSession();
const referenceClient=new ReferenceClient({role:'SCHEDULER'});
try{await referenceClient.initialize();}catch{}
globalThis.addEventListener('pagehide',()=>void referenceClient.close().catch(()=>{}),{once:true});
const operatorSessionUI = new OperatorSessionUI(
    document.getElementById("operator-logout"));
operatorSessionUI.start();

StudioStateManager.initialize();
await initializeScheduleSources(StudioSourceManager);
StudioGraphicsManager.initialize();

const assetLibrary = new StudioAssetLibrary();
await assetLibrary.initialize();
const mediaLibraryManager = new MediaLibraryManager(new MediaLibraryClient());
await mediaLibraryManager.initialize();
assetLibrary.referenceAuthority=new LegacyAssetReferenceAuthority({library:assetLibrary,mediaLibrary:mediaLibraryManager,client:referenceClient});
await assetLibrary.referenceAuthority.initialize();
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
catalog.referenceAuthority=new StudioReferenceAuthority({catalog,client:referenceClient});
await catalog.referenceAuthority.initialize();

assetLibrary.setReferenceGuard((asset) =>
    ["logo", "still"].includes(asset.kind) ||
    catalog.getSources().some((source) =>
        [source.assetId, source.audioAssetId, source.stillAssetId].includes(asset.id))
        ? "asset-still-referenced"
        : null);

const scheduleStore = new ScheduleStore();
void scheduleStore.start();
globalThis.addEventListener("pagehide", () => scheduleStore.destroy(), { once: true });
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
const mediaLibraryUI=new MediaLibraryUI(document.getElementById('media-library'),mediaLibraryManager,{
    manageCollapse:false,
    storageKey:'livezone.scheduler.mediaLibrary.collapsed.v1',defaultCollapsed:true,collapseTarget:'#schedule-media-body',
    onSelectAsset:asset=>scheduleUI.overlayEditor?.useAsset(asset)
});mediaLibraryUI.start();
globalThis.addEventListener('pagehide',()=>mediaLibraryUI.destroy(),{once:true});
assetsUI.start();
liveSourcesUI.start();
