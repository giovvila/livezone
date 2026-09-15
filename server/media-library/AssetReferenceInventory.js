import { ID_PATTERN } from './MediaAssetRepository.js';

export const referenceError = code => Object.assign(new Error(code === 'ASSET_UNAVAILABLE'
    ? 'ASSET NON DISPONIBILE' : code === 'REFERENCE_AUDIT_UNAVAILABLE'
        ? 'REFERENCE INVENTORY INCOMPLETE' : code), { code });

// Reference projection only. Sources/scenes remain owned by StudioStateRepository;
// schedule by ScheduleStore; Program by the retained ProgramOutputStore.
export default class AssetReferenceInventory {
    constructor({ repository, inventories, preview, completeness, diagnostics }) {
        Object.assign(this, { repository, inventories, preview, completeness, diagnostics });
    }

    extract(data, { kind = 'SOURCE', classification = 'PERSISTED' } = {}) {
        const references = [], unavailable = [];
        const assets = this.repository.list?.() || [];
        const byUrl = new Map(assets.map(asset => [asset.url, asset]));
        const visit = (value, context, location = '') => {
            if (!value || typeof value !== 'object') return;
            const owner = { ...context,
                ownerId: typeof value.id === 'string' ? value.id : context.ownerId,
                ownerLabel: typeof value.name === 'string' ? value.name.slice(0, 120) : context.ownerLabel };
            if (value.type === 'overlay.sponsor') owner.kind = 'SCHEDULE EVENT';
            else if (value.renderer) owner.kind = 'SCENE';
            else if (classification === 'PERSISTED' && ['media','image','audio'].includes(value.kind))
                owner.kind = 'SOURCE ' + ({media:'VIDEO',image:'IMAGE',audio:'AUDIO'})[value.kind];
            for (const [key, child] of Object.entries(value)) {
                const path = location ? `${location}.${key}` : key;
                const expected = ({ audioAssetId: 'audio', stillAssetId: 'image', motionAssetId: 'video',
                    audioUrl: 'audio', stillUrl: 'image', motionUrl: 'video', logo: 'image', logoUrl: 'image', logoAssetId: 'image', asset: 'image' })[key]
                    || (key === 'assetId' || key === 'url' ? value.kind === 'media' ? 'video'
                        : value.kind === 'audio' ? 'audio' : value.kind === 'image' || owner.kind === 'SCHEDULE EVENT' ? 'image' : null : null);
                let assetId = null;
                if (['assetId', 'audioAssetId', 'stillAssetId', 'motionAssetId', 'logoAssetId'].includes(key) && child != null) {
                    if (typeof child !== 'string' || !ID_PATTERN.test(child)) unavailable.push(path);
                    else assetId = child;
                }
                else if (typeof child === 'string' && ['url', 'audioUrl', 'stillUrl', 'motionUrl', 'logo', 'logoUrl', 'asset'].includes(key)) {
                    // Resolve a complete managed URL through repository metadata, never its basename.
                    let pathname;
                    try { pathname = decodeURIComponent(new URL(child, 'http://reference.invalid').pathname); } catch { pathname = ''; }
                    if (pathname.startsWith('/media-library/files/')) {
                        const asset = byUrl.get(pathname);
                        if (!asset) unavailable.push(path);
                        else assetId = asset.id;
                    }
                }
                if (assetId) references.push({ assetId, classification, kind: classification === 'PERSISTED'
                    ? ({stillAssetId:'AUDIO STILL',motionAssetId:'AUDIO MOTION',logoAssetId:'CHANNEL LOGO'})[key] || owner.kind : owner.kind,
                    ownerId: owner.ownerId || kind, ownerLabel: owner.ownerLabel || owner.kind,
                    location: path, expectedKind: expected });
                if (child && typeof child === 'object') visit(child, owner, path);
            }
        };
        visit(data, { kind, ownerId: kind, ownerLabel: classification === 'RUNTIME' ? data?.scene?.name || kind : kind });
        // A scene itself is a useful additional operator-facing owner.
        for (const scene of data?.scenes || []) {
            const sourceId = scene.renderer?.sourceId;
            for (const ref of references.filter(ref => ref.ownerId === sourceId)) {
                references.push({ ...ref, kind: 'SCENE', ownerId: scene.id,
                    ownerLabel: scene.name || scene.id, location: 'renderer.sourceId' });
            }
        }
        return { references, unavailable };
    }

