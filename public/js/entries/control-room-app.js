import PlaybackRuntime from "../runtime/PlaybackRuntime.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";
import StudioStateManager from "../core/StudioStateManager.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import StudioUI from "../ui/StudioUI.js";
import StudioGraphicsUI from "../ui/StudioGraphicsUI.js";
import StudioMediaUI from "../ui/StudioMediaUI.js";
import StudioOperationalSourcesUI from "../ui/StudioOperationalSourcesUI.js";
import ControlDeskLayoutManager from "../ui/ControlDeskLayoutManager.js";
import MonitorWallLayoutManager from "../ui/MonitorWallLayoutManager.js";
import ProgramFullscreenUI from "../ui/ProgramFullscreenUI.js";
import OverlayController from "../ui/OverlayController.js";
import NotificationCenter from "../ui/NotificationCenter.js";
import DebugPanel from "../debug/DebugPanel.js";
import StudioBootstrap from "../studio/StudioBootstrap.js";
import StudioCatalogManager from "../studio/StudioCatalogManager.js";
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioRenderer from "../studio/StudioRenderer.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioTransitionCoordinator from "../studio/StudioTransitionCoordinator.js";
import ProgramOutputManager from "../program-output/ProgramOutputManager.js";
import ProgramOutputSetupUI from "../ui/ProgramOutputSetupUI.js";
import StudioScheduleSummaryUI from "../ui/StudioScheduleSummaryUI.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import ScheduleClock from "../ui/ScheduleClock.js";
import ProgramRemainingTimeUI from "../ui/ProgramRemainingTimeUI.js";
import ScheduleStore from "../scheduler/ScheduleStore.js";
import SchedulerEngine from "../scheduler/SchedulerEngine.js";
import StudioProgramCommand from "../scheduler/StudioProgramCommand.js";
import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import LiveSourceMonitor from "../studio/LiveSourceMonitor.js";
import TechnicalLiveMonitorUI from "../ui/TechnicalLiveMonitorUI.js";

BroadcastStateManager.initialize();
StudioStateManager.initialize();

const runtime = new PlaybackRuntime();
const studioAssetLibrary = new StudioAssetLibrary();
const studioCatalogManager = new StudioCatalogManager({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    assetResolver: (assetId) => studioAssetLibrary.getAsset(assetId)
});
const studioBootstrap = new StudioBootstrap({
    studioCatalogManager,
    studioGraphicsManager: StudioGraphicsManager
});
let broadcastUI = null;
let studioUI = null;
let studioGraphicsUI = null;
let studioMediaUI = null;
let studioSourcesUI = null;
let controlDeskLayoutManager = null;
let monitorWallLayoutManager = null;
let studioRenderer = null;
let studioTransitionCoordinator = null;
let programFullscreenUI = null;
let programOutputManager = null;
let programOutputSetupUI = null;
let studioScheduleUI = null;
let scheduleWorkspaceUI = null;
let schedulerEngine = null;
let programRemainingTimeUI = null;
let technicalLiveMonitorUI = null;

