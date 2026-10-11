import {verifyPermanentCapability} from './PermanentCapabilityContract.js';
import {approvedPermanentProofHash} from './PermanentCapabilityApproval.js';
// Approval is outside the bundle and requires supervised probe/deployment review.
export function verifyLocalSystemCapabilityProof(directory,{serviceIdentity,volume}={}){
    return verifyPermanentCapability(directory,{serviceIdentity,volume,approvalHash:approvedPermanentProofHash});
}