    validate(data, options) {
        if (this.repository.deleteRecoveryRequired) throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
        const extracted = this.extract(data, options);
        if (extracted.unavailable.length) throw referenceError('ASSET_UNAVAILABLE');
        for (const ref of extracted.references) {
            const asset = this.repository.get(ref.assetId);
            if (!asset) throw referenceError('ASSET_UNAVAILABLE');
            if (ref.expectedKind && ref.expectedKind !== asset.kind) throw referenceError('ASSET_TYPE_MISMATCH');
        }
        return extracted.references;
    }

    async collect() {
        const references = [], unavailable = [];
        let inventories;
        try { inventories = await this.inventories(); } catch { inventories = null; }
        if (!Array.isArray(inventories) || !inventories.length) unavailable.push('Inventario server');
        for (const inventory of inventories || []) {
            if (inventory.complete !== true) unavailable.push(inventory.name);
            if(inventory.name==='PROGRAM'&&(!inventory.data||!Object.hasOwn(inventory.data,'source')))unavailable.push('PROGRAM_IDENTITY_UNCONFIRMED');
            if(inventory.name==='PROGRAM'&&inventory.data?.source){
                const source=inventory.data.source;
                const required=source.kind==='audio'?'audioUrl':['media','image','hls'].includes(source.kind)?'url':source.kind==='break'?'logoUrl':null;
                if(!required||typeof source[required]!=='string'||!source[required])unavailable.push('PROGRAM_IDENTITY_UNCONFIRMED');
            }
            const scan = this.extract(inventory.data, { kind: inventory.name,
                classification: inventory.classification || 'PERSISTED' });
            if (scan.unavailable.length) unavailable.push(`${inventory.name}: riferimenti non risolti`);
            references.push(...scan.references);
        }
        if (this.preview) {
            const snapshot = this.preview.snapshot();
            if (!snapshot.complete) unavailable.push('Preview ownership');
            references.push(...snapshot.references);
        }
        if(this.completeness){try{const state=await this.completeness();if(state.state!=='COMPLETE')unavailable.push(...state.reasons);}catch{unavailable.push('CLIENT_REGISTRY_UNAVAILABLE');}}
        if (this.repository.deleteRecoveryRequired) unavailable.push('Recupero Media Library');
        const complete = unavailable.length === 0;
        const reasons=[...new Set(unavailable)];
        const fingerprint=JSON.stringify(reasons);
        if(fingerprint!==this.completenessFingerprint){this.completenessFingerprint=fingerprint;this.diagnostics?.record(complete?'ASSET_INVENTORY_COMPLETE':'ASSET_INVENTORY_INCOMPLETE',{count:reasons.length,complete});}
        return {complete,references,unavailable:reasons,state:complete?'COMPLETE':'INCOMPLETE'};
    }
    async globalCompleteness(){const value=await this.collect();return {state:value.state,reasons:value.unavailable};}
    async inspect(asset) {
        const collected=await this.collect();
        const {complete,unavailable}=collected;
        const references=collected.references.filter(ref=>ref.assetId===asset.id);
        const status = !complete ? 'UNKNOWN' : references.length ? 'USED' : 'UNUSED';
        this.diagnostics?.record('DELETE_ELIGIBILITY',{count:references.length,complete});
        return { assetId: asset.id, complete, eligible: status === 'UNUSED', status,
            inventoryCompleteness:{state:collected.state,reasons:unavailable},
            referenceCount: references.length,
            references: references.slice(0, 100).map(({ expectedKind, ...ref }) => ({ ...ref,
                type: ref.kind, name: ref.ownerLabel })), unavailable: [...new Set(unavailable)] };
    }
}
