import {createHash} from 'node:crypto';

// Called after route classification and operator authorization. Identity lookup
// never registers a durable client; POST/PUT reference-clients owns that lifecycle.
export async function identifyReferenceRequest(request,session,registry){
    await registry.ready;
    const principal=createHash('sha256').update(session.id||'development-bypass').digest('hex');
    request.operatorReferencePrincipal=principal;
    request.referenceClient=null;
    if(request.url.startsWith('/api/media-library/reference-clients'))return;
    const query=new URL(request.url,'http://reference.invalid').searchParams;
    const client=registry.available?registry.identify(request.headers['x-livezone-reference-client']||query.get('referenceClient'),
        Number(request.headers['x-livezone-reference-generation']||query.get('referenceGeneration')),principal):null;
    request.referenceClient=client?.supported&&client.active?client:null;
    request.referenceClientStatus=!registry.available?'REGISTRY_UNAVAILABLE':request.referenceClient?'CURRENT_CAPABLE':
        client?'CLIENT_CAPABILITY_REQUIRED':'REGISTRATION_REQUIRED';
    const cleanup=client&&!client.active&&request.method==='DELETE'&&request.url.startsWith('/api/media-library/preview-ownership/');
    if(!client||!client.active&&!cleanup)registry.observeUnregistered(principal);
}
