import ControlCrawlObserver from '../program-output/ControlCrawlObserver.js';
import ControlEventStream from '../core/ControlEventStream.js';
import NetworkProgramOutputTransport from '../program-output/NetworkProgramOutputTransport.js';
import ScheduleApiClient from '../scheduler/ScheduleApiClient.js';
import {installControlMediaResources} from '../studio/ControlMediaResources.js';
import { shareTechnicalLiveHealth } from "../studio/SharedLiveHealthConsumer.js";
import AutoLiveEntryPresentation from "../studio/AutoLiveEntryPresentation.js";
import PlaybackRuntime from "../runtime/PlaybackRuntime.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";
import StudioStateManager from "../core/StudioStateManager.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import StudioUI from "../ui/StudioUI.js";
import StudioGraphicsUI from "../ui/StudioGraphicsUI.js";
import StudioTextCrawlUI from "../ui/StudioTextCrawlUI.js";
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
import StudioReferenceAuthority from '../studio/StudioReferenceAuthority.js';
import PreviewOwnershipClient from '../studio/PreviewOwnershipClient.js';
import ReferenceClient from '../studio/ReferenceClient.js';
import ChannelLogoReferenceClient from '../studio/ChannelLogoReferenceClient.js';
import LegacyAssetReferenceAuthority from '../studio/LegacyAssetReferenceAuthority.js';
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioAssetResolver from "../studio/StudioAssetResolver.js";
import StudioRenderer from "../studio/StudioRenderer.js";
import { programPlaybackContinuity, restoreRetainedProgramIdentity } from "../studio/ProgramPlaybackContinuity.js";
import trace, { programTraceFields } from "../core/RuntimeTrace.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioTransitionCoordinator from "../studio/StudioTransitionCoordinator.js";
import createStudioRemovalGuard from "../studio/StudioRemovalGuard.js";
import ProgramOutputManager from "../program-output/ProgramOutputManager.js";
import ProgramOutputSetupUI from "../ui/ProgramOutputSetupUI.js";
import StudioScheduleSummaryUI from "../ui/StudioScheduleSummaryUI.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import ScheduleClock from "../ui/ScheduleClock.js";
import ProgramRemainingTimeUI from "../ui/ProgramRemainingTimeUI.js";
import ScheduleStore from "../scheduler/ServerScheduleStore.js";
import SchedulerEngine from "../scheduler/SchedulerEngine.js";
import SchedulerRuntimeState from "../scheduler/SchedulerRuntimeState.js";
import StudioProgramCommand from "../scheduler/StudioProgramCommand.js";
import ScheduleTargetResolver from "../scheduler/ScheduleTargetResolver.js";
import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import LiveSourceMonitor, {TECHNICAL_RETRY_MAX_DELAY_MS} from "../studio/LiveSourceMonitor.js";
import TechnicalLiveMonitorUI from "../ui/TechnicalLiveMonitorUI.js";
import DominantLiveConfig from "../studio/DominantLiveConfig.js";
import AutoLiveEntryController from "../studio/AutoLiveEntryController.js";
import DominantLiveUI from "../ui/DominantLiveUI.js";
import SourcePresenceMonitor from "../studio/SourcePresenceMonitor.js";
import AutoLiveAuthorityClient from '../studio/AutoLiveAuthorityClient.js';
import AutoLiveLegacyBridge from '../studio/AutoLiveLegacyBridge.js';
import { createLiveHlsConsumerFactory } from "../studio/LiveHlsHealthConsumer.js";
import MediaLibraryClient from "../media-library/MediaLibraryClient.js";
import MediaLibraryManager from "../media-library/MediaLibraryManager.js";
import MediaLibraryUI from "../ui/MediaLibraryUI.js";
import MediaLibraryPickerUI from "../ui/MediaLibraryPickerUI.js";
import { requireOperatorSession } from "../auth/OperatorSessionClient.js";
import OperatorSessionUI from "../ui/OperatorSessionUI.js";

await requireOperatorSession();
const controlEvents = new ControlEventStream();
const referenceClient=new ReferenceClient({role:'CONTROL',eventSourceFactory:controlEvents.presenceSource});
try{await referenceClient.initialize();}catch{ /* Playback remains local; reference mutations fail closed. */ }
const operatorSessionUI = new OperatorSessionUI(
    document.getElementById("operator-logout"));
operatorSessionUI.start();