runtime.start({
    startPlayer: false,
    async beforePlayerStart(config) {
        broadcastUI = new BroadcastUI();
        broadcastUI.start(config);

        StudioSourceManager.initialize(config);
        StudioGraphicsManager.initialize();

        const assetLibraryReport = await studioAssetLibrary.initialize();

        if (assetLibraryReport.status !== "ready") {
            console.warn("[StudioAssetLibrary]", assetLibraryReport);
        }

        const bootstrapReport = await studioBootstrap.initialize();

        if (bootstrapReport.status !== "ready") {
            console.warn("[StudioBootstrap]", bootstrapReport);
        }

        studioRenderer = new StudioRenderer({
            previewRoot: document.getElementById("studio-preview-renderer"),
            programRoot: document.getElementById("studio-program-renderer"),
            studioStateManager: StudioStateManager,
            definitionRegistry: studioCatalogManager,
            studioSourceManager: StudioSourceManager,
            studioGraphicsManager: StudioGraphicsManager
        });
        studioRenderer.start();

        studioTransitionCoordinator = new StudioTransitionCoordinator({
            studioStateManager: StudioStateManager,
            studioRenderer
        });
        studioTransitionCoordinator.start();
        const programOutputTransport = await createProgramOutputTransport({
            role: "publisher"
        });
        programOutputManager = new ProgramOutputManager({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            sourceManager: StudioSourceManager,
            renderer: studioRenderer,
            graphicsManager: StudioGraphicsManager,
            transitionCoordinator: studioTransitionCoordinator,
            transport: programOutputTransport
        });
        programOutputManager.start();
        programOutputSetupUI = new ProgramOutputSetupUI({
            root: document,
            transport: programOutputTransport
        });
        programOutputSetupUI.start();
        studioCatalogManager.setRemovalGuard(({ sceneId }) =>
            studioTransitionCoordinator.isBusy() ||
            studioRenderer.isSceneInUse(sceneId)
        );

        studioUI = new StudioUI(
            document.getElementById("studio-panel"),
            studioTransitionCoordinator
        );
        studioUI.start();

        const studioProgramCommand = new StudioProgramCommand({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            transitionCoordinator: studioTransitionCoordinator
        });
        schedulerEngine = new SchedulerEngine({
            command: studioProgramCommand,
            catalog: studioCatalogManager,
            programTransportProvider: () => studioRenderer.getProgramTransport()
        });
        const scheduleStore = new ScheduleStore();
        const scheduleClock = new ScheduleClock();
        studioScheduleUI = new StudioScheduleSummaryUI({
            root: document,
            engine: schedulerEngine,
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock
        });
        studioScheduleUI.start();
        scheduleWorkspaceUI = new ScheduleWorkspaceUI({
            root: document.getElementById("control-schedule-view"),
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock,
            readOnly: true,
            editorUrl: "./schedule/"
        });
        scheduleWorkspaceUI.start();
        programRemainingTimeUI = new ProgramRemainingTimeUI({
            root: document,
            schedulerEngine,
            renderer: studioRenderer,
            stateManager: StudioStateManager
        });
        programRemainingTimeUI.start();

        studioMediaUI = new StudioMediaUI(
            document.getElementById("studio-panel"),
            studioRenderer
        );
        studioMediaUI.start();

        studioSourcesUI = new StudioOperationalSourcesUI(
            document.getElementById("studio-panel"),
            studioCatalogManager
        );
        studioSourcesUI.start();

        const technicalRoot = document.querySelector(".control-room-technical");
        const liveSourceMonitor = new LiveSourceMonitor({
            consumerFactory: TechnicalLiveMonitorUI.createConsumerFactory(
                technicalRoot.querySelector("#technical-live-surface")
            )
        });
        technicalLiveMonitorUI = new TechnicalLiveMonitorUI({
            root: technicalRoot, catalog: studioCatalogManager,
            monitor: liveSourceMonitor
        });
        technicalLiveMonitorUI.start();

        studioGraphicsUI = new StudioGraphicsUI(
            document.getElementById("studio-panel"),
            StudioGraphicsManager,
            "lower-third-basic",
            studioAssetLibrary
        );
        studioGraphicsUI.start();

        studioAssetLibrary.setReferenceGuard((asset) =>
            studioCatalogManager.isAssetReferenced(asset.id) ||
            studioGraphicsUI.isAssetReferenced(asset)
                ? "asset-still-referenced"
                : null
        );
        monitorWallLayoutManager = new MonitorWallLayoutManager({
            root: document.querySelector(".control-room-monitor-wall")
        });
        monitorWallLayoutManager.start();

        controlDeskLayoutManager = new ControlDeskLayoutManager({
            root: document.getElementById("studio-panel"),
            onEditModeChange: (enabled) =>
                monitorWallLayoutManager?.setEditMode(enabled),
            onReset: () => monitorWallLayoutManager?.reset()
        });
        controlDeskLayoutManager.start();

        programFullscreenUI = new ProgramFullscreenUI({
            target: document.querySelector(".control-room-program"),
            button: document.getElementById("program-fullscreen-toggle")
        });
        programFullscreenUI.start();

        new OverlayController();
        new NotificationCenter();
    }
}).then(({ player }) => {
    const debugContainer = document.getElementById("debug-panel");

    if (!debugContainer || !player) {
        return;
    }

    const debugPanel = new DebugPanel(debugContainer);
    debugPanel.render();
    debugPanel.attach(player);
}).catch(() => {
    // PlaybackRuntime already reports the startup failure to the UI/EventBus.
});
