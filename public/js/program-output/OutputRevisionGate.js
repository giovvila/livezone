// Server composite ordering is independent from the Control publisher sequence.
export default class OutputRevisionGate {
    constructor(){this.session=null;this.revision=0;this.retired=new Set();}
    accept(snapshot){
        const output=snapshot?.output;
        if(!output)return false;
        if(this.retired.has(output.sessionId))return false;
        if(this.session!==output.sessionId){if(this.session)this.retired.add(this.session);this.session=output.sessionId;this.revision=0;}
        if(output.revision<=this.revision)return false;
        this.revision=output.revision;return true;
    }
}