// Back/forward cache restores frozen JS instead of running the bootstrap again.
// Re-enter through retained Program Output so elapsed Scheduler time is applied.
globalThis.addEventListener?.("pageshow", event => {
    if (event.persisted) globalThis.location.reload();
});

BroadcastStateManager.initialize();
StudioStateManager.initialize();

const runtime = new PlaybackRuntime();
const studioAssetLibrary = new StudioAssetLibrary();
const mediaLibraryManager = new MediaLibraryManager(new MediaLibraryClient());
const studioAssetResolver = new StudioAssetResolver({
    legacyLibrary: studioAssetLibrary,
    mediaLibraryManager
});
const studioCatalogManager = new StudioCatalogManager({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    assetResolver: studioAssetResolver
});
const studioBootstrap = new StudioBootstrap({
    studioCatalogManager,
    studioGraphicsManager: StudioGraphicsManager
});
const dominantLiveConfig = new DominantLiveConfig();
let broadcastUI = null;
let studioUI = null;
let studioGraphicsUI = null;
let studioTextCrawlUI = null;
let studioMediaUI = null;
let studioSourcesUI = null;
let controlDeskLayoutManager = null;
let monitorWallLayoutManager = null;
let studioRenderer = null;
let studioTransitionCoordinator = null;
let programFullscreenUI = null;
let programOutputManager = null;
let controlCrawlObserver = null;
let programOutputSetupUI = null;
let studioScheduleUI = null;
let scheduleWorkspaceUI = null;
let schedulerEngine = null;
let scheduleStore = null;
let programRemainingTimeUI = null;
let technicalLiveMonitorUI = null;
let dominantLiveController = null;
let autoLiveBridge = null;
let autoLiveLossPresentation = null;
let dominantLiveUI = null;
let mediaLibraryUI = null;
let mediaLibraryPickerUI = null;
let previewOwnershipClient = null;
let unsubscribePreviewOwnership = null;

// The Control Desk is static page markup. Start its interaction layer before
// optional runtime services so Reset Layout and compact defaults remain usable
// if a later media, transport, or monitoring bootstrap step cannot start.
controlDeskLayoutManager = new ControlDeskLayoutManager({
    root: document.getElementById("studio-panel"),
    onEditModeChange: (enabled) =>
        monitorWallLayoutManager?.setEditMode(enabled),
    onReset: () => monitorWallLayoutManager?.reset()
});
controlDeskLayoutManager.start();

function traceControlProgram(phase) {
    const transport = studioRenderer?.getProgramTransport();
    const live = dominantLiveController?.getSnapshot();
    trace.record("control", "program-identity", {
        sceneId: StudioStateManager.getProgramSceneId(), sourceId: transport?.sourceId,
        kind: transport?.sourceId ? StudioSourceManager.getSource(transport.sourceId)?.kind : undefined,
        instanceId: transport?.instanceId, currentTime: transport?.currentTime,
        state: transport?.state, phase, sessionActive: Boolean(live?.session),
        ownershipState: live?.session?.phase || "NONE", mode: live?.armed ? "armed" : "disarmed"
    });
    trace.record("control", "retained-identity", {
        ...programTraceFields(programOutputManager?.snapshot), phase
    });
    trace.record("control", "autolive-ownership", {
        sourceId: live?.authorizedSourceId, sceneId: live?.session?.sceneId,
        phase, sessionActive: Boolean(live?.session),
        ownershipState: live?.session?.phase || "NONE", mode: live?.armed ? "armed" : "disarmed"
    });
}

const traceControlVisibility = () => traceControlProgram(document.visibilityState === "hidden" ? "leave" : "return");
document.addEventListener?.("visibilitychange", traceControlVisibility);

function destroyControlRoom() {
    autoLiveBridge?.destroy();
    previewOwnershipClient?.stop();
    unsubscribePreviewOwnership?.();
    controlCrawlObserver?.destroy();
    programOutputManager?.destroy();
    controlEvents.destroy();
    traceControlProgram("teardown");
    document.removeEventListener?.("visibilitychange", traceControlVisibility);
    scheduleStore?.destroy();
    scheduleStore = null;
    dominantLiveController?.destroy();
    dominantLiveController = null;
    autoLiveLossPresentation?.destroy();
    autoLiveLossPresentation = null;
    studioTextCrawlUI?.destroy();
    studioTextCrawlUI = null;
    studioGraphicsUI?.destroy();
    studioGraphicsUI = null;
    mediaLibraryUI?.destroy();
    mediaLibraryPickerUI?.destroy();
    studioSourcesUI?.destroy();
    studioSourcesUI = null;
    studioUI?.destroy();
    studioUI = null;
}

EventBus.on(Events.ENGINE_STOP, destroyControlRoom);
globalThis.addEventListener?.('pagehide', destroyControlRoom, {once:true});

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

        try { await mediaLibraryManager.initialize(); }
        catch (error) { console.warn("[MediaLibraryManager]", error); }
        studioAssetLibrary.referenceAuthority=new LegacyAssetReferenceAuthority({library:studioAssetLibrary,mediaLibrary:mediaLibraryManager,client:referenceClient});
        await studioAssetLibrary.referenceAuthority.initialize();

        const bootstrapReport = await studioBootstrap.initialize();
        const referenceAuthority = new StudioReferenceAuthority({ catalog: studioCatalogManager,client:referenceClient });
        studioCatalogManager.referenceAuthority = referenceAuthority;
        await referenceAuthority.initialize();
        dominantLiveConfig.logRead(studioCatalogManager);

        if (bootstrapReport.status !== "ready") {
            console.warn("[StudioBootstrap]", bootstrapReport);
        }

        const programOutputTransport = await createProgramOutputTransport({ role: "publisher",
            eventSourceFactory: controlEvents.eventSource });
        let retainedProgram = await programOutputTransport.readRetained();
        let retainedProgramIdentityResolved = restoreRetainedProgramIdentity(retainedProgram, {
            stateManager: StudioStateManager, catalog: studioCatalogManager,
            sourceManager: StudioSourceManager
        });
        // A publisher handoff can briefly expose the previous retained snapshot
        // (for example the AutoLive entry slate) while the committed LIVE
        // envelope is still reaching the server. Retry unresolved identity once
        // before allowing AutoLive to evaluate a fresh 30s acquisition.
        if (!retainedProgramIdentityResolved) {
            const retry = await programOutputTransport.readRetained({ timeoutMs: 4000 });
            if (retry) {
                retainedProgram = retry;
                retainedProgramIdentityResolved = restoreRetainedProgramIdentity(retainedProgram, {
                    stateManager: StudioStateManager, catalog: studioCatalogManager,
                    sourceManager: StudioSourceManager
                });
            }
        }
        const initialProgramContext = programPlaybackContinuity(retainedProgram, {
            stateManager: StudioStateManager, catalog: studioCatalogManager,
            sourceManager: StudioSourceManager
        });
        studioRenderer = new StudioRenderer({
            previewRoot: document.getElementById("studio-preview-renderer"),
            programRoot: document.getElementById("studio-program-renderer"),
            studioStateManager: StudioStateManager,
            definitionRegistry: studioCatalogManager,
            studioSourceManager: StudioSourceManager,
            studioGraphicsManager: StudioGraphicsManager,
            initialProgramContext
        });
        studioRenderer.start();
        installControlMediaResources(surface=>{
            if(studioRenderer.program.prepared?.renderer===surface)return 'prepared-program';
            if(studioRenderer.program.renderer===surface)return 'program';
            if(studioRenderer.preview.renderer===surface)return 'preview';
            if(studioRenderer.program.transition?.outgoingRenderer===surface)return 'outgoing-program';
            if(['preview','program'].includes(surface.consumer))return 'unassigned-'+surface.consumer;
            return surface.consumer;
        });
        previewOwnershipClient = new PreviewOwnershipClient({ getOwnership: () => {
            const sceneId = StudioStateManager.getPreviewSceneId();
            const definition = studioCatalogManager.getDefinition(sceneId);
            const source = definition?.renderer?.kind === 'source'
                ? studioCatalogManager.sources.get(definition.renderer.sourceId) : null;
            const assets = new Set();
            let complete = !sceneId || !!definition;
            const managed = mediaLibraryManager.getSnapshot().assets;
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                for (const [key, child] of Object.entries(value)) {
                    if (typeof child === 'string' && ['assetId','audioAssetId','stillAssetId','motionAssetId'].includes(key)) {
                        if (managed.some(asset => asset.id === child)) assets.add(child);
                        else if (/^asset-/.test(child)) complete = false;
                    }
                    if (typeof child === 'string' && ['url','audioUrl','stillUrl','motionUrl','asset','logo'].includes(key)) {
                        try { const path = decodeURIComponent(new URL(child, document.baseURI).pathname);
                            if (path.startsWith('/media-library/files/')) {
                                const asset = managed.find(asset => asset.url === path);
                                if (asset) assets.add(asset.id); else complete = false;
                            }
                        } catch { complete = false; }
                    }
                    if (child && typeof child === 'object') visit(child);
                }
            };
            visit(source); visit(definition?.renderer); visit(StudioGraphicsManager.getVisibleGraphics('preview'));
            return { complete, assets: [...assets], ownerLabel: definition?.name || 'Preview' };
        } });
        void previewOwnershipClient.start();
        globalThis.addEventListener('pagehide',()=>{
            previewOwnershipClient?.stop({confirmedGone:true});void referenceClient.close().catch(()=>{});
        },{once:true});
        const reportPreviewOwnership = () => void previewOwnershipClient?.report();
        EventBus.on(Events.STUDIO_PREVIEW_CHANGED, reportPreviewOwnership);
        const stopGraphicOwnership = StudioGraphicsManager.subscribe('preview', reportPreviewOwnership);
        unsubscribePreviewOwnership = () => { EventBus.off(Events.STUDIO_PREVIEW_CHANGED, reportPreviewOwnership); stopGraphicOwnership(); };
        controlCrawlObserver = new ControlCrawlObserver({ layer: studioRenderer.program.graphicsLayer,
            transport: new NetworkProgramOutputTransport({role:'subscriber',subscribeUrl:'/api/program-output/events',
                eventSourceFactory:controlEvents.eventSource}) });
        controlCrawlObserver.start();

        studioTransitionCoordinator = new StudioTransitionCoordinator({
            studioStateManager: StudioStateManager,
            studioRenderer
        });
        studioTransitionCoordinator.start();
        programOutputManager = new ProgramOutputManager({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            sourceManager: StudioSourceManager,
            renderer: studioRenderer,
            graphicsManager: StudioGraphicsManager,
            transitionCoordinator: studioTransitionCoordinator,
            transport: programOutputTransport,
            initialProgramContext
        });
        programOutputManager.start();
        programOutputSetupUI = new ProgramOutputSetupUI({
            root: document,
            transport: programOutputTransport
        });
        programOutputSetupUI.start();
        scheduleStore = new ScheduleStore({client:new ScheduleApiClient({eventSourceFactory:controlEvents.eventSource})});
        void scheduleStore.start();
        studioCatalogManager.setRemovalGuard(createStudioRemovalGuard({
            dominantLiveConfig,
            transitionCoordinator: studioTransitionCoordinator,
            studioRenderer,
            scheduleStore
        }));

        studioUI = new StudioUI(
            document.getElementById("studio-panel"),
            studioTransitionCoordinator,
            studioCatalogManager,
            () => Boolean(programOutputManager?.pendingProgramPublishReason)
        );
        studioUI.start();

        const scheduleTargetResolver = new ScheduleTargetResolver({
            catalog: studioCatalogManager
        });
        const dominantLiveTargetResolver = new ScheduleTargetResolver({
            catalog: studioCatalogManager,
            namespace: "dominant-live-source"
        });
        const studioProgramCommand = new StudioProgramCommand({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            transitionCoordinator: studioTransitionCoordinator,
            targetResolver: scheduleTargetResolver
        });
        const schedulerRuntimeState=new SchedulerRuntimeState();
        autoLiveBridge=new AutoLiveLegacyBridge({config:dominantLiveConfig,runtimeState:schedulerRuntimeState,
            client:new AutoLiveAuthorityClient({streamFactory:()=>controlEvents.eventSource('/api/studio/schedule/events')}),
            root:document.getElementById('dominant-live-control')});
        await autoLiveBridge.start();
        if(autoLiveBridge.destroyed)return;
        schedulerEngine = new SchedulerEngine({
            command: studioProgramCommand,
            catalog: studioCatalogManager,
            programTransportProvider: () => studioRenderer.getProgramTransport(),
            runtimeState: schedulerRuntimeState,
            programExecution: false
        });
        const scheduleClock = new ScheduleClock();
        autoLiveBridge.attachEngine(schedulerEngine);
        studioScheduleUI = new StudioScheduleSummaryUI({
            root: document,
            engine: schedulerEngine,
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock
        });
        studioScheduleUI.autoLiveBridge=autoLiveBridge;
        studioScheduleUI.start();
        schedulerEngine.restoreEnabledState();
        scheduleWorkspaceUI = new ScheduleWorkspaceUI({
            root: document.getElementById("control-schedule-view"),
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock,
            readOnly: true,
            editorUrl: "./schedule/",
            schedulerEngine
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

        mediaLibraryPickerUI = new MediaLibraryPickerUI(mediaLibraryManager);
        mediaLibraryPickerUI.start();
        studioSourcesUI = new StudioOperationalSourcesUI(
            document.getElementById("studio-panel"), studioCatalogManager,
            { mediaLibraryManager, mediaLibraryPicker: mediaLibraryPickerUI }
        );
        studioSourcesUI.start();
        mediaLibraryUI = new MediaLibraryUI(
            document.getElementById("media-library"),
            mediaLibraryManager
        );
        mediaLibraryUI.start();

        const technicalRoot = document.querySelector(".control-room-technical");
        const liveSourceMonitor = new LiveSourceMonitor({
            maxRetryDelayMs: TECHNICAL_RETRY_MAX_DELAY_MS,
            consumerFactory: TechnicalLiveMonitorUI.createConsumerFactory(
                technicalRoot.querySelector("#technical-live-surface")
            )
        });
        technicalLiveMonitorUI = new TechnicalLiveMonitorUI({
            root: technicalRoot, catalog: studioCatalogManager,
            monitor: liveSourceMonitor
        });
        technicalLiveMonitorUI.start();

        const dominantHealthRoot = document.createElement("div");
        dominantHealthRoot.className = "dominant-live-health-surface";
        dominantHealthRoot.setAttribute("aria-hidden", "true");
        document.body.append(dominantHealthRoot);
        const dominantHealthMonitor = new SourcePresenceMonitor({
            externalConsumerFactory: shareTechnicalLiveHealth(liveSourceMonitor,
                createLiveHlsConsumerFactory(dominantHealthRoot))
        });
        dominantLiveController = new AutoLiveEntryController({
            renderer: studioRenderer,
            retainedProgramIdentityResolved,
            retainedProgram,
            getProgramRevision: () => programOutputManager?.revision,
            config: dominantLiveConfig,
            catalog: studioCatalogManager,
            monitor: dominantHealthMonitor,
            scheduler: schedulerEngine,
            command: studioProgramCommand,
            targetResolver: dominantLiveTargetResolver,
            probeDiagnosticsProvider: () => ({ healthAuthority: "source" })
        });
        dominantLiveController.start();
        autoLiveBridge.setShadowProvider(()=>({...dominantHealthMonitor.getSnapshot(),
            endpoint:dominantLiveController.getAuthorizedSource()?.url}));
        autoLiveBridge.setBrowserStageProvider(()=>({controller:dominantLiveController,
            snapshot:dominantLiveController.getSnapshot()}));
        traceControlProgram("boot");
        autoLiveLossPresentation = new AutoLiveEntryPresentation({
            controller: dominantLiveController, output: programOutputManager, renderer: studioRenderer,
            root: studioRenderer.program.root, stateManager: StudioStateManager
        });
        autoLiveLossPresentation.start();
        dominantLiveUI = new DominantLiveUI({
            root: document.getElementById("dominant-live-control"),
            config: dominantLiveConfig,
            controller: dominantLiveController
        });
        dominantLiveUI.start();

        studioGraphicsUI = new StudioGraphicsUI(
            document.getElementById("studio-panel"),
            StudioGraphicsManager,
            "lower-third-basic",
            studioAssetLibrary
        );
        studioGraphicsUI.logoAuthority=new ChannelLogoReferenceClient();
        const logoStates=Object.fromEntries(['preview','program'].map(consumer=>{
            const entry=StudioGraphicsManager.getVisibleGraphics(consumer).find(value=>value.graphic.id==='channel-logo');
            return [consumer,entry?new URL(entry.payload?.asset||entry.graphic.asset,document.baseURI).href:null];
        }));
        await studioGraphicsUI.logoAuthority.initialize(logoStates);
        studioGraphicsUI.start();
        studioTextCrawlUI = new StudioTextCrawlUI({
            root: document.getElementById("studio-panel"),
            graphicsManager: StudioGraphicsManager
        });
        studioTextCrawlUI.start();

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
